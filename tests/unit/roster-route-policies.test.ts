import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROUTE_POLICIES,
  ROUTE_POLICY_REGISTRY_SHA256,
  hashRosterInventory,
  normalizeRosterInventory,
  resolveRoute,
  verifyRoutePolicySeeds,
  type RosterInventory,
} from '../../src/core/roster/route-policies.ts';

void describe('Phase 37 W1 route policies', () => {
  void it('embeds exact W0 non-certifying route policy seeds and registry hash', () => {
    assert.equal(ROUTE_POLICIES.length, 5);
    assert.deepEqual(verifyRoutePolicySeeds(), []);
    assert.equal(
      ROUTE_POLICY_REGISTRY_SHA256,
      'sha256:1ab6cb1d816aeba66caaeb0bff4fc5c1faf643a8ce1bb55a1a3c3d28076bb751',
    );
    assert.equal(ROUTE_POLICIES.every((policy) => policy.non_certifying_seed), true);
    assert.equal(ROUTE_POLICIES.every((policy) => policy.forbidden_gateways.includes('openrouter')), true);
  });

  void it('matches routes only from explicit provider/api/auth facts', () => {
    const result = resolveRoute({
      schema_version: 'autopilot.route_resolution_request.v1',
      provider_id: 'openai-codex',
      api: 'openai-codex-responses',
      auth_class: 'oauth',
      auth_source: 'stored',
      project_trusted: true,
    });

    assert.equal(result.matched, true);
    assert.equal(result.route_policy_id, 'codex-subscription-v1');
    assert.equal(result.route_policy_revision, 1);
    assert.deepEqual(result.diagnostics, []);
  });

  void it('blocks missing auth without fallback', () => {
    const result = resolveRoute({
      schema_version: 'autopilot.route_resolution_request.v1',
      provider_id: 'openai-codex',
      api: 'openai-codex-responses',
      auth_class: 'none',
      auth_source: 'not-configured',
      project_trusted: true,
    });

    assert.equal(result.matched, false);
    assert.equal(result.route_policy_id, 'codex-subscription-v1');
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_AUTH_REQUIRED']);
  });

  void it('rejects OpenRouter and arbitrary environment-key gateway routes', () => {
    const result = resolveRoute({
      schema_version: 'autopilot.route_resolution_request.v1',
      provider_id: 'openrouter',
      api: 'openai-completions',
      auth_class: 'api-key',
      auth_source: 'environment',
      project_trusted: true,
    });

    assert.equal(result.matched, false);
    assert.equal(result.route_policy_id, null);
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
      'ROSTER_AUTH_CHANNEL_FORBIDDEN',
      'ROSTER_ROUTE_FORBIDDEN',
    ]);
  });

  void it('keeps blocked live-certification policies blocked even when auth facts match', () => {
    const result = resolveRoute({
      schema_version: 'autopilot.route_resolution_request.v1',
      provider_id: 'anthropic',
      api: 'anthropic-messages',
      auth_class: 'api-key',
      auth_source: 'stored',
      project_trusted: true,
    });

    assert.equal(result.matched, false);
    assert.equal(result.route_policy_id, 'anthropic-sanitized-v1');
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['ROSTER_ROUTE_FORBIDDEN']);
  });

  void it('canonicalizes inventory hashes independent of provider/model ordering', () => {
    const unordered = normalizeRosterInventory({
      schema_version: 'autopilot.roster_inventory.v1',
      inventory_id: 'inventory-ordering-test',
      created_at: '2026-07-22T12:00:00.000Z',
      source: 'synthetic-fixture',
      project_trusted: true,
      providers: [
        {
          provider_id: 'zai',
          auth_configured: true,
          auth_class: 'api-key-plan-token',
          auth_source: 'stored',
          auth_status: 'configured',
          is_using_oauth: false,
          billing_route_class: 'plan-api-token',
          models: [
            {
              model_id: 'glm-5.2',
              api: 'openai-completions',
              context_window: 256000,
              max_output_tokens: 32768,
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
        {
          provider_id: 'openai-codex',
          auth_configured: true,
          auth_class: 'oauth',
          auth_source: 'stored',
          auth_status: 'configured',
          is_using_oauth: true,
          billing_route_class: 'subscription-oauth',
          models: [],
        },
      ],
    });
    const reordered: RosterInventory = {
      ...unordered,
      providers: [...unordered.providers].reverse(),
      inventory_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };

    assert.equal(hashRosterInventory(reordered), unordered.inventory_sha256);
  });
});
