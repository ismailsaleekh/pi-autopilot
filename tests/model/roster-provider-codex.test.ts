import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CODEX_API,
  CODEX_AUTH_CLASS,
  CODEX_BILLING_CLASS,
  CODEX_BILLING_ROUTE_CLASS,
  CODEX_BLOCKED_REASON,
  CODEX_CACHE_POLICY,
  CODEX_CRITICAL_ROLE_QUALITY_INVARIANTS,
  CODEX_PROFILE_TEMPLATES,
  CODEX_PROVIDER_ID,
  CODEX_PROVIDER_PACK_ID,
  CODEX_PROVIDER_RECIPE,
  CODEX_RECIPE_ID,
  CODEX_RECIPE_REVISION,
  CODEX_REQUIRED_PACKAGE_VERSION,
  CODEX_REQUIRED_PI_VERSION,
  CODEX_ROUTE_POLICY_ID,
  CODEX_ROUTE_POLICY_REVISION,
  CODEX_SUBSCRIPTION_ROUTE_POLICY,
  CODEX_SYSTEM_PROMPT_PROFILE,
  buildCodexQualificationManifestCandidate,
  codexRoleRequirementsForProfile,
  type CodexQualificationEvidenceBundle,
} from '../../src/core/roster/providers/codex.ts';
import {
  computeAutopilotRosterContractObjectHash,
  parseAutopilotRosterContract,
  parseAutopilotUnitSpecV2,
  parseAutopilotReceiptV2,
} from '../../src/core/roster/contracts.ts';
import { getProviderRecipe } from '../../src/core/roster/provider-recipes.ts';
import { ROSTER_ROLE_ORDER, type RosterRole } from '../../src/core/roster/route-policies.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..');
const FIXTURE = readJsonObject(resolve(REPO_ROOT, 'tests/fixtures/roster/providers/codex.v1.json'));
const REPORT = readJsonObject(resolve(REPO_ROOT, 'artifacts/qualification/phase37/codex.json'));
const ZERO_DIGEST = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

void describe('D69 W4 offline Codex provider pack', () => {
  void it('encodes only the frozen openai-codex OAuth subscription route and W0 role templates', () => {
    const w0Recipe = getProviderRecipe(CODEX_RECIPE_ID, CODEX_RECIPE_REVISION);
    assert.notEqual(w0Recipe, null);
    assert.deepEqual(CODEX_PROVIDER_RECIPE, w0Recipe);
    assert.deepEqual(CODEX_PROFILE_TEMPLATES, w0Recipe?.profile_templates);

    assert.equal(CODEX_SUBSCRIPTION_ROUTE_POLICY.provider_id, CODEX_PROVIDER_ID);
    assert.equal(CODEX_SUBSCRIPTION_ROUTE_POLICY.route_policy_id, CODEX_ROUTE_POLICY_ID);
    assert.equal(CODEX_SUBSCRIPTION_ROUTE_POLICY.revision, CODEX_ROUTE_POLICY_REVISION);
    assert.deepEqual(CODEX_SUBSCRIPTION_ROUTE_POLICY.allowed_auth_classes, [CODEX_AUTH_CLASS]);
    assert.equal(CODEX_SUBSCRIPTION_ROUTE_POLICY.allowed_auth_classes.includes('api-key'), false);
    assert.deepEqual([...CODEX_SUBSCRIPTION_ROUTE_POLICY.allowed_auth_sources].sort(), ['runtime', 'stored']);
    assert.equal(CODEX_SUBSCRIPTION_ROUTE_POLICY.billing_class, CODEX_BILLING_CLASS);
    assert.equal(CODEX_SUBSCRIPTION_ROUTE_POLICY.billing_route_class, CODEX_BILLING_ROUTE_CLASS);
    assert.deepEqual(CODEX_SUBSCRIPTION_ROUTE_POLICY.allowed_apis, [CODEX_API]);
    assert.deepEqual(CODEX_SUBSCRIPTION_ROUTE_POLICY.allowed_cache_policies, [CODEX_CACHE_POLICY]);
    assert.deepEqual(CODEX_SUBSCRIPTION_ROUTE_POLICY.allowed_system_prompt_profiles, [CODEX_SYSTEM_PROMPT_PROFILE]);
    assert.ok(CODEX_SUBSCRIPTION_ROUTE_POLICY.forbidden_gateways.includes('openrouter'));
    assert.equal(CODEX_SUBSCRIPTION_ROUTE_POLICY.requires_live_billing_proof, true);

    for (const profile of CODEX_PROFILE_TEMPLATES) {
      assert.equal(profile.route_policy_id, CODEX_ROUTE_POLICY_ID);
      assert.equal(profile.route_policy_revision, CODEX_ROUTE_POLICY_REVISION);
      assert.deepEqual(profile.role_templates.map((role) => role.role), ROSTER_ROLE_ORDER);
    }
  });

  void it('materializes exact model/API/thinking/tier/cache/prompt requirements and critical-role invariants', () => {
    const cruise = codexRoleRequirementsForProfile('cruise');
    const precision = codexRoleRequirementsForProfile('precision');
    const afterburner = codexRoleRequirementsForProfile('afterburner');
    assert.deepEqual(cruise.map((role) => role.role), ROSTER_ROLE_ORDER);

    for (const requirement of [...cruise, ...precision, ...afterburner]) {
      assert.equal(requirement.provider_id, CODEX_PROVIDER_ID);
      assert.equal(requirement.api, CODEX_API);
      assert.equal(requirement.route_policy_id, CODEX_ROUTE_POLICY_ID);
      assert.equal(requirement.route_policy_revision, CODEX_ROUTE_POLICY_REVISION);
      assert.equal(requirement.cache_policy, CODEX_CACHE_POLICY);
      assert.equal(requirement.system_prompt_profile, CODEX_SYSTEM_PROMPT_PROFILE);
      assert.equal(requirement.reasoning_capability, 'reasoning-supported');
      assert.equal(requirement.tool_capability, 'tool-use-supported');
      assert.deepEqual(requirement.input_modalities, ['text']);
      assert.deepEqual(requirement.output_modalities, ['text']);
    }

    assert.equal(findRequirement(cruise, 'implement').model_id, 'gpt-5.6-terra');
    assert.equal(findRequirement(cruise, 'fix').service_tier, null);
    assert.equal(findRequirement(precision, 'implement').model_id, 'gpt-5.6-terra');
    assert.equal(findRequirement(afterburner, 'implement').model_id, 'gpt-5.5');
    assert.equal(findRequirement(afterburner, 'implement').service_tier, 'priority');
    assert.equal(findRequirement(cruise, 'extract').model_id, 'gpt-5.6-luna');
    for (const role of ['parent', 'strategy', 'validate', 'adjudicate', 'bughunt'] as const) {
      assert.equal(findRequirement(cruise, role).model_id, 'gpt-5.6-sol');
      assert.equal(findRequirement(cruise, role).thinking, 'xhigh');
      assert.equal(findRequirement(cruise, role).context_window, 512000);
    }
    assert.deepEqual(CODEX_CRITICAL_ROLE_QUALITY_INVARIANTS.map((entry) => entry.invariant_id), [
      'codex-sol-control-plane-xhigh',
      'codex-terra-precision-cruise-source-change-floor',
      'codex-afterburner-priority-boundary',
      'codex-luna-extract-boundary',
    ]);
  });

  void it('builds only a blocked, synthetic, non-certifying manifest candidate from offline W3 evidence', () => {
    const input = fixtureBundle();
    const candidate = buildCodexQualificationManifestCandidate(input);

    assert.equal(candidate.accepted, true);
    assert.equal(candidate.ready, false);
    assert.equal(candidate.qualification_state, 'blocked-live-certification');
    assert.equal(candidate.blocked_reason, CODEX_BLOCKED_REASON);
    assert.equal(candidate.evaluation.compatible, true);
    assert.equal(candidate.evaluation.qualified, false);
    assert.equal(candidate.manifest?.qualification_state, 'blocked-live-certification');
    assert.equal(candidate.manifest?.package_version, CODEX_REQUIRED_PACKAGE_VERSION);
    assert.equal(candidate.manifest?.pi_version, CODEX_REQUIRED_PI_VERSION);
    assert.equal(candidate.manifest?.manifest_sha256, objectAt(FIXTURE, 'expected')['manifest_sha256']);
    assert.deepEqual(candidate.manifest?.live_evidence, []);
    assert.deepEqual(candidate.manifest?.role_results.map((role) => role.state), ROSTER_ROLE_ORDER.map(() => 'synthetic-pass'));
    assert.ok(candidate.manifest?.required_evidence.some((ref) => ref.evidence_id === 'pending-codex-post-w3-live-billing'));
    assert.ok(candidate.manifest?.required_evidence.some((ref) => ref.evidence_id === 'pending-codex-post-w3-live-requests'));
    assert.equal(parseAutopilotRosterContract('autopilot.certification_manifest.v1', candidate.manifest)?.manifest_sha256, candidate.manifest?.manifest_sha256);

    const issueCodes = new Set<string>(candidate.evaluation.issues.map((issue) => issue.code));
    for (const expected of arrayAt(objectAt(FIXTURE, 'expected'), 'required_issue_codes')) {
      assert.equal(issueCodes.has(String(expected)), true, `expected issue ${String(expected)}`);
    }
  });

  void it('rejects corruption, wrong auth, wrong tier/cache/model, and missing roles without fallback', () => {
    assertNegative('corrupt-observed-profile-hash', corruptObservedHash(fixtureBundle()), 'CODEX_CORRUPT_W3_EVIDENCE');
    assertNegative('wrong-auth-api-key-openrouter', wrongAuth(fixtureBundle()), 'CODEX_FORBIDDEN_API_KEY_OR_GATEWAY');
    assertNegative('wrong-service-tier', wrongServiceTier(fixtureBundle()), 'CODEX_SERVICE_TIER_MISMATCH');
    assertNegative('wrong-cache-policy', wrongCachePolicy(fixtureBundle()), 'CODEX_CACHE_POLICY_MISMATCH');
    assertNegative('wrong-executed-model', wrongExecutedModel(fixtureBundle()), 'CODEX_EXECUTED_MODEL_MISMATCH');
    assertNegative('missing-role', missingRole(fixtureBundle()), 'CODEX_ROLE_MISSING');
  });

  void it('records the qualification report as blocked pending post-W3 live subscription witness', () => {
    assert.equal(REPORT['provider_pack_id'], CODEX_PROVIDER_PACK_ID);
    assert.equal(REPORT['ready'], false);
    assert.equal(REPORT['qualified'], false);
    assert.equal(REPORT['certifies_provider'], false);
    assert.equal(REPORT['network_calls_made'], false);
    assert.equal(REPORT['provider_calls_made'], false);
    assert.equal(REPORT['blocked_reason'], CODEX_BLOCKED_REASON);
    assert.equal(REPORT['blocked_pending'], 'post-W3 live subscription witness');
    const manifest = parseAutopilotRosterContract('autopilot.certification_manifest.v1', objectAt(REPORT, 'manifest_candidate'));
    assert.equal(manifest.qualification_state, 'blocked-live-certification');
    assert.deepEqual(manifest.live_evidence, []);
  });
});

function fixtureBundle(): CodexQualificationEvidenceBundle {
  return cloneJson(objectAt(FIXTURE, 'qualification_input')) as unknown as CodexQualificationEvidenceBundle;
}

function assertNegative(caseId: string, input: CodexQualificationEvidenceBundle, expectedIssue: string): void {
  assert.ok(arrayAt(FIXTURE, 'negative_cases').some((entry) => objectAtValue(entry)['case_id'] === caseId));
  const candidate = buildCodexQualificationManifestCandidate(input);
  assert.equal(candidate.accepted, false, caseId);
  assert.equal(candidate.ready, false, caseId);
  assert.equal(candidate.manifest, null, caseId);
  assert.ok(candidate.evaluation.issues.some((issue) => issue.code === expectedIssue), `${caseId} missing ${expectedIssue}`);
}

function corruptObservedHash(input: CodexQualificationEvidenceBundle): CodexQualificationEvidenceBundle {
  const witness = mutableRoleWitness(input, 'implement');
  const observed = mutableRecord(witness['observed_profile']);
  observed['observed_profile_sha256'] = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  witness['observed_profile'] = observed;
  if (witness['receipt'] !== null) {
    const receipt = mutableRecord(witness['receipt']);
    receipt['observed_profile'] = observed;
    witness['receipt'] = receipt;
  }
  return input;
}

function wrongAuth(input: CodexQualificationEvidenceBundle): CodexQualificationEvidenceBundle {
  const mutable = input as unknown as { auth: Record<string, unknown> };
  mutable.auth['provider_id'] = 'openrouter';
  mutable.auth['auth_class'] = 'api-key';
  mutable.auth['auth_source'] = 'environment';
  mutable.auth['billing_route_class'] = 'gateway-forbidden';
  mutable.auth['gateway_provider_id'] = 'openrouter';
  return input;
}

function wrongServiceTier(input: CodexQualificationEvidenceBundle): CodexQualificationEvidenceBundle {
  return mutateCoherentRequestObserved(input, 'implement', { service_tier: 'priority' });
}

function wrongCachePolicy(input: CodexQualificationEvidenceBundle): CodexQualificationEvidenceBundle {
  return mutateCoherentRequestObserved(input, 'implement', { cache_policy: 'none' });
}

function wrongExecutedModel(input: CodexQualificationEvidenceBundle): CodexQualificationEvidenceBundle {
  const witness = mutableRoleWitness(input, 'implement');
  const observed = mutableRecord(witness['observed_profile']);
  observed['executed_model_id'] = 'gpt-5.6-sol';
  observed['observed_profile_sha256'] = hashWithPlaceholder('autopilot.observed_profile.v1', observed, 'observed_profile_sha256');
  witness['observed_profile'] = parseAutopilotRosterContract('autopilot.observed_profile.v1', observed);
  const providerIdentity = mutableRecord(witness['provider_identity']);
  providerIdentity['executed_model_id'] = 'gpt-5.6-sol';
  witness['provider_identity'] = providerIdentity;
  if (witness['receipt'] !== null) {
    const receipt = mutableRecord(witness['receipt']);
    receipt['observed_profile'] = witness['observed_profile'];
    receipt['provider_identity'] = providerIdentity;
    witness['receipt'] = receipt;
  }
  return input;
}

function missingRole(input: CodexQualificationEvidenceBundle): CodexQualificationEvidenceBundle {
  const mutable = input as unknown as { role_witnesses: unknown[] };
  mutable.role_witnesses = mutable.role_witnesses.filter((entry) => objectAtValue(entry)['role'] !== 'validate');
  return input;
}

function mutateCoherentRequestObserved(
  input: CodexQualificationEvidenceBundle,
  role: RosterRole,
  patch: Record<string, unknown>,
): CodexQualificationEvidenceBundle {
  const witness = mutableRoleWitness(input, role);
  const request = rehashRequestProfile({ ...mutableRecord(witness['request_profile']), ...patch });
  const observedPatch: Record<string, unknown> = {};
  if (patch['service_tier'] !== undefined) observedPatch['service_tier'] = patch['service_tier'];
  if (patch['cache_policy'] !== undefined) observedPatch['cache_policy'] = patch['cache_policy'];
  const observed = rehashObservedProfile({
    ...mutableRecord(witness['observed_profile']),
    ...observedPatch,
    request_profile_sha256: request.request_profile_sha256,
  });
  witness['request_profile'] = request;
  witness['observed_profile'] = observed;
  if (witness['unit_spec'] !== null) {
    const unit = mutableRecord(witness['unit_spec']);
    unit['request_profile'] = request;
    unit['model'] = request.model;
    unit['thinking'] = request.thinking;
    witness['unit_spec'] = parseAutopilotUnitSpecV2(unit);
  }
  if (witness['receipt'] !== null) {
    const receipt = mutableRecord(witness['receipt']);
    receipt['request_profile'] = request;
    receipt['observed_profile'] = observed;
    witness['receipt'] = parseAutopilotReceiptV2(receipt);
  }
  const context = mutableRecord(witness['context_boundary']);
  context['context_window'] = request.context_window;
  context['max_output_tokens'] = request.max_output_tokens;
  witness['context_boundary'] = context;
  const prompt = mutableRecord(witness['prompt_boundary']);
  prompt['system_prompt_profile'] = request.system_prompt_profile;
  prompt['system_prompt_sha256'] = observed.system_prompt_sha256;
  witness['prompt_boundary'] = prompt;
  return input;
}

function mutableRoleWitness(input: CodexQualificationEvidenceBundle, role: RosterRole): Record<string, unknown> {
  const witnesses = (input as unknown as { role_witnesses: Record<string, unknown>[] }).role_witnesses;
  const witness = witnesses.find((entry) => entry['role'] === role);
  if (witness === undefined) throw new Error(`missing fixture witness ${role}`);
  return witness;
}

function findRequirement<T extends { readonly role: RosterRole }>(requirements: readonly T[], role: RosterRole): T {
  const requirement = requirements.find((entry) => entry.role === role);
  if (requirement === undefined) throw new Error(`missing requirement ${role}`);
  return requirement;
}

function rehashRequestProfile(value: Record<string, unknown>) {
  value['request_profile_sha256'] = hashWithPlaceholder('autopilot.request_profile.v1', value, 'request_profile_sha256');
  return parseAutopilotRosterContract('autopilot.request_profile.v1', value);
}

function rehashObservedProfile(value: Record<string, unknown>) {
  value['observed_profile_sha256'] = hashWithPlaceholder('autopilot.observed_profile.v1', value, 'observed_profile_sha256');
  return parseAutopilotRosterContract('autopilot.observed_profile.v1', value);
}

function hashWithPlaceholder(
  schemaVersion: Parameters<typeof computeAutopilotRosterContractObjectHash>[0],
  value: Record<string, unknown>,
  hashField: string,
): string {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, { ...value, [hashField]: ZERO_DIGEST });
  if (hash === null) throw new Error(`${schemaVersion} has no hash field`);
  return hash;
}

function readJsonObject(path: string): Readonly<Record<string, unknown>> {
  return objectAtValue(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function objectAt(record: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  return objectAtValue(record[key]);
}

function objectAtValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  throw new Error('expected object value');
}

function arrayAt(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const value = record[key];
  if (Array.isArray(value)) return value;
  throw new Error(`expected array at ${key}`);
}

function mutableRecord(value: unknown): Record<string, unknown> {
  return cloneJson(objectAtValue(value)) as Record<string, unknown>;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
