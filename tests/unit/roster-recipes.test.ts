import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ROUTE_POLICIES, findInventoryProvider, findRoutePolicy, type InventoryProvider } from '../../src/core/roster/route-policies.ts';
import {
  PROVIDER_RECIPES,
  PROVIDER_RECIPE_REGISTRY_SHA256,
  SEED_CANDIDATE_REGISTRY_SHA256,
  SEED_CANDIDATES,
  assertCandidateDirectReferences,
  buildRosterFromRecipe,
  createSyntheticQualificationManifest,
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
  type ProviderRecipe,
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

void describe('Phase 37 W1 provider recipes and candidates', () => {
  void it('embeds exact W0 provider recipe and seed candidate registries', () => {
    assert.equal(PROVIDER_RECIPES.length, 5);
    assert.deepEqual(verifyProviderRecipeSeeds(), []);
    assert.deepEqual(verifySeedCandidateRegistry(), []);
    assert.equal(PROVIDER_RECIPE_REGISTRY_SHA256, 'sha256:0aaa55110a1e808895d0ed7e73b6bc3dac75ae815c3439783c0ce1b112a4434f');
    assert.equal(SEED_CANDIDATE_REGISTRY_SHA256, 'sha256:b033d74a3fdcebe9ec5a3e996a2835da7d04eb61c4e98567edb079425198ac6f');
    for (const candidate of SEED_CANDIDATES) {
      assertCandidateDirectReferences(candidate);
      assert.notEqual(candidate.launch_readiness, 'synthetic-fixture-only');
    }
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

  void it('only an exact synthetic qualification manifest produces ready candidates', () => {
    const recipe = mustCodexRecipe();
    const inventory = codexInventory();
    const manifest = createSyntheticQualificationManifest(recipe);
    const proposal = proposeRosterCandidates({ inventory, recipes: [recipe], qualification_manifests: [manifest] });

    assert.equal(proposal.ok, true);
    assert.equal(proposal.status, 'proposed');
    assert.deepEqual(proposal.candidate_set.candidates.map((candidate) => candidate.candidate_id), [
      'codex-cruise-v1',
      'codex-precision-v1',
    ]);
    assert.deepEqual(proposal.candidate_set.candidates.map((candidate) => candidate.candidate_sha256), [
      'sha256:4e749047eb8c9ea0ba9e70f02d974b5eb4a1db4fe1933e6a7fc783866e5cc6f3',
      'sha256:7418986444cb896932d7b4366c7815793dac0781aae83177f8d90d29a9651052',
    ]);
    assert.equal(proposal.candidate_set.candidates[0]?.converges_with, 'codex-precision-v1');
    assert.deepEqual(proposal.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_CONVERGED_ASSIGNMENT_SET']);

    const corruptManifest = { ...manifest, subject_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const };
    const corruptProposal = proposeRosterCandidates({ inventory, recipes: [recipe], qualification_manifests: [corruptManifest] });
    assert.equal(corruptProposal.ok, false);
    assert.equal(corruptProposal.candidate_set.candidates.length, 0);
    assert.deepEqual(corruptProposal.diagnostics.map((diagnostic) => diagnostic.code), [
      'ROSTER_PRIORITY_PROOF_REQUIRED',
      'ROSTER_QUALIFICATION_REQUIRED',
    ]);
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
      qualification_manifests: [createSyntheticQualificationManifest(recipe)],
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
    const roster = buildRosterFromRecipe({ recipe, profile, routePolicy, provider, scope: 'user' });
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
