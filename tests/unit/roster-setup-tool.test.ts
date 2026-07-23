import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createAutopilotRosterSetupTool, renderRosterSetupApprovalPresentation } from '../../src/core/roster/setup-tool.ts';
import {
  PHASE37_FIXTURE_CLOCK,
  canonicalSha256,
  type Digest,
  type InventoryProvider,
  type RosterInventory,
} from '../../src/core/roster/route-policies.ts';
import {
  fakeInventoryFromProviders,
  getProviderRecipe,
  type ProviderRecipe,
  type RoleTemplate,
} from '../../src/core/roster/provider-recipes.ts';

type SetupBundle = ReturnType<typeof createAutopilotRosterSetupTool>;
type ToolResult = Awaited<ReturnType<SetupBundle['tool']['execute']>>['details'];
type ToolRequest = Parameters<SetupBundle['tool']['execute']>[1];

const ZERO_SHA = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as Digest;
const CONFIG_SHA = 'sha256:1d8a144806f7bd3df23724eb702223c7180b4d160cb09fc8cff5cbc77a1e3a38' as Digest;

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'roster-setup-tool-'));
  try {
    await chmod(dir, 0o700);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function mustRecipe(recipeId = 'codex-subscription'): ProviderRecipe {
  const recipe = getProviderRecipe(recipeId, 1);
  if (recipe === null) throw new Error(`missing recipe ${recipeId}`);
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

function codexInventory(overrides: Partial<InventoryProvider> = {}): RosterInventory {
  return fakeInventoryFromProviders({
    inventory_id: 'inventory-roster-setup-codex',
    providers: [providerForRecipe(mustRecipe(), overrides)],
  });
}

function openRouterInventory(): RosterInventory {
  return fakeInventoryFromProviders({
    inventory_id: 'inventory-roster-setup-openrouter',
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
}

function activate(bundle: SetupBundle): string {
  const activation = bundle.controller.activate('unit-test-roster-setup');
  assert.equal(activation.ok, true);
  assert.equal(activation.active, true);
  assert.equal(typeof activation.activation_token, 'string');
  assert.ok((activation.activation_token ?? '').length >= 16);
  return activation.activation_token ?? '';
}

function request(token: string, action: string, overrides: Partial<Record<string, unknown>> = {}): ToolRequest {
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
    original_command: '/autopilot phase37',
    ...overrides,
  };
}

async function invoke(bundle: SetupBundle, input: ToolRequest, ctx?: unknown): Promise<ToolResult> {
  const output = await bundle.tool.execute('tool-call-roster-setup', input, undefined, undefined, ctx);
  assert.equal(output.content.length, 1);
  assert.equal(output.content[0]?.type, 'text');
  assert.ok(Buffer.byteLength(output.content[0]?.text ?? '', 'utf8') <= 48_000);
  return output.details;
}

function codes(result: ToolResult): readonly string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function approvalFields(proposal: ToolResult): {
  readonly candidate_set_sha256: Digest;
  readonly approved_roster_sha256s: readonly Digest[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: Digest;
} {
  const candidateSet = proposal.candidate_set;
  if (candidateSet === null) throw new Error('expected candidate set');
  const defaultCandidate = candidateSet.candidates.find((candidate) => candidate.profile_id === 'cruise') ?? candidateSet.candidates[0];
  if (defaultCandidate === undefined) throw new Error('expected at least one candidate');
  return {
    candidate_set_sha256: candidateSet.candidate_set_sha256,
    approved_roster_sha256s: candidateSet.candidates.map((candidate) => candidate.roster_sha256),
    default_roster_id: defaultCandidate.roster_id,
    default_roster_revision: defaultCandidate.roster_revision,
    default_roster_sha256: defaultCandidate.roster_sha256,
  };
}

function receiptFor(input: {
  readonly proposal: ToolResult;
  readonly approval: ReturnType<typeof approvalFields>;
  readonly original_command: string;
}): Record<string, unknown> {
  const candidateSet = input.proposal.candidate_set;
  if (candidateSet === null) throw new Error('expected candidate set');
  const saved_rosters = candidateSet.candidates.map((candidate) => ({
    roster_id: candidate.roster_id,
    roster_revision: candidate.roster_revision,
    roster_sha256: candidate.roster_sha256,
    assignment_set_sha256: candidate.assignment_set_sha256,
    path: `~/.pi/agent/autopilot/rosters/${candidate.roster_id}/revision-${String(candidate.roster_revision)}.json`,
  }));
  const withoutHash = {
    schema_version: 'autopilot.roster_setup_receipt.v1' as const,
    receipt_id: 'receipt-roster-setup-test',
    scope: 'user' as const,
    saved_rosters,
    default_roster_id: input.approval.default_roster_id,
    default_roster_revision: input.approval.default_roster_revision,
    default_roster_sha256: input.approval.default_roster_sha256,
    approved_candidate_set_sha256: input.approval.candidate_set_sha256,
    approved_roster_sha256s: input.approval.approved_roster_sha256s,
    config_sha256: CONFIG_SHA,
    original_command: input.original_command,
    fresh_session_required: true,
    zero_secrets: true,
    issued_at: PHASE37_FIXTURE_CLOCK,
  };
  return { ...withoutHash, receipt_sha256: canonicalSha256(withoutHash) };
}

void describe('Phase 37 W2 roster setup tool core', () => {
  void it('is inactive by default and enforces one activation token for one setup session', async () => {
    const bundle = createAutopilotRosterSetupTool({ inventory: codexInventory() });
    assert.equal(bundle.tool.name, 'autopilot_manage_rosters');
    assert.equal(bundle.controller.isActive(), false);

    const inactive = await invoke(bundle, request('setup:inactive-token-000000000000000000000000', 'inspect'));
    assert.equal(inactive.ok, false);
    assert.equal(inactive.status, 'blocked');
    assert.deepEqual(codes(inactive), ['ROSTER_TRANSITION_REQUIRED']);
    assert.equal(inactive.write_count, 0);
    assert.equal(inactive.lock_count, 0);

    const token = activate(bundle);
    assert.equal(bundle.controller.currentActivationToken(), token);
    assert.equal(bundle.controller.activate().ok, false);

    const badToken = await invoke(bundle, request('setup:bad-token-00000000000000000000000000', 'inspect'));
    assert.equal(badToken.ok, false);
    assert.deepEqual(codes(badToken), ['ROSTER_TRANSITION_REQUIRED']);

    assert.equal(bundle.controller.deactivate(token), true);
    assert.equal(bundle.controller.isActive(), false);
    assert.equal(bundle.controller.activate().reason, 'already-used');
  });

  void it('fails closed on unknown fields and unknown actions with deterministic result hashes', async () => {
    const bundle = createAutopilotRosterSetupTool({ inventory: codexInventory() });
    const token = activate(bundle);
    const extra = await invoke(bundle, request(token, 'inspect', { surprise: true }));
    const extraAgain = await invoke(bundle, request(token, 'inspect', { surprise: true }));
    assert.equal(extra.ok, false);
    assert.equal(extra.status, 'failed');
    assert.deepEqual(codes(extra), ['ROSTER_READBACK_MISMATCH']);
    assert.equal(extra.result_sha256, extraAgain.result_sha256);

    const unknown = await invoke(bundle, request(token, 'launch-magic'));
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 'failed');
    assert.deepEqual(codes(unknown), ['ROSTER_READBACK_MISMATCH']);
  });

  void it('keeps inspect/propose/refine/doctor/reject zero-write and does not create state roots', async () => {
    await withTempDir(async (dir) => {
      const stateRoot = join(dir, 'state');
      const bundle = createAutopilotRosterSetupTool({ inventory: codexInventory() });
      const token = activate(bundle);
      for (const action of ['inspect', 'propose', 'refine', 'doctor', 'reject']) {
        const result = await invoke(bundle, request(token, action));
        assert.equal(result.write_count, 0, action);
        assert.equal(result.lock_count, 0, action);
        assert.deepEqual(result.files_touched, [], action);
        assert.equal(existsSync(stateRoot), false, action);
      }
      const arbitraryRoot = await invoke(bundle, request(token, 'inspect', { state_root_override: stateRoot }));
      assert.equal(arbitraryRoot.ok, false);
      assert.equal(arbitraryRoot.status, 'failed');
      assert.equal(existsSync(stateRoot), false);
    });
  });

  void it('builds non-secret inventory from ctx.modelRegistry without resolving credentials', async () => {
    const recipe = mustRecipe();
    const models = providerForRecipe(recipe).models.map((model) => ({
      provider: recipe.provider_family,
      id: model.model_id,
      api: model.api,
      reasoning: true,
      thinkingLevelMap: { high: 'high', xhigh: 'xhigh' },
      input: ['text', 'image'],
      contextWindow: model.context_window,
      maxTokens: model.max_output_tokens,
    }));
    let authStatusCalls = 0;
    const ctx = {
      modelRegistry: {
        getAll: () => models,
        getProviderAuthStatus(provider: string) {
          assert.equal(provider, 'openai-codex');
          authStatusCalls += 1;
          return { configured: true, source: 'stored' };
        },
        isUsingOAuth: () => true,
        getApiKeyAndHeaders: () => {
          throw new Error('credential resolution must not be called');
        },
        getApiKeyForProvider: () => {
          throw new Error('credential resolution must not be called');
        },
      },
      isProjectTrusted: () => true,
    };
    const bundle = createAutopilotRosterSetupTool();
    const token = activate(bundle);
    const result = await invoke(bundle, request(token, 'propose'), ctx);

    assert.equal(authStatusCalls > 0, true);
    assert.equal(result.status, 'blocked');
    assert.ok((result.candidate_set?.candidates.length ?? 0) > 0);
    assert.ok(codes(result).includes('ROSTER_QUALIFICATION_REQUIRED'));
    assert.equal(JSON.stringify(result).includes('credential'), false);
  });

  void it('reports OpenRouter as forbidden without inferred provider mapping', async () => {
    const bundle = createAutopilotRosterSetupTool({ inventory: openRouterInventory() });
    const token = activate(bundle);
    const result = await invoke(bundle, request(token, 'propose'));

    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(codes(result), ['ROSTER_AUTH_CHANNEL_FORBIDDEN', 'ROSTER_ROUTE_FORBIDDEN']);
    assert.deepEqual(result.candidate_set?.candidates, []);
    assert.equal(result.write_count, 0);
  });

  void it('keeps W0 seed candidates blocked and reports convergence honestly', async () => {
    const bundle = createAutopilotRosterSetupTool({ inventory: codexInventory() });
    const token = activate(bundle);
    const result = await invoke(bundle, request(token, 'propose'));

    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.ok((result.candidate_set?.candidates.length ?? 0) >= 2);
    assert.equal(result.candidate_set?.candidates.every((candidate) => candidate.launch_readiness !== 'synthetic-fixture-only'), true);
    assert.ok(codes(result).includes('ROSTER_QUALIFICATION_REQUIRED'));
    assert.ok(codes(result).includes('ROSTER_CONVERGED_ASSIGNMENT_SET'));
  });

  void it('rejects stale save approvals before calling the injected save capability', async () => {
    let saveCalls = 0;
    const bundle = createAutopilotRosterSetupTool({
      inventory: codexInventory(),
      saveApproved: () => {
        saveCalls += 1;
        throw new Error('save must not be reached for stale candidate hashes');
      },
    });
    const token = activate(bundle);
    const proposal = await invoke(bundle, request(token, 'propose'));
    const approval = approvalFields(proposal);
    const stale = await invoke(bundle, request(token, 'save', {
      ...approval,
      candidate_set_sha256: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      approved_roster_sha256s: approval.approved_roster_sha256s,
    }));

    assert.equal(stale.ok, false);
    assert.equal(stale.status, 'blocked');
    assert.deepEqual(codes(stale), ['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
    assert.equal(stale.write_count, 0);
    assert.equal(stale.lock_count, 0);
    assert.equal(saveCalls, 0);
  });

  void it('requires exact host authorization but still blocks unlaunchable W0 candidates before delegated save', async () => {
    let saveCalls = 0;
    const bundle = createAutopilotRosterSetupTool({
      inventory: codexInventory(),
      saveApproved: () => {
        saveCalls += 1;
        throw new Error('unlaunchable candidates must not reach materialization');
      },
    });
    const token = activate(bundle);
    const proposal = await invoke(bundle, request(token, 'propose'));
    const approval = approvalFields(proposal);

    const bypass = await invoke(bundle, request(token, 'save', approval));
    assert.equal(bypass.ok, false);
    assert.deepEqual(codes(bypass), ['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
    assert.equal(saveCalls, 0);

    const presentationText = renderRosterSetupApprovalPresentation({ scope: 'user', original_command: '/autopilot phase37', ...approval });
    const extensionSource = bundle.hostAuthorization.authorizeInput({ activation_token: token, source: 'extension', text: presentationText });
    assert.equal(extensionSource.ok, false);
    assert.equal(extensionSource.reason, 'source-not-user');

    const approved = bundle.hostAuthorization.authorizeInput({ activation_token: token, source: 'user', text: presentationText });
    assert.equal(approved.ok, true);
    assert.equal(typeof approved.approval_token, 'string');
    const duplicate = bundle.hostAuthorization.authorizeInput({ activation_token: token, source: 'user', text: presentationText });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.reason, 'duplicate-authorization');

    const saved = await invoke(bundle, request(token, 'save', { ...approval, approval_token: approved.approval_token }));
    assert.equal(saved.ok, false);
    assert.equal(saved.status, 'blocked');
    assert.ok(codes(saved).includes('ROSTER_QUALIFICATION_REQUIRED'));
    assert.equal(saved.write_count, 0);
    assert.equal(saved.lock_count, 0);
    assert.equal(saveCalls, 0);
  });

  void it('redacts inventory failures and unlaunchable save blocks from secret-free results', async () => {
    const secret = 'phase37-secret-token-should-not-appear';
    const inventoryFailure = createAutopilotRosterSetupTool({
      inventory: () => {
        throw new Error(`inventory parser leaked ${secret}`);
      },
    });
    const token = activate(inventoryFailure);
    const result = await invoke(inventoryFailure, request(token, 'inspect'));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.deepEqual(codes(result), ['ROSTER_READBACK_MISMATCH']);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes('inventory parser leaked'), false);

    const saveFailure = createAutopilotRosterSetupTool({
      inventory: codexInventory(),
      saveApproved: () => {
        throw new Error(`save leaked ${secret}`);
      },
    });
    const saveToken = activate(saveFailure);
    const proposal = await invoke(saveFailure, request(saveToken, 'propose'));
    const approval = approvalFields(proposal);
    const presentationText = renderRosterSetupApprovalPresentation({ scope: 'user', original_command: '/autopilot phase37', ...approval });
    const approved = saveFailure.hostAuthorization.authorizeInput({ activation_token: saveToken, source: 'user', text: presentationText });
    assert.equal(approved.ok, true);
    const saveResult = await invoke(saveFailure, request(saveToken, 'save', { ...approval, approval_token: approved.approval_token }));
    assert.equal(saveResult.ok, false);
    assert.ok(codes(saveResult).includes('ROSTER_QUALIFICATION_REQUIRED'));
    assert.equal(JSON.stringify(saveResult).includes(secret), false);
  });

  void it('blocks trusted-project operations when project trust is unavailable', async () => {
    const bundle = createAutopilotRosterSetupTool({ inventory: codexInventory() });
    const token = activate(bundle);
    const ctx = { isProjectTrusted: () => false };
    const inspect = await invoke(bundle, request(token, 'inspect', { scope: 'trusted-project', trusted_project_root: '/tmp/project' }), ctx);
    assert.equal(inspect.ok, false);
    assert.deepEqual(codes(inspect), ['ROSTER_PROJECT_UNTRUSTED']);
    const save = await invoke(bundle, request(token, 'save', { scope: 'trusted-project', trusted_project_root: '/tmp/project' }), ctx);
    assert.equal(save.ok, false);
    assert.deepEqual(codes(save), ['ROSTER_STORAGE_TRUST_REQUIRED']);
    assert.equal(save.write_count, 0);
  });

  void it('materializes closed result hashes for every successful dispatch path', async () => {
    const bundle = createAutopilotRosterSetupTool({ inventory: openRouterInventory() });
    const token = activate(bundle);
    for (const action of ['inspect', 'doctor', 'propose', 'reject']) {
      const result = await invoke(bundle, request(token, action));
      const preimage = { ...result } as Record<string, unknown>;
      delete preimage['result_sha256'];
      assert.equal(result.result_sha256, canonicalSha256(preimage));
      assert.equal(result.schema_version, 'autopilot.roster_tool_result.v1');
      assert.equal(result.write_count, 0);
      assert.equal(result.lock_count, 0);
      assert.deepEqual(result.files_touched, []);
    }
    assert.equal(ZERO_SHA.startsWith('sha256:'), true);
  });
});
