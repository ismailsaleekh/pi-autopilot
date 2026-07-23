import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type InventoryProvider } from '../../src/core/roster/route-policies.ts';
import {
  fakeInventoryFromProviders,
  getProviderRecipe,
  type ProviderRecipe,
  type RoleTemplate,
} from '../../src/core/roster/provider-recipes.ts';
import { doctorRoleResults, doctorRosterInventory } from '../../src/core/roster/doctor.ts';

function mustRecipe(recipeId: string): ProviderRecipe {
  const recipe = getProviderRecipe(recipeId, 1);
  if (recipe === null) {
    throw new Error(`missing recipe ${recipeId}`);
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

void describe('Phase 37 W1 roster doctor', () => {
  void it('produces unique sorted route and recipe results while unqualified seeds remain blocked', () => {
    const recipe = mustRecipe('codex-subscription');
    const inventory = fakeInventoryFromProviders({
      inventory_id: 'doctor-codex-unqualified',
      providers: [providerForRecipe(recipe)],
    });
    const result = doctorRosterInventory({ inventory, recipes: [recipe] });

    assert.equal(result.status, 'warn');
    assert.equal(result.route_results.length, 1);
    assert.equal(result.route_results[0]?.matched, true);
    assert.equal(result.recipe_results.length, 3);
    assert.deepEqual(
      result.route_results.map((route) => route.result_sha256),
      [...result.route_results.map((route) => route.result_sha256)].sort(),
    );
    assert.deepEqual(
      result.recipe_results.map((recipeResult) => recipeResult.result_sha256),
      [...result.recipe_results.map((recipeResult) => recipeResult.result_sha256)].sort(),
    );
    assert.equal(new Set(result.recipe_results.map((recipeResult) => recipeResult.result_sha256)).size, result.recipe_results.length);
    assert.equal(result.diagnostics.every((diagnostic) => diagnostic.secret_free), true);
    assert.equal(
      result.recipe_results.every(
        (recipeResult) =>
          recipeResult.candidate !== null &&
          recipeResult.candidate.launch_readiness === 'not-ready-until-w4' &&
          recipeResult.candidate.synthetic_fixture_ready_only === false,
      ),
      true,
    );
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'ROSTER_QUALIFICATION_REQUIRED'));
  });

  void it('blocks doctor on missing auth and never resolves credentials', () => {
    const recipe = mustRecipe('codex-subscription');
    const inventory = fakeInventoryFromProviders({
      inventory_id: 'doctor-codex-no-auth',
      providers: [
        providerForRecipe(recipe, {
          auth_configured: false,
          auth_class: null,
          auth_source: null,
          auth_status: 'missing',
          is_using_oauth: false,
        }),
      ],
    });
    const result = doctorRosterInventory({ inventory, recipes: [recipe] });

    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_AUTH_REQUIRED']);
    assert.equal(result.route_results[0]?.matched, false);
    assert.equal(result.recipe_results.every((recipeResult) => recipeResult.candidate === null), true);
  });

  void it('reports OpenRouter as a forbidden route without provider-label inference', () => {
    const recipe = mustRecipe('codex-subscription');
    const inventory = fakeInventoryFromProviders({
      inventory_id: 'doctor-openrouter',
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
    const result = doctorRosterInventory({ inventory, recipes: [recipe] });

    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
      'ROSTER_AUTH_CHANNEL_FORBIDDEN',
      'ROSTER_ROUTE_FORBIDDEN',
    ]);
    assert.equal(result.recipe_results.every((recipeResult) => recipeResult.candidate === null), true);
  });

  void it('role doctor results are unique, sorted, and detect missing capability', () => {
    const recipe = mustRecipe('codex-subscription');
    const provider = providerForRecipe(recipe, {
      models: providerForRecipe(recipe).models.map((model) =>
        model.model_id === 'gpt-5.6-terra' ? { ...model, context_window: 1024 } : model,
      ),
    });
    const inventory = fakeInventoryFromProviders({ inventory_id: 'doctor-missing-capability', providers: [provider] });
    const roleResults = doctorRoleResults({ inventory, recipes: [recipe] });

    assert.equal(roleResults.length, 24);
    assert.deepEqual(
      roleResults.map((roleResult) => roleResult.result_sha256),
      [...roleResults.map((roleResult) => roleResult.result_sha256)].sort(),
    );
    assert.equal(new Set(roleResults.map((roleResult) => roleResult.result_sha256)).size, roleResults.length);
    const failingRoles = roleResults.filter((roleResult) => !roleResult.ok).map((roleResult) => roleResult.role);
    assert.equal(failingRoles.includes('implement'), true);
    assert.equal(failingRoles.includes('fix'), true);
    assert.equal(
      roleResults
        .filter((roleResult) => !roleResult.ok)
        .every((roleResult) => roleResult.diagnostics.some((diagnostic) => diagnostic.code === 'ROSTER_ROUTE_FORBIDDEN')),
      true,
    );
  });
});
