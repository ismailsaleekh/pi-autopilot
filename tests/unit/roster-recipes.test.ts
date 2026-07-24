import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PHASE37_FIXTURE_CLOCK,
  PHASE37_PACKAGE_VERSION,
  PHASE37_PI_VERSION,
  ROSTER_ROLE_ORDER,
  ROUTE_POLICIES,
  canonicalSha256,
  findInventoryProvider,
  findRoutePolicy,
  type InventoryProvider,
  type RoutePolicy,
} from '../../src/core/roster/route-policies.ts';
import {
  ANTHROPIC_OPUS5_SONNET5_CANDIDATE,
  ANTHROPIC_OPUS5_SONNET5_RECIPE,
  ANTHROPIC_OPUS5_SONNET5_ROSTER,
  PROVIDER_RECIPES,
  PROVIDER_RECIPE_REGISTRY,
  PROVIDER_RECIPE_REGISTRY_SHA256,
  SEED_CANDIDATE_REGISTRY,
  SEED_CANDIDATE_REGISTRY_SHA256,
  SEED_CANDIDATES,
  SEED_ROSTERS,
  assertCandidateDirectReferences,
  buildRosterFromRecipe,
  fakeInventoryFromProviders,
  getProfileTemplate,
  getProviderRecipe,
  proposeRosterCandidates,
  requestProfileFromAssignment,
  resolveRecipe,
  validateCandidateSetApproval,
  validateRequestProfileForAssignment,
  verifyProviderRecipeSeeds,
  verifySeedCandidateRegistry,
  type EvidenceRef,
  type ProviderRecipe,
  type QualificationManifest,
  type RoleTemplate,
} from '../../src/core/roster/provider-recipes.ts';

function mustCodexRecipe(): ProviderRecipe {
  const recipe = getProviderRecipe('codex-subscription', 1);
  if (recipe === null) {
    throw new Error('missing codex recipe');
  }
  return recipe;
}

function providerForRecipe(recipe: ProviderRecipe, overrides: Partial<InventoryProvider> = {}): InventoryProvider {
  const byModel = new Map<string, RoleTemplate[]>();
  for (const profile of recipe.profile_templates) {
    for (const roleTemplate of profile.role_templates) {
      const key = `${roleTemplate.model_id}:${roleTemplate.api}`;
      byModel.set(key, [...(byModel.get(key) ?? []), roleTemplate]);
    }
  }
  const models = [...byModel.values()].map((templates) => {
    const first = templates[0];
    if (first === undefined) {
      throw new Error('empty model template group');
    }
    return {
      model_id: first.model_id,
      api: first.api,
      context_window: Math.max(...templates.map((template) => template.context_window)),
      max_output_tokens: Math.max(...templates.map((template) => template.max_output_tokens)),
      input_modalities: [...new Set(templates.flatMap((template) => [...template.input_modalities]))].sort(),
      output_modalities: [...new Set(templates.flatMap((template) => [...template.output_modalities]))].sort(),
      reasoning_capability: first.reasoning_capability,
      tool_capability: first.tool_capability,
      thinking_values: [...new Set(templates.map((template) => template.thinking))].sort(),
      service_tiers: [...new Set(templates.map((template) => template.service_tier))].sort((left, right) => {
        if (left === right) return 0;
        if (left === null) return -1;
        if (right === null) return 1;
        return left.localeCompare(right);
      }),
      cache_policies: [...new Set(templates.map((template) => template.cache_policy))].sort(),
      system_prompt_profiles: [...new Set(templates.map((template) => template.system_prompt_profile))].sort(),
    };
  });
  return {
    provider_id: recipe.provider_family,
    auth_configured: true,
    auth_class: recipe.provider_family === 'openai-codex' ? 'oauth' : 'api-key-plan-token',
    auth_source: 'stored',
    auth_status: 'configured',
    is_using_oauth: recipe.provider_family === 'openai-codex',
    billing_route_class: recipe.provider_family === 'openai-codex' ? 'subscription-oauth' : 'plan-api-token',
    models,
    ...overrides,
  };
}

function codexInventory(overrides: Partial<InventoryProvider> = {}) {
  return fakeInventoryFromProviders({
    inventory_id: 'inventory-qualified-codex-synthetic',
    providers: [providerForRecipe(mustCodexRecipe(), overrides)],
  });
}

function forgeSyntheticQualificationManifest(
  recipe: ProviderRecipe,
  options: { readonly expires_at?: string; readonly priority_proof?: boolean } = {},
): QualificationManifest {
  const evidence: EvidenceRef = {
    evidence_id: `synthetic-${recipe.recipe_id}-fixture`,
    kind: 'synthetic-fixture',
    uri: `fixture://phase37/${recipe.recipe_id}`,
    sha256: null,
    byte_count: null,
    secret_free: true,
  };
  const priorityEvidence: EvidenceRef | null = options.priority_proof === true
    ? {
        evidence_id: `synthetic-${recipe.recipe_id}-priority-proof`,
        kind: 'billing-proof',
        uri: `fixture://phase37/${recipe.recipe_id}/priority-proof`,
        sha256: null,
        byte_count: null,
        secret_free: true,
      }
    : null;
  const withoutHash = {
    schema_version: 'autopilot.certification_manifest.v1' as const,
    manifest_id: `synthetic-${recipe.recipe_id}-qualification`,
    manifest_revision: 1,
    subject_kind: 'provider_recipe' as const,
    subject_id: recipe.recipe_id,
    subject_sha256: recipe.recipe_sha256,
    package_version: PHASE37_PACKAGE_VERSION,
    pi_version: PHASE37_PI_VERSION,
    qualification_state: 'synthetic-test-ready' as const,
    role_results: ROSTER_ROLE_ORDER.map((role) => ({ role, state: 'synthetic-pass' as const, evidence_refs: [evidence] })),
    required_evidence: priorityEvidence === null ? [evidence] : [evidence, priorityEvidence],
    live_evidence: [] as readonly EvidenceRef[],
    issued_at: PHASE37_FIXTURE_CLOCK,
    expires_at: options.expires_at ?? '2026-07-23T12:00:00.000Z',
  } satisfies Omit<QualificationManifest, 'manifest_sha256'>;
  return { ...withoutHash, manifest_sha256: canonicalSha256(withoutHash) };
}

void describe('Phase 37 W1 provider recipes and candidates', () => {
  void it('embeds exact W0 provider recipe and seed candidate registries', () => {
    assert.equal(PROVIDER_RECIPES.length, 7);
    assert.deepEqual(verifyProviderRecipeSeeds(), []);
    assert.deepEqual(verifySeedCandidateRegistry(), []);
    assert.deepEqual(
      PROVIDER_RECIPES.map((recipe) => `${recipe.recipe_id}:${recipe.recipe_revision}`),
      PROVIDER_RECIPES.map((recipe) => `${recipe.recipe_id}:${recipe.recipe_revision}`).sort((left, right) => left.localeCompare(right)),
    );
    assert.deepEqual(
      SEED_CANDIDATES.map((candidate) => candidate.candidate_sort_key),
      SEED_CANDIDATES.map((candidate) => candidate.candidate_sort_key).sort((left, right) => left.localeCompare(right)),
    );
    assert.equal(PROVIDER_RECIPE_REGISTRY_SHA256, 'sha256:80ae7c8ef05505fa3381aa383041ef374061d01cb4991163838db7cf9a55fcba');
    assert.equal(SEED_CANDIDATE_REGISTRY_SHA256, 'sha256:fd3d9f3856991c51128428c58a46c2f00d08c8fd6e4885f7ea53296046b3ee71');
    for (const candidate of SEED_CANDIDATES) {
      assertCandidateDirectReferences(candidate);
      assert.notEqual(candidate.launch_readiness, 'synthetic-fixture-only');
    }
  });

  void it('registers the approved Anthropic Opus 5 / Sonnet 5 Precision chain as non-certifying authority', () => {
    assert.equal(ANTHROPIC_OPUS5_SONNET5_RECIPE.recipe_id, 'anthropic-opus5-sonnet5-subscription');
    assert.equal(ANTHROPIC_OPUS5_SONNET5_ROSTER.roster_id, 'anthropic-precision-opus5-sonnet5-v1');
    assert.equal(ANTHROPIC_OPUS5_SONNET5_ROSTER.pi_version, '0.81.1');
    assert.equal(ANTHROPIC_OPUS5_SONNET5_CANDIDATE.candidate_id, 'anthropic-precision-opus5-sonnet5-v1');
    assert.equal(ANTHROPIC_OPUS5_SONNET5_CANDIDATE.launch_readiness, 'not-ready-until-w4');
    assert.deepEqual(ANTHROPIC_OPUS5_SONNET5_ROSTER.assignments.map((assignment) => [assignment.role, assignment.model_id, assignment.thinking]), [
      ['parent', 'claude-opus-5', 'xhigh'],
      ['strategy', 'claude-opus-5', 'xhigh'],
      ['implement', 'claude-sonnet-5', 'xhigh'],
      ['validate', 'claude-opus-5', 'xhigh'],
      ['fix', 'claude-sonnet-5', 'xhigh'],
      ['adjudicate', 'claude-opus-5', 'xhigh'],
      ['bughunt', 'claude-opus-5', 'xhigh'],
      ['extract', 'claude-sonnet-5', 'high'],
    ]);
    assert.equal(ANTHROPIC_OPUS5_SONNET5_ROSTER.assignments.every((assignment) => assignment.provider_id === 'anthropic'), true);
    assert.equal(ANTHROPIC_OPUS5_SONNET5_ROSTER.assignments.every((assignment) => assignment.auth_class === 'oauth'), true);
    assert.equal(ANTHROPIC_OPUS5_SONNET5_ROSTER.assignments.every((assignment) => assignment.billing_route_class === 'subscription-oauth'), true);
    assert.equal(ANTHROPIC_OPUS5_SONNET5_ROSTER.assignments.every((assignment) => assignment.system_prompt_profile === 'anthropic-autopilot-sanitized.v1'), true);
    assert.deepEqual(new Set(ANTHROPIC_OPUS5_SONNET5_ROSTER.assignments.map((assignment) => assignment.model_id)), new Set(['claude-opus-5', 'claude-sonnet-5']));
  });

  void it('deep-freezes exported recipe, seed roster, and candidate authority', () => {
    const recipe = PROVIDER_RECIPES[1];
    const role = recipe?.profile_templates[0]?.role_templates[0];
    const candidate = SEED_CANDIDATES[0];
    const assignment = SEED_ROSTERS[0]?.assignments[0];
    if (recipe === undefined || role === undefined || candidate === undefined || assignment === undefined) throw new Error('missing frozen roster seed fixture');
    assert.throws(() => {
      Reflect.apply(Array.prototype.push, recipe.profile_templates, [{}]);
    }, TypeError);
    assert.throws(() => {
      Object.defineProperty(role, 'model_id', { value: 'forged-model' });
    }, TypeError);
    assert.throws(() => {
      Reflect.apply(Array.prototype.push, candidate.diagnostic_codes, ['ROSTER_ROUTE_FORBIDDEN']);
    }, TypeError);
    assert.throws(() => {
      Reflect.apply(Array.prototype.push, assignment.input_modalities, ['audio']);
    }, TypeError);
    assert.throws(() => {
      Reflect.apply(Array.prototype.push, PROVIDER_RECIPE_REGISTRY.recipes, [{}]);
    }, TypeError);
    assert.throws(() => {
      Reflect.apply(Array.prototype.push, SEED_CANDIDATE_REGISTRY.candidates, [{}]);
    }, TypeError);
    assert.deepEqual(verifyProviderRecipeSeeds(), []);
    assert.deepEqual(verifySeedCandidateRegistry(), []);
  });

  void it('seed presence alone never becomes ready', () => {
    const recipe = mustCodexRecipe();
    const inventory = codexInventory();
    const result = resolveRecipe(
      {
        schema_version: 'autopilot.recipe_resolution_request.v1',
        profile_id: 'cruise',
        recipe_id: recipe.recipe_id,
        recipe_revision: recipe.recipe_revision,
        inventory_sha256: inventory.inventory_sha256,
      },
      inventory,
      { recipes: [recipe] },
    );

    assert.equal(result.resolved, true);
    assert.equal(result.candidate?.candidate_state, 'qualification-required');
    assert.equal(result.candidate?.launch_readiness, 'not-ready-until-w4');
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_QUALIFICATION_REQUIRED']);
  });

  void it('self-hashed synthetic qualification manifests never produce ready candidates', () => {
    const recipe = mustCodexRecipe();
    const inventory = codexInventory();
    const manifest = forgeSyntheticQualificationManifest(recipe, { priority_proof: true });
    const proposal = proposeRosterCandidates({ inventory, recipes: [recipe], qualification_manifests: [manifest] });

    assert.equal(proposal.ok, false);
    assert.equal(proposal.status, 'blocked');
    assert.deepEqual(proposal.candidate_set.candidates, []);
    assert.deepEqual(proposal.diagnostics.map((diagnostic) => diagnostic.code), [
      'ROSTER_PRIORITY_PROOF_REQUIRED',
      'ROSTER_QUALIFICATION_REQUIRED',
    ]);

    const includeUnready = proposeRosterCandidates({
      inventory,
      recipes: [recipe],
      qualification_manifests: [manifest],
      include_unready: true,
    });
    assert.equal(includeUnready.ok, false);
    assert.equal(includeUnready.candidate_set.candidates.every((candidate) => candidate.launch_readiness !== 'synthetic-fixture-only'), true);
    assert.equal(includeUnready.candidate_set.candidates.every((candidate) => candidate.synthetic_fixture_ready_only === false), true);
  });

  void it('reports stale candidate hashes before approval can be used', () => {
    const recipe = mustCodexRecipe();
    const inventory = codexInventory();
    const result = resolveRecipe(
      {
        schema_version: 'autopilot.recipe_resolution_request.v1',
        profile_id: 'cruise',
        recipe_id: recipe.recipe_id,
        recipe_revision: recipe.recipe_revision,
        inventory_sha256: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      },
      inventory,
      { recipes: [recipe] },
    );

    assert.equal(result.resolved, true);
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
      'ROSTER_APPROVAL_STALE_CANDIDATE_SET',
      'ROSTER_QUALIFICATION_REQUIRED',
    ]);

    const proposal = proposeRosterCandidates({
      inventory,
      recipes: [recipe],
      include_unready: true,
    });
    assert.deepEqual(
      validateCandidateSetApproval(
        proposal.candidate_set,
        'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        proposal.candidate_set.candidates.map((candidate) => candidate.roster_sha256),
      ).map((diagnostic) => diagnostic.code),
      ['ROSTER_APPROVAL_STALE_CANDIDATE_SET'],
    );
  });

  void it('rejects missing capability without model/API/thinking clamping', () => {
    const recipe = mustCodexRecipe();
    const inventory = codexInventory({
      models: providerForRecipe(recipe).models.map((model) =>
        model.model_id === 'gpt-5.6-sol' ? { ...model, thinking_values: ['high'] } : model,
      ),
    });
    const result = resolveRecipe(
      {
        schema_version: 'autopilot.recipe_resolution_request.v1',
        profile_id: 'cruise',
        recipe_id: recipe.recipe_id,
        recipe_revision: recipe.recipe_revision,
        inventory_sha256: inventory.inventory_sha256,
      },
      inventory,
      { recipes: [recipe] },
    );

    assert.equal(result.resolved, false);
    assert.equal(result.candidate, null);
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_ROUTE_FORBIDDEN']);
  });

  void it('never infers a provider through OpenRouter model labels', () => {
    const recipe = mustCodexRecipe();
    const openRouterInventory = fakeInventoryFromProviders({
      inventory_id: 'inventory-openrouter-forbidden-synthetic',
      providers: [
        {
          provider_id: 'openrouter',
          auth_configured: true,
          auth_class: 'api-key',
          auth_source: 'environment',
          auth_status: 'forbidden',
          is_using_oauth: false,
          billing_route_class: 'gateway-forbidden',
          models: [
            {
              model_id: 'openai/gpt-5.6-sol',
              api: 'openai-completions',
              context_window: 128000,
              max_output_tokens: 16384,
              input_modalities: ['text'],
              output_modalities: ['text'],
              reasoning_capability: 'reasoning-supported',
              tool_capability: 'tool-use-supported',
              thinking_values: ['high'],
              service_tiers: [null],
              cache_policies: ['provider-default'],
              system_prompt_profiles: ['pi-default.v1'],
            },
          ],
        },
      ],
    });
    const proposal = proposeRosterCandidates({ inventory: openRouterInventory, recipes: [recipe] });

    assert.equal(proposal.ok, false);
    assert.deepEqual(proposal.candidate_set.candidates, []);
    assert.deepEqual(proposal.diagnostics.map((diagnostic) => diagnostic.code), [
      'ROSTER_AUTH_CHANNEL_FORBIDDEN',
      'ROSTER_ROUTE_FORBIDDEN',
    ]);
  });

  void it('does not infer another default when Cruise is blocked', () => {
    const recipe = mustCodexRecipe();
    const blockedRecipe: ProviderRecipe = {
      ...recipe,
      qualification_state: 'blocked-live-certification',
      recipe_state: 'blocked-live-certification',
    };
    const proposal = proposeRosterCandidates({
      inventory: codexInventory(),
      recipes: [blockedRecipe],
      include_unready: true,
    });

    assert.equal(proposal.ok, false);
    const cruise = proposal.candidate_set.candidates.find((candidate) => candidate.profile_id === 'cruise');
    assert.equal(cruise?.launch_readiness, 'blocked');
    assert.deepEqual(proposal.diagnostics.map((diagnostic) => diagnostic.code), [
      'ROSTER_CONVERGED_ASSIGNMENT_SET',
      'ROSTER_EXPLICIT_CHOICE_REQUIRED',
      'ROSTER_QUALIFICATION_REQUIRED',
      'ROSTER_RECOMMENDED_PROFILE_BLOCKED',
      'ROSTER_ROUTE_FORBIDDEN',
    ]);
  });

  void it('uses injected route policy authority for inventory and assignment conformance without global fallback', () => {
    const recipe = mustCodexRecipe();
    const inventory = codexInventory();
    const routePolicy = findRoutePolicy(recipe.route_policy_id, recipe.route_policy_revision, ROUTE_POLICIES);
    if (routePolicy === null) {
      throw new Error('missing codex route policy');
    }

    const authDivergentPolicy: RoutePolicy = { ...routePolicy, allowed_auth_classes: ['api-key'] };
    const authResult = resolveRecipe(
      {
        schema_version: 'autopilot.recipe_resolution_request.v1',
        profile_id: 'cruise',
        recipe_id: recipe.recipe_id,
        recipe_revision: recipe.recipe_revision,
        inventory_sha256: inventory.inventory_sha256,
      },
      inventory,
      { recipes: [recipe], routePolicies: [authDivergentPolicy] },
    );
    assert.equal(authResult.resolved, false);
    assert.equal(authResult.candidate, null);
    assert.deepEqual(authResult.diagnostics.map((diagnostic) => diagnostic.code), [
      'ROSTER_AUTH_CHANNEL_FORBIDDEN',
      'ROSTER_AUTH_REQUIRED',
    ]);

    const promptDivergentPolicy: RoutePolicy = {
      ...routePolicy,
      allowed_system_prompt_profiles: ['anthropic-autopilot-sanitized.v1'],
    };
    const conformanceResult = resolveRecipe(
      {
        schema_version: 'autopilot.recipe_resolution_request.v1',
        profile_id: 'cruise',
        recipe_id: recipe.recipe_id,
        recipe_revision: recipe.recipe_revision,
        inventory_sha256: inventory.inventory_sha256,
      },
      inventory,
      { recipes: [recipe], routePolicies: [promptDivergentPolicy] },
    );
    assert.equal(conformanceResult.resolved, false);
    assert.equal(conformanceResult.candidate, null);
    assert.deepEqual(conformanceResult.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_ROUTE_FORBIDDEN']);
  });

  void it('validates request profiles exactly against role assignments', () => {
    const recipe = mustCodexRecipe();
    const profile = getProfileTemplate(recipe, 'cruise');
    if (profile === null) {
      throw new Error('missing cruise profile');
    }
    const routePolicy = findRoutePolicy(recipe.route_policy_id, recipe.route_policy_revision, ROUTE_POLICIES);
    if (routePolicy === null) {
      throw new Error('missing codex route policy');
    }
    const inventory = codexInventory();
    const provider = findInventoryProvider(inventory, 'openai-codex');
    if (provider === null) {
      throw new Error('missing codex provider');
    }
    const roster = buildRosterFromRecipe({ recipe, profile, routePolicy, routePolicies: ROUTE_POLICIES, provider, scope: 'user' });
    const implement = roster.assignments.find((assignment) => assignment.role === 'implement');
    if (implement === undefined) {
      throw new Error('missing implement assignment');
    }
    const requestProfile = requestProfileFromAssignment(implement);

    assert.deepEqual(validateRequestProfileForAssignment(requestProfile, implement), []);
    assert.deepEqual(
      validateRequestProfileForAssignment({ ...requestProfile, thinking: 'xhigh' }, implement).map((diagnostic) => diagnostic.code),
      ['ROSTER_REQUEST_PROFILE_DRIFT'],
    );
  });
});
