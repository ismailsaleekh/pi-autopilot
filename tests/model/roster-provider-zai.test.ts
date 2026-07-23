import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseAutopilotRosterContract } from '../../src/core/roster/contracts.ts';
import {
  ROSTER_ROLE_ORDER,
  assertNoSecretFields,
  canonicalSha256,
} from '../../src/core/roster/route-policies.ts';
import {
  buildZaiQualificationManifestCandidate,
  evaluateZaiQualificationEvidence,
  ZAI_ALL_ROLE_TEMPLATES,
  ZAI_API,
  ZAI_AUTH_CLASS,
  ZAI_BASE_URL,
  ZAI_BILLING_CLASS,
  ZAI_BILLING_ROUTE_CLASS,
  ZAI_CACHE_POLICY,
  ZAI_CHAT_COMPLETIONS_ENDPOINT,
  ZAI_MODEL,
  ZAI_MODEL_CONTEXT_WINDOW,
  ZAI_MODEL_ID,
  ZAI_MODEL_MAX_TOKENS,
  ZAI_OPENAI_COMPLETIONS_COMPATIBILITY,
  ZAI_PROFILE_TEMPLATE,
  ZAI_PROVIDER_ID,
  ZAI_PROVIDER_PACK,
  ZAI_PROVIDER_RECIPE,
  ZAI_RECIPE_ID,
  ZAI_RECIPE_REVISION,
  ZAI_REQUIRED_EVIDENCE_REFS,
  ZAI_ROUTE_POLICY,
  ZAI_ROUTE_POLICY_ID,
  ZAI_ROUTE_POLICY_REVISION,
  ZAI_SEED_CANDIDATE,
  ZAI_SEED_ROSTER,
  ZAI_SYSTEM_PROMPT_PROFILE,
  ZAI_TEMPLATE_CONTEXT_WINDOW,
  ZAI_TEMPLATE_MAX_OUTPUT_TOKENS,
  ZAI_THINKING,
  ZAI_TOKEN_AUTHORITY,
  type ZaiQualificationEvidence,
  type ZaiQualificationIssueCode,
  type ZaiRoleQualificationEvidence,
} from '../../src/core/roster/providers/zai.ts';

interface ZaiFixtureNegativeCase {
  readonly case_id: string;
  readonly expected_issue: ZaiQualificationIssueCode;
}

interface ZaiFixture {
  readonly schema_version: 'autopilot.zai_provider_fixture.v1';
  readonly fixture_id: string;
  readonly non_certifying: boolean;
  readonly network_calls_permitted: boolean;
  readonly expected_qualification_state: 'qualification-required';
  readonly synthetic_evidence: ZaiQualificationEvidence;
  readonly negative_cases: readonly ZaiFixtureNegativeCase[];
}

type MutableProcessIdentity = {
  session_id: string;
  process_id: string;
  run_id: string;
  lease_id: string;
  tool_call_id: string;
  attempt_authority_id: string;
  authenticated: boolean;
};

type MutableRoleEvidence = Omit<{
  -readonly [Key in keyof ZaiRoleQualificationEvidence]: ZaiRoleQualificationEvidence[Key];
}, 'child'> & { child: MutableProcessIdentity };

type MutableQualificationEvidence = Omit<{
  -readonly [Key in keyof ZaiQualificationEvidence]: ZaiQualificationEvidence[Key];
}, 'roles'> & { roles: MutableRoleEvidence[] };

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function readFixture(): ZaiFixture {
  return readJson('tests/fixtures/roster/providers/zai.v1.json') as ZaiFixture;
}

function cloneEvidence(): MutableQualificationEvidence {
  return structuredClone(readFixture().synthetic_evidence) as MutableQualificationEvidence;
}

function roleEvidence(evidence: MutableQualificationEvidence, role: string): MutableRoleEvidence {
  const found = evidence.roles.find((entry) => entry.role === role);
  if (found === undefined) {
    throw new Error(`missing fixture role ${role}`);
  }
  return found;
}

function issueCodes(evidence: ZaiQualificationEvidence): readonly ZaiQualificationIssueCode[] {
  return evaluateZaiQualificationEvidence(evidence).issues.map((issue) => issue.code);
}

function assertNoCredentialMaterial(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialMaterial(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/secret|credential|api[_-]?key|password/i.test(key) && key !== 'secret_free') {
      throw new Error(`secret-bearing field ${path}.${key} is forbidden`);
    }
    assertNoCredentialMaterial(nested, `${path}.${key}`);
  }
}

function evidenceForNegativeCase(caseId: string): ZaiQualificationEvidence {
  const evidence = cloneEvidence();
  const implement = roleEvidence(evidence, 'implement');
  switch (caseId) {
    case 'same-process-self-certification':
      implement.child = { ...evidence.evaluator };
      break;
    case 'missing-independent-child':
      implement.child = { ...evidence.parent };
      break;
    case 'duplicate-cross-role-child-identity':
      implement.child = { ...roleEvidence(evidence, 'strategy').child };
      break;
    case 'duplicate-cross-role-session':
      implement.child.session_id = roleEvidence(evidence, 'strategy').child.session_id;
      break;
    case 'duplicate-cross-role-lease':
      implement.child.lease_id = roleEvidence(evidence, 'strategy').child.lease_id;
      break;
    case 'duplicate-cross-role-tool-call':
      implement.child.tool_call_id = roleEvidence(evidence, 'strategy').child.tool_call_id;
      break;
    case 'duplicate-cross-role-attempt-authority':
      implement.child.attempt_authority_id = roleEvidence(evidence, 'strategy').child.attempt_authority_id;
      break;
    case 'duplicate-evaluator-session':
      implement.child.session_id = evidence.evaluator.session_id;
      break;
    case 'duplicate-parent-lease':
      implement.child.lease_id = evidence.parent.lease_id;
      break;
    case 'missing-child-authentication':
      delete (implement.child as Partial<MutableProcessIdentity>).authenticated;
      break;
    case 'wrong-endpoint':
      implement.base_url = 'https://openrouter.ai/api/v1';
      implement.chat_completions_endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      break;
    case 'wrong-model':
      implement.executed_model_id = 'glm-5.2-fast';
      implement.fallback_model_id = ZAI_MODEL_ID;
      break;
    case 'wrong-thinking':
      implement.thinking = 'medium';
      implement.reasoning_effort = 'medium';
      break;
    case 'wrong-context':
      implement.request_context_window = ZAI_TEMPLATE_CONTEXT_WINDOW - 1;
      break;
    case 'wrong-cache':
      implement.cache_policy = 'long';
      implement.prompt_cache_key = 'generic-openai-cache-fallback';
      break;
    case 'wrong-auth':
      implement.auth_class = 'api-key';
      implement.auth_source = 'environment';
      implement.plan_authority = 'generic-api-key';
      break;
    case 'forbidden-openrouter-route':
      implement.gateway_provider_id = 'openrouter';
      break;
    case 'missing-role':
      evidence.roles = evidence.roles.filter((entry) => entry.role !== 'validate');
      break;
    default:
      throw new Error(`unknown ZAI negative case ${caseId}`);
  }
  return evidence;
}

void describe('D69 W4 ZAI/GLM provider pack', () => {
  void it('freezes the exact ZAI coding-plan route and glm-5.2/high all-role template', () => {
    assert.equal(ZAI_PROVIDER_ID, 'zai');
    assert.equal(ZAI_RECIPE_ID, 'zai-coding-plan');
    assert.equal(ZAI_ROUTE_POLICY_ID, 'zai-coding-plan-v1');
    assert.equal(ZAI_MODEL_ID, 'glm-5.2');
    assert.equal(ZAI_MODEL, 'zai/glm-5.2');
    assert.equal(ZAI_API, 'openai-completions');
    assert.equal(ZAI_THINKING, 'high');
    assert.equal(ZAI_BASE_URL, 'https://api.z.ai/api/coding/paas/v4');
    assert.equal(ZAI_CHAT_COMPLETIONS_ENDPOINT, 'https://api.z.ai/api/coding/paas/v4/chat/completions');

    assert.equal(ZAI_ROUTE_POLICY?.provider_id, 'zai');
    assert.equal(ZAI_ROUTE_POLICY?.billing_class, 'plan-token');
    assert.equal(ZAI_ROUTE_POLICY?.billing_route_class, 'plan-api-token');
    assert.deepEqual(ZAI_ROUTE_POLICY?.allowed_auth_classes, ['api-key-plan-token']);
    assert.equal(ZAI_ROUTE_POLICY?.allowed_auth_classes.includes('api-key'), false);
    assert.deepEqual(ZAI_ROUTE_POLICY?.forbidden_gateways, ['arbitrary-api-key', 'metered-frontier', 'openrouter']);
    assert.equal(ZAI_PROVIDER_RECIPE.provider_family, 'zai');
    assert.equal(ZAI_PROVIDER_RECIPE.recipe_id, ZAI_RECIPE_ID);
    assert.equal(ZAI_PROVIDER_RECIPE.recipe_revision, ZAI_RECIPE_REVISION);
    assert.equal(ZAI_PROVIDER_RECIPE.qualification_state, 'unqualified-non-certifying-seed');
    assert.equal(ZAI_PROVIDER_RECIPE.non_certifying_seed, true);

    assert.deepEqual(ZAI_PROFILE_TEMPLATE.role_templates.map((template) => template.role), ROSTER_ROLE_ORDER);
    assert.deepEqual(ZAI_ALL_ROLE_TEMPLATES.map((template) => template.role), ROSTER_ROLE_ORDER);
    for (const template of ZAI_ALL_ROLE_TEMPLATES) {
      assert.equal(template.model_id, ZAI_MODEL_ID);
      assert.equal(template.api, ZAI_API);
      assert.equal(template.thinking, ZAI_THINKING);
      assert.equal(template.service_tier, null);
      assert.equal(template.cache_policy, ZAI_CACHE_POLICY);
      assert.equal(template.system_prompt_profile, ZAI_SYSTEM_PROMPT_PROFILE);
      assert.equal(template.context_window, ZAI_TEMPLATE_CONTEXT_WINDOW);
      assert.equal(template.max_output_tokens, ZAI_TEMPLATE_MAX_OUTPUT_TOKENS);
      assert.deepEqual(template.input_modalities, ['text']);
      assert.deepEqual(template.output_modalities, ['text']);
      assert.equal(template.reasoning_capability, 'reasoning-supported');
      assert.equal(template.tool_capability, 'tool-use-supported');
    }

    assert.equal(ZAI_SEED_CANDIDATE.candidate_id, 'zai-precision-v1');
    assert.equal(ZAI_SEED_CANDIDATE.launch_readiness, 'not-ready-until-w4');
    assert.equal(ZAI_SEED_CANDIDATE.qualification_state, 'unqualified-non-certifying-seed');
    assert.equal(ZAI_SEED_ROSTER.roster_id, ZAI_SEED_CANDIDATE.roster_id);
    assert.equal(ZAI_PROVIDER_PACK.qualification_state, 'qualification-required');
    assert.equal(ZAI_PROVIDER_PACK.synthetic_fixtures_certify_provider, false);
    assert.equal(ZAI_PROVIDER_PACK.network_calls_permitted, false);
  });

  void it('records exact OpenAI-completions request/context/cache/tool compatibility without generic API-key authority', () => {
    assert.deepEqual(ZAI_OPENAI_COMPLETIONS_COMPATIBILITY, {
      provider_id: 'zai',
      api: 'openai-completions',
      base_url: 'https://api.z.ai/api/coding/paas/v4',
      chat_completions_endpoint: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
      request: {
        model_id: 'glm-5.2',
        stream: true,
        thinking_format: 'zai',
        thinking_parameter: { type: 'enabled', clear_thinking: false },
        reasoning_effort_parameter: 'high',
        supports_reasoning_effort: true,
        supports_developer_role: false,
        supports_store: false,
      },
      context: {
        template_context_window: 256000,
        template_max_output_tokens: 32768,
        model_context_window: 1000000,
        model_max_tokens: 131072,
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
      cache: {
        cache_policy: 'provider-default',
        prompt_cache_key: null,
        prompt_cache_retention: null,
        store: null,
      },
      tools: {
        tool_capability: 'tool-use-supported',
        zai_tool_stream: true,
      },
    });
    assert.equal(ZAI_AUTH_CLASS, 'api-key-plan-token');
    assert.equal(ZAI_TOKEN_AUTHORITY, 'zai-coding-plan-token');
    assert.equal(ZAI_BILLING_CLASS, 'plan-token');
    assert.equal(ZAI_BILLING_ROUTE_CLASS, 'plan-api-token');
    assert.equal(ZAI_MODEL_CONTEXT_WINDOW, 1000000);
    assert.equal(ZAI_MODEL_MAX_TOKENS, 131072);
  });

  void it('keeps offline fixture and qualification artifact non-certifying and qualification-required', () => {
    const fixture = readFixture();
    assert.equal(fixture.schema_version, 'autopilot.zai_provider_fixture.v1');
    assert.equal(fixture.non_certifying, true);
    assert.equal(fixture.network_calls_permitted, false);
    assert.equal(fixture.expected_qualification_state, 'qualification-required');
    assert.deepEqual(fixture.synthetic_evidence.roles.map((entry) => entry.role), ROSTER_ROLE_ORDER);
    assertNoCredentialMaterial(fixture);

    const evaluation = evaluateZaiQualificationEvidence(fixture.synthetic_evidence);
    assert.equal(evaluation.ready, false);
    assert.equal(evaluation.qualification_state, 'qualification-required');
    assert.equal(evaluation.network_calls, 0);
    assert.deepEqual(evaluation.issues.map((issue) => issue.code), [
      'ZAI_SYNTHETIC_NON_CERTIFYING',
      'ZAI_LIVE_ENTITLEMENT_REQUIRED',
      'ZAI_LIVE_BILLING_REQUIRED',
    ]);

    const artifact = readJson('artifacts/qualification/phase37/zai.json');
    assertNoSecretFields(artifact);
    const parsed = parseAutopilotRosterContract('autopilot.certification_manifest.v1', artifact);
    const rebuilt = buildZaiQualificationManifestCandidate(fixture.synthetic_evidence, {
      issued_at: '2026-07-22T12:00:00.000Z',
      expires_at: '2026-07-23T12:00:00.000Z',
    });
    assert.deepEqual(parsed, rebuilt);
    assert.equal(parsed.manifest_id, 'zai-coding-plan-w4-qualification');
    assert.equal(parsed.subject_kind, 'provider_recipe');
    assert.equal(parsed.subject_id, 'zai-coding-plan');
    assert.equal(parsed.subject_sha256, ZAI_PROVIDER_RECIPE.recipe_sha256);
    assert.equal(parsed.qualification_state, 'qualification-required');
    assert.equal(parsed.role_results.length, ROSTER_ROLE_ORDER.length);
    assert.equal(parsed.role_results.every((result) => result.state === 'fail'), true);
    assert.deepEqual(parsed.live_evidence, []);
    assert.equal(parsed.required_evidence.length, ZAI_REQUIRED_EVIDENCE_REFS.length);
    const { manifest_sha256: _manifestSha256, ...manifestPreimage } = parsed;
    assert.equal(parsed.manifest_sha256, canonicalSha256(manifestPreimage));
  });

  void it('strict evaluator requires live entitlement, billing, and complete role evidence before manifest readiness', () => {
    const evidence = cloneEvidence();
    evidence.evidence_kind = 'live-observed';
    evidence.live_entitlement_observed = false;
    evidence.live_billing_observed = false;

    const evaluation = evaluateZaiQualificationEvidence(evidence);
    assert.equal(evaluation.ready, false);
    assert.equal(evaluation.qualification_state, 'qualification-required');
    assert.deepEqual(evaluation.issues.map((issue) => issue.code), [
      'ZAI_LIVE_ENTITLEMENT_REQUIRED',
      'ZAI_LIVE_BILLING_REQUIRED',
    ]);

    const missingExecutionProof = cloneEvidence();
    missingExecutionProof.evidence_kind = 'live-observed';
    missingExecutionProof.live_entitlement_observed = true;
    missingExecutionProof.live_billing_observed = true;
    roleEvidence(missingExecutionProof, 'bughunt').execution_evidence_sha256 = null;
    assert.equal(
      evaluateZaiQualificationEvidence(missingExecutionProof).issues.some(
        (issue) => issue.code === 'ZAI_ROLE_SPECIFIC_EVIDENCE_REQUIRED' && issue.role === 'bughunt',
      ),
      true,
    );

    const duplicateChildLiveEvidence = cloneEvidence();
    duplicateChildLiveEvidence.evidence_kind = 'live-observed';
    duplicateChildLiveEvidence.live_entitlement_observed = true;
    duplicateChildLiveEvidence.live_billing_observed = true;
    roleEvidence(duplicateChildLiveEvidence, 'implement').child = { ...roleEvidence(duplicateChildLiveEvidence, 'strategy').child };
    const duplicateChildEvaluation = evaluateZaiQualificationEvidence(duplicateChildLiveEvidence);
    assert.equal(duplicateChildEvaluation.ready, false);
    assert.equal(duplicateChildEvaluation.qualification_state, 'qualification-required');
    assert.equal(
      duplicateChildEvaluation.issues.some(
        (issue) => issue.code === 'ZAI_INDEPENDENT_CHILD_REQUIRED' && issue.role === 'implement',
      ),
      true,
    );

    const manifest = buildZaiQualificationManifestCandidate(evidence);
    assert.equal(manifest.qualification_state, 'qualification-required');
    assert.equal(manifest.role_results.every((result) => result.state === 'fail'), true);
    assert.deepEqual(manifest.live_evidence, []);
  });

  void it('rejects self-certification, missing child independence, route drift, fallback, and role gaps', () => {
    const fixture = readFixture();
    assert.deepEqual(fixture.negative_cases.map((entry) => entry.case_id), [
      'same-process-self-certification',
      'missing-independent-child',
      'duplicate-cross-role-child-identity',
      'duplicate-cross-role-session',
      'duplicate-cross-role-lease',
      'duplicate-cross-role-tool-call',
      'duplicate-cross-role-attempt-authority',
      'duplicate-evaluator-session',
      'duplicate-parent-lease',
      'missing-child-authentication',
      'wrong-endpoint',
      'wrong-model',
      'wrong-thinking',
      'wrong-context',
      'wrong-cache',
      'wrong-auth',
      'forbidden-openrouter-route',
      'missing-role',
    ]);

    for (const negativeCase of fixture.negative_cases) {
      const codes = issueCodes(evidenceForNegativeCase(negativeCase.case_id));
      assert.equal(
        codes.includes(negativeCase.expected_issue),
        true,
        `${negativeCase.case_id} should report ${negativeCase.expected_issue}; got ${codes.join(', ')}`,
      );
    }
  });

  void it('does not add network authority to the offline provider pack', () => {
    const source = readFileSync('src/core/roster/providers/zai.ts', 'utf8');
    assert.equal(/\bfetch\s*\(/u.test(source), false);
    assert.equal(/\bhttps?\.request\s*\(/u.test(source), false);
    assert.equal(/\bXMLHttpRequest\b/u.test(source), false);
    assert.equal(/\bopenrouter\b.*allowed/u.test(source), false);
    assert.equal(evaluateZaiQualificationEvidence(readFixture().synthetic_evidence).network_calls, 0);
  });
});
