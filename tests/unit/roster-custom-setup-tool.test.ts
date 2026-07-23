import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAutopilotRosterSetupTool } from '../../src/core/roster/setup-tool.ts';
import {
  fakeInventoryFromProviders,
  getProviderRecipe,
  type ProviderRecipe,
  type RoleTemplate,
} from '../../src/core/roster/provider-recipes.ts';
import type { InventoryProvider, RosterInventory } from '../../src/core/roster/route-policies.ts';

type SetupBundle = ReturnType<typeof createAutopilotRosterSetupTool>;
type ToolResult = Awaited<ReturnType<SetupBundle['tool']['execute']>>['details'];

type RequestOverrides = Partial<Record<string, unknown>>;

void describe('W5 custom roster setup tool boundary', () => {
  void it('surfaces custom roster requests as an unsupported frozen tool path without parsing original_command', async () => {
    const bundle = createAutopilotRosterSetupTool({ inventory: kimiInventory() });
    const token = activate(bundle);

    const first = await invoke(bundle, request(token, 'propose', {
      natural_language_request: 'Use Kimi for strategy and ZAI for implementation.',
      custom_roster: { draft: true },
      original_command: '/autopilot literal custom roster text must not be parsed',
    }));
    const second = await invoke(bundle, request(token, 'propose', {
      natural_language_request: 'Different custom text still takes the deterministic unsupported path.',
      custom_roster: { draft: false },
      original_command: '/autopilot another command with { malformed custom json',
    }));

    assert.equal(first.ok, false);
    assert.equal(first.status, 'blocked');
    assert.deepEqual(codes(first), ['ROSTER_CUSTOM_ROSTER_UNSUPPORTED']);
    assert.equal(first.write_count, 0);
    assert.equal(first.lock_count, 0);
    assert.deepEqual(first.files_touched, []);
    assert.equal(first.result_sha256, second.result_sha256);
  });

  void it('blocks custom save payloads before delegated save and keeps zero writes', async () => {
    let saveCalls = 0;
    const bundle = createAutopilotRosterSetupTool({
      inventory: kimiInventory(),
      saveApproved: () => {
        saveCalls += 1;
        throw new Error('custom unsupported path must not delegate save');
      },
    });
    const token = activate(bundle);
    const result = await invoke(bundle, request(token, 'save', {
      custom_request: {
        schema_version: 'autopilot.custom_roster_request.v1',
        natural_language_request: 'Use a custom mixed roster.',
      },
      qualification_manifest: null,
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(codes(result), ['ROSTER_CUSTOM_ROSTER_UNSUPPORTED']);
    assert.equal(result.write_count, 0);
    assert.equal(result.lock_count, 0);
    assert.deepEqual(result.files_touched, []);
    assert.equal(saveCalls, 0);
  });
});

function activate(bundle: SetupBundle): string {
  const activation = bundle.controller.activate('unit-test-w5-custom-setup');
  assert.equal(activation.ok, true);
  if (activation.activation_token === null) throw new Error('missing activation token');
  return activation.activation_token;
}

async function invoke(bundle: SetupBundle, input: unknown): Promise<ToolResult> {
  const output = await bundle.tool.execute('tool-call-w5-custom', input, undefined, undefined, { isProjectTrusted: () => true });
  assert.equal(output.content.length, 1);
  return output.details;
}

function request(token: string, action: string, overrides: RequestOverrides = {}): Record<string, unknown> {
  return {
    schema_version: 'autopilot.roster_tool_request.v1',
    action,
    activation_token: token,
    approval_token: null,
    scope: 'user',
    trusted_project_root: null,
    candidate_set_sha256: null,
    approved_roster_sha256s: [],
    default_roster_id: null,
    default_roster_revision: null,
    default_roster_sha256: null,
    original_command: '/autopilot phase37 custom',
    ...overrides,
  };
}

function codes(result: ToolResult): readonly string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function kimiInventory(): RosterInventory {
  return fakeInventoryFromProviders({
    inventory_id: 'inventory-w5-custom-setup-tool-kimi',
    providers: [providerForRecipe(mustRecipe('kimi-coding-plan'))],
  });
}

function mustRecipe(recipeId: string): ProviderRecipe {
  const recipe = getProviderRecipe(recipeId, 1);
  if (recipe === null) throw new Error(`missing recipe ${recipeId}`);
  return recipe;
}

function providerForRecipe(recipe: ProviderRecipe): InventoryProvider {
  const byModel = new Map<string, RoleTemplate[]>();
  for (const profile of recipe.profile_templates) {
    for (const roleTemplate of profile.role_templates) {
      const key = `${roleTemplate.model_id}:${roleTemplate.api}`;
      byModel.set(key, [...(byModel.get(key) ?? []), roleTemplate]);
    }
  }
  return {
    provider_id: recipe.provider_family,
    auth_configured: true,
    auth_class: recipe.provider_family === 'openai-codex' ? 'oauth' : 'api-key-plan-token',
    auth_source: 'stored',
    auth_status: 'configured',
    is_using_oauth: recipe.provider_family === 'openai-codex',
    billing_route_class: recipe.provider_family === 'openai-codex' ? 'subscription-oauth' : 'plan-api-token',
    models: [...byModel.values()].map((templates) => {
      const first = templates[0];
      if (first === undefined) throw new Error('empty model template group');
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
    }),
  };
}
