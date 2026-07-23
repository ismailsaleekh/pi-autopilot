import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { parseAutopilotRosterContract } from '../../src/core/roster/contracts.ts';
import {
  OPENCODE_GO_API,
  OPENCODE_GO_AUTH_CLASS,
  OPENCODE_GO_AUTH_MATERIAL_SHAPE,
  OPENCODE_GO_BILLING_ROUTE_CLASS,
  OPENCODE_GO_MODEL_LABEL_POLICY,
  OPENCODE_GO_PENDING_LIVE_POST_W3_WITNESSES,
  OPENCODE_GO_PROVIDER_ID,
  OPENCODE_GO_REQUIRED_EVIDENCE_REFS,
  OPENCODE_GO_ROLE_TEMPLATES,
  buildOpenCodeGoOfflineQualificationReport,
  buildOpenCodeGoQualificationManifestCandidate,
  evaluateOpenCodeGoQualification,
  makeOpenCodeGoSyntheticQualificationInput,
  type OpenCodeGoQualificationInput,
  type OpenCodeGoQualificationIssueCode,
} from '../../src/core/roster/providers/opencode-go.ts';

interface ProviderFixture {
  readonly qualification_input: OpenCodeGoQualificationInput;
  readonly evaluation: unknown;
  readonly manifest_candidate: unknown;
  readonly negative_cases: readonly {
    readonly case_id: string;
    readonly role?: string;
    readonly expected_issue_codes: readonly OpenCodeGoQualificationIssueCode[];
  }[];
}

void describe('D69 W4 OpenCode Go provider pack offline model', () => {
  void it('freezes the exact OpenCode Go plan-token route and role templates without ranking/provider inference', () => {
    assert.equal(OPENCODE_GO_PROVIDER_ID, 'opencode-go');
    assert.equal(OPENCODE_GO_API, 'openai-completions');
    assert.equal(OPENCODE_GO_AUTH_CLASS, 'api-key-plan-token');
    assert.equal(OPENCODE_GO_AUTH_MATERIAL_SHAPE, 'api-key-shaped-plan-token');
    assert.equal(OPENCODE_GO_BILLING_ROUTE_CLASS, 'plan-api-token');
    assert.deepEqual(OPENCODE_GO_MODEL_LABEL_POLICY, {
      labels_are_display_only: true,
      labels_do_not_imply_ranking: true,
      labels_do_not_imply_provider: true,
      provider_authority: 'opencode-go',
      route_policy_authority: 'opencode-go-plan-v1',
      forbidden_inference: 'model labels are never used to derive provider, route, entitlement, billing, ranking, or fallback authority',
    });

    assert.deepEqual(
      OPENCODE_GO_ROLE_TEMPLATES.map((template) => ({
        role: template.role,
        model_id: template.model_id,
        api: template.api,
        thinking: template.thinking,
        context_window: template.context_window,
        max_output_tokens: template.max_output_tokens,
        tool_capability: template.tool_capability,
      })),
      [
        { role: 'parent', model_id: 'kimi-k3', api: 'openai-completions', thinking: 'xhigh', context_window: 256000, max_output_tokens: 32768, tool_capability: 'tool-use-supported' },
        { role: 'strategy', model_id: 'kimi-k3', api: 'openai-completions', thinking: 'xhigh', context_window: 256000, max_output_tokens: 32768, tool_capability: 'tool-use-supported' },
        { role: 'implement', model_id: 'kimi-k2.7-code', api: 'openai-completions', thinking: 'high', context_window: 256000, max_output_tokens: 32768, tool_capability: 'tool-use-supported' },
        { role: 'validate', model_id: 'kimi-k3', api: 'openai-completions', thinking: 'xhigh', context_window: 256000, max_output_tokens: 32768, tool_capability: 'tool-use-supported' },
        { role: 'fix', model_id: 'kimi-k2.7-code', api: 'openai-completions', thinking: 'high', context_window: 256000, max_output_tokens: 32768, tool_capability: 'tool-use-supported' },
        { role: 'adjudicate', model_id: 'kimi-k3', api: 'openai-completions', thinking: 'xhigh', context_window: 256000, max_output_tokens: 32768, tool_capability: 'tool-use-supported' },
        { role: 'bughunt', model_id: 'kimi-k3', api: 'openai-completions', thinking: 'xhigh', context_window: 256000, max_output_tokens: 32768, tool_capability: 'tool-use-supported' },
        { role: 'extract', model_id: 'deepseek-v4-flash', api: 'openai-completions', thinking: 'high', context_window: 128000, max_output_tokens: 16384, tool_capability: 'tool-use-supported' },
      ],
    );
  });

  void it('keeps synthetic fixture evidence non-certifying and reports qualification-required pending live post-W3 witnesses', async () => {
    const fixture = await readFixture();
    const input = fixture.qualification_input;
    const evaluation = evaluateOpenCodeGoQualification(input);
    const manifestCandidate = buildOpenCodeGoQualificationManifestCandidate(input);
    const artifact = await readArtifact();

    assert.deepEqual(fixture.evaluation, evaluation);
    assert.deepEqual(fixture.manifest_candidate, manifestCandidate);
    assert.deepEqual(artifact, buildOpenCodeGoOfflineQualificationReport(input));
    assert.equal(evaluation.structural_pass, true);
    assert.equal(evaluation.certification_ready, false);
    assert.equal(evaluation.qualification_state, 'qualification-required');
    assert.equal(evaluation.synthetic_fixture_non_certifying, true);
    assert.deepEqual(evaluation.issues, []);
    assert.deepEqual(evaluation.pending_live_post_w3_witnesses, OPENCODE_GO_PENDING_LIVE_POST_W3_WITNESSES);

    const manifest = manifestCandidate.certification_manifest;
    parseAutopilotRosterContract('autopilot.certification_manifest.v1', manifest);
    assert.equal(manifest.qualification_state, 'qualification-required');
    assert.deepEqual(manifest.live_evidence, []);
    assert.equal(manifest.role_results.every((result) => result.state === 'synthetic-pass'), true);
    assert.deepEqual(manifest.required_evidence, OPENCODE_GO_REQUIRED_EVIDENCE_REFS);
    assert.equal(artifact.network_calls, 0);
    assert.equal(artifact.live_provider_certification_asserted, false);
    assert.equal(artifact.synthetic_fixtures_certifying, false);
  });

  void it('would require live non-secret proofs and role-complete observed execution before a W4-ready manifest', () => {
    const sourceOnlyLiveInput: OpenCodeGoQualificationInput = { ...makeOpenCodeGoSyntheticQualificationInput(), evidence_source: 'live-post-w3-witness' };
    assertIncludesAll(issueCodes(evaluateOpenCodeGoQualification(sourceOnlyLiveInput)), ['OPENCODE_GO_LIVE_WITNESS_SOURCE_REQUIRED']);

    const liveInput = makeLivePostW3Input();
    const liveCandidate = buildOpenCodeGoQualificationManifestCandidate(liveInput);
    assert.equal(liveCandidate.certification_ready, true);
    assert.equal(liveCandidate.qualification_state, 'w4-certified-ready');
    assert.equal(liveCandidate.certification_manifest.role_results.every((result) => result.state === 'pass'), true);
    assert.equal(liveCandidate.certification_manifest.live_evidence.length, 10);

    const missingProofs: OpenCodeGoQualificationInput = {
      ...liveInput,
      entitlement_proof: null,
      role_witnesses: liveInput.role_witnesses.filter((witness) => witness.role !== 'extract'),
    };
    const blocked = evaluateOpenCodeGoQualification(missingProofs);
    assert.equal(blocked.certification_ready, false);
    assertIncludesAll(issueCodes(blocked), ['OPENCODE_GO_ENTITLEMENT_PROOF_REQUIRED', 'OPENCODE_GO_ROLE_WITNESS_REQUIRED']);
  });

  void it('rejects route-token-shape, OpenRouter, arbitrary-key, and fallback negatives', async () => {
    const fixture = await readFixture();
    const tokenShapeCase = fixture.negative_cases.find((entry) => entry.case_id === 'route-token-shape-generic-api-key');
    if (tokenShapeCase === undefined) throw new Error('missing route-token-shape case');
    const tokenShapeInput = cloneInput(fixture.qualification_input);
    setField(tokenShapeInput, 'auth_class', 'api-key');
    if (tokenShapeInput.entitlement_proof !== null) setField(tokenShapeInput.entitlement_proof, 'auth_class', 'api-key');
    if (tokenShapeInput.billing_route_proof !== null) setField(tokenShapeInput.billing_route_proof, 'auth_class', 'api-key');
    assertIncludesAll(issueCodes(evaluateOpenCodeGoQualification(tokenShapeInput)), tokenShapeCase.expected_issue_codes);

    const openRouterInput = cloneInput(fixture.qualification_input);
    setField(openRouterInput, 'gateway_id', 'openrouter');
    setField(openRouterInput, 'no_fallback', false);
    setField(openRouterInput, 'auth_source', 'environment');
    assertIncludesAll(issueCodes(evaluateOpenCodeGoQualification(openRouterInput)), [
      'OPENCODE_GO_AUTH_SOURCE_FORBIDDEN',
      'OPENCODE_GO_FORBIDDEN_GATEWAY',
      'OPENCODE_GO_NO_FALLBACK_REQUIRED',
    ]);

    const arbitraryGatewayInput = cloneInput(fixture.qualification_input);
    setField(arbitraryGatewayInput, 'gateway_id', 'arbitrary-api-key');
    assertIncludesAll(issueCodes(evaluateOpenCodeGoQualification(arbitraryGatewayInput)), ['OPENCODE_GO_FORBIDDEN_GATEWAY']);
  });

  void it('rejects wrong API/model/thinking/context/tool and mixed-route role evidence without clamping or fallback', async () => {
    const fixture = await readFixture();
    for (const negativeCase of fixture.negative_cases.filter((entry) => entry.case_id !== 'route-token-shape-generic-api-key')) {
      const input = cloneInput(fixture.qualification_input);
      switch (negativeCase.case_id) {
        case 'wrong-api': {
          const witness = mustRole(input, 'parent');
          setField(witness.request_profile, 'api', 'anthropic-messages');
          setField(witness.observed_profile, 'api', 'anthropic-messages');
          break;
        }
        case 'wrong-model': {
          const witness = mustRole(input, 'implement');
          setField(witness.request_profile, 'model_id', 'kimi-k3');
          setField(witness.request_profile, 'model', 'opencode-go/kimi-k3');
          setField(witness.observed_profile, 'executed_model_id', 'kimi-k3');
          break;
        }
        case 'wrong-thinking': {
          const witness = mustRole(input, 'parent');
          setField(witness.request_profile, 'thinking', 'high');
          setField(witness.observed_profile, 'thinking', 'high');
          break;
        }
        case 'wrong-context': {
          const witness = mustRole(input, 'extract');
          setField(witness.request_profile, 'context_window', 256000);
          break;
        }
        case 'wrong-tool': {
          const witness = mustRole(input, 'fix');
          setField(witness.request_profile, 'tool_capability', 'tool-use-unsupported');
          break;
        }
        case 'mixed-route': {
          const witness = mustRole(input, 'bughunt');
          setField(witness, 'provider_id', 'kimi-coding');
          setField(witness, 'route_policy_id', 'kimi-coding-plan-v1');
          setField(witness.request_profile, 'provider_id', 'kimi-coding');
          setField(witness.observed_profile, 'provider_id', 'kimi-coding');
          break;
        }
        default:
          throw new Error(`unhandled negative case ${negativeCase.case_id}`);
      }
      assertIncludesAll(issueCodes(evaluateOpenCodeGoQualification(input)), negativeCase.expected_issue_codes);
    }
  });

  void it('contains no network authority and no secret-bearing fixture or artifact data', async () => {
    const source = await readText('../../src/core/roster/providers/opencode-go.ts');
    assert.equal(/\bfetch\s*\(/u.test(source), false);
    assert.equal(/from ['"]node:https?['"]/u.test(source), false);
    assert.equal(/from ['"]undici['"]/u.test(source), false);

    const fixture = await readFixture();
    const artifact = await readArtifact();
    assertSecretFree(fixture, 'fixture');
    assertSecretFree(artifact, 'artifact');
    assertNoHttpEvidenceUris(fixture, 'fixture');
    assertNoHttpEvidenceUris(artifact, 'artifact');
  });
});

async function readFixture(): Promise<ProviderFixture> {
  return JSON.parse(await readText('../fixtures/roster/providers/opencode-go.v1.json')) as ProviderFixture;
}

async function readArtifact(): Promise<ReturnType<typeof buildOpenCodeGoOfflineQualificationReport>> {
  return JSON.parse(await readText('../../artifacts/qualification/phase37/opencode-go.json')) as ReturnType<typeof buildOpenCodeGoOfflineQualificationReport>;
}

async function readText(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

function cloneInput(input: OpenCodeGoQualificationInput): OpenCodeGoQualificationInput {
  return structuredClone(input) as OpenCodeGoQualificationInput;
}

function mustRole(input: OpenCodeGoQualificationInput, role: string): OpenCodeGoQualificationInput['role_witnesses'][number] {
  const witness = input.role_witnesses.find((candidate) => candidate.role === role);
  if (witness === undefined) throw new Error(`missing role witness ${role}`);
  return witness;
}

function makeLivePostW3Input(): OpenCodeGoQualificationInput {
  const input = cloneInput(makeOpenCodeGoSyntheticQualificationInput());
  setField(input, 'evidence_source', 'live-post-w3-witness');
  if (input.entitlement_proof !== null) {
    setField(input.entitlement_proof, 'evidence_ref', {
      ...input.entitlement_proof.evidence_ref,
      evidence_id: 'live-opencode-go-plan-entitlement-proof',
      uri: 'file://phase37/opencode-go/live/entitlement-route-proof.json',
    });
  }
  if (input.billing_route_proof !== null) {
    setField(input.billing_route_proof, 'evidence_ref', {
      ...input.billing_route_proof.evidence_ref,
      evidence_id: 'live-opencode-go-billing-route-proof',
      uri: 'file://phase37/opencode-go/live/billing-route-proof.json',
    });
  }
  for (const witness of input.role_witnesses) {
    setField(witness, 'evidence_refs', witness.evidence_refs.map((ref) => ({
      ...ref,
      evidence_id: ref.evidence_id.replace('fixture-', 'live-'),
      uri: ref.uri.replace('fixture://phase37/opencode-go/execution/', 'file://phase37/opencode-go/live/execution/'),
    })));
  }
  return input;
}

function setField(target: object, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

function issueCodes(evaluation: ReturnType<typeof evaluateOpenCodeGoQualification>): readonly OpenCodeGoQualificationIssueCode[] {
  return evaluation.issues.map((issue) => issue.code);
}

function assertIncludesAll(actual: readonly OpenCodeGoQualificationIssueCode[], expected: readonly OpenCodeGoQualificationIssueCode[]): void {
  for (const code of expected) {
    assert.equal(actual.includes(code), true, `expected ${code} in ${JSON.stringify(actual)}`);
  }
}

function assertSecretFree(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretFree(entry, `${path}[${String(index)}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/secret|password|credential/i.test(key) && key !== 'secret_free' && key !== 'secret_fields_present') {
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
