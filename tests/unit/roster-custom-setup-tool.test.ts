import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAutopilotRosterContract } from '../../src/core/roster/contracts.ts';
import { canonicalSha256 } from '../../src/core/roster/route-policies.ts';
import { createAutopilotRosterSetupTool, parseCustomRosterProposalV2 } from '../../src/core/roster/setup-tool.ts';
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

const CUSTOM_NATURAL_TEXT = 'Use a mixed Kimi/ZAI plan-token custom roster with Kimi for strategy and ZAI for implementation/fix/adjudication.';

void describe('W5 custom roster setup tool boundary', () => {
  void it('builds an ordinary-language v2 custom/mixed proposal from explicit role intent with zero writes and no text leakage', async () => {
    const bundle = createAutopilotRosterSetupTool({ inventory: mixedInventory() });
    const token = activate(bundle);
    const result = await invoke(bundle, customV2ProposeRequest(token));

    assert.equal(result.schema_version, 'autopilot.roster_tool_result.v2');
    if (result.schema_version !== 'autopilot.roster_tool_result.v2') throw new Error('expected v2 result');
    assert.equal(result.action, 'propose-custom');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.equal(result.write_count, 0);
    assert.equal(result.lock_count, 0);
    assert.deepEqual(result.files_touched, []);
    assert.equal(result.custom_validation?.structural_status, 'structurally-valid-draft');
    assert.equal(result.custom_validation?.certification_status, 'absent');
    assert.equal(result.custom_validation?.mixed_provider_roster, true);
    assert.deepEqual(result.custom_validation?.provider_ids, ['kimi-coding', 'zai']);
    assert.equal(result.custom_roster?.generation_source, 'user-custom');
    assert.equal(result.custom_proposal?.validation_result_sha256, result.custom_validation?.result_sha256);
    assert.equal(result.custom_proposal?.roster_sha256, result.custom_roster?.roster_sha256);
    assert.equal(parseCustomRosterProposalV2(result.custom_proposal)?.proposal_sha256, result.custom_proposal?.proposal_sha256);
    assert.equal(parseCustomRosterProposalV2({ ...result.custom_proposal, future_candidate_branch: {} }), null);
    assert.equal(result.approval_binding?.custom_proposal_sha256, result.custom_proposal?.proposal_sha256);
    assert.equal(result.approval_binding?.validation_result_sha256, result.custom_validation?.result_sha256);
    assert.equal(result.approval_binding?.roster_sha256, result.custom_roster?.roster_sha256);
    assert.equal(result.approval_binding?.manifest_sha256, null);
    assert.equal(result.approval_binding?.approval_sha256, customApprovalSha256FromBinding(result.approval_binding));
    const parsedCandidateSet = parseAutopilotRosterContract('autopilot.roster_candidate_set.v1', result.candidate_set);
    assert.equal(parsedCandidateSet.candidates[0]?.readiness_authority, null);
    assert.equal(JSON.stringify(result).includes(CUSTOM_NATURAL_TEXT), false);

    const presentation = bundle.hostAuthorization.currentApprovalPresentation();
    assert.notEqual(presentation, null);
    assert.equal(presentation?.schema_version, 'autopilot.roster_tool_request.v2');
    assert.equal(presentation?.presentation_text.includes(CUSTOM_NATURAL_TEXT), false);
    assert.match(presentation?.presentation_text ?? '', /custom_proposal_sha256/u);
    assert.match(presentation?.presentation_text ?? '', /validation_result_sha256/u);
    assert.match(presentation?.presentation_text ?? '', /approval_sha256/u);
    assert.match(presentation?.presentation_text ?? '', /Structural custom validation is not launch-ready/u);
  });

  void it('rejects unknown v2 fields and keeps v1 custom payload rejection unchanged', async () => {
    const bundle = createAutopilotRosterSetupTool({ inventory: mixedInventory() });
    const token = activate(bundle);

    const unknownTopLevel = await invoke(bundle, { ...customV2ProposeRequest(token), surprise: true });
    assert.equal(unknownTopLevel.schema_version, 'autopilot.roster_tool_result.v2');
    assert.equal(unknownTopLevel.ok, false);
    assert.equal(unknownTopLevel.status, 'failed');
    assert.equal(unknownTopLevel.write_count, 0);

    const input = customV2ProposeRequest(token);
    const custom = input['custom_roster_request'] as Record<string, unknown>;
    const unknownPayload = await invoke(bundle, { ...input, custom_roster_request: { ...custom, surprise: true } });
    assert.equal(unknownPayload.schema_version, 'autopilot.roster_tool_result.v2');
    if (unknownPayload.schema_version !== 'autopilot.roster_tool_result.v2') throw new Error('expected v2 result');
    assert.equal(unknownPayload.custom_validation?.status, 'failed');
    assert.deepEqual(codes(unknownPayload), ['ROSTER_CUSTOM_REQUEST_SCHEMA_INVALID']);

    const v1 = await invoke(bundle, request(token, 'propose', {
      natural_language_request: CUSTOM_NATURAL_TEXT,
      custom_roster: { draft: true },
    }));
    assert.equal(v1.schema_version, 'autopilot.roster_tool_result.v1');
    assert.equal(v1.status, 'blocked');
    assert.deepEqual(codes(v1), ['ROSTER_CUSTOM_ROSTER_UNSUPPORTED']);
  });

  void it('exposes a closed v2 schema for custom request, role intent, approval, and null action branches', () => {
    const bundle = createAutopilotRosterSetupTool({ inventory: mixedInventory() });
    const schema = bundle.tool.parameters as Record<string, unknown>;
    const branches = schema['oneOf'] as readonly Record<string, unknown>[];
    assert.equal(branches.length, 4);
    const propose = branchForAction(branches, 'propose-custom');
    const save = branchForAction(branches, 'save');
    const reject = branchForAction(branches, 'reject');
    const proposeProperties = propose['properties'] as Record<string, Record<string, unknown>>;
    const customRequest = proposeProperties['custom_roster_request'] as Record<string, unknown>;
    assert.equal(customRequest['additionalProperties'], false);
    const customRequestProperties = customRequest['properties'] as Record<string, Record<string, unknown>>;
    const roleIntent = customRequestProperties['role_assignment_intent'] as Record<string, unknown>;
    const roleItem = roleIntent['items'] as Record<string, unknown>;
    assert.equal(roleItem['additionalProperties'], false);
    assert.deepEqual(proposeProperties['custom_roster_approval'], { type: 'null' });
    const saveProperties = save['properties'] as Record<string, Record<string, unknown>>;
    const approval = saveProperties['custom_roster_approval'] as Record<string, unknown>;
    assert.equal(approval['additionalProperties'], false);
    assert.deepEqual(saveProperties['custom_roster_request'], { type: 'null' });
    const rejectProperties = reject['properties'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(rejectProperties['custom_roster_request'], { type: 'null' });
    assert.deepEqual(rejectProperties['custom_roster_approval'], { type: 'null' });
  });

  void it('binds v2 approval to proposal/validation/roster/manifest and blocks untrusted custom save before storage, including stale and replay attempts', async () => {
    let saveCalls = 0;
    const bundle = createAutopilotRosterSetupTool({
      inventory: mixedInventory(),
      saveApproved: () => {
        saveCalls += 1;
        throw new Error('untrusted custom save must not delegate to storage');
      },
    });
    const token = activate(bundle);
    const proposed = await invoke(bundle, customV2ProposeRequest(token));
    if (proposed.schema_version !== 'autopilot.roster_tool_result.v2' || proposed.candidate_set === null || proposed.approval_binding === null || proposed.custom_roster === null) {
      throw new Error('expected custom proposal');
    }
    const authorized = bundle.hostAuthorization.authorizeInput({ activation_token: token, source: 'user', text: 'I approve this exact custom presentation.' });
    assert.equal(authorized.ok, true);
    if (authorized.approval_token === null) throw new Error('missing approval token');

    const forged = await invoke(bundle, customV2SaveRequest(token, authorized.approval_token, proposed, {
      validation_result_sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }));
    assert.equal(forged.schema_version, 'autopilot.roster_tool_result.v2');
    assert.equal(forged.ok, false);
    assert.equal(forged.status, 'blocked');
    assert.equal(forged.write_count, 0);
    assert.equal(saveCalls, 0);

    const blocked = await invoke(bundle, customV2SaveRequest(token, authorized.approval_token, proposed));
    assert.equal(blocked.schema_version, 'autopilot.roster_tool_result.v2');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.write_count, 0);
    assert.equal(blocked.lock_count, 0);
    assert.deepEqual(blocked.files_touched, []);
    assert.equal(codes(blocked).includes('ROSTER_QUALIFICATION_REQUIRED'), true);
    assert.equal(saveCalls, 0);

    const replay = await invoke(bundle, customV2SaveRequest(token, authorized.approval_token, proposed));
    assert.equal(replay.schema_version, 'autopilot.roster_tool_result.v2');
    assert.equal(replay.ok, false);
    assert.equal(replay.status, 'blocked');
    assert.equal(replay.write_count, 0);
    assert.equal(saveCalls, 0);
  });

  void it('reacquires current inventory on custom save and blocks model drift before storage', async () => {
    let saveCalls = 0;
    let currentInventory: RosterInventory = mixedInventory();
    const bundle = createAutopilotRosterSetupTool({
      inventory: () => currentInventory,
      saveApproved: () => {
        saveCalls += 1;
        throw new Error('inventory drift must not delegate to storage');
      },
    });
    const token = activate(bundle);
    const proposed = await invoke(bundle, customV2ProposeRequest(token));
    if (proposed.schema_version !== 'autopilot.roster_tool_result.v2' || proposed.candidate_set === null || proposed.approval_binding === null || proposed.custom_roster === null) {
      throw new Error('expected custom proposal');
    }
    const authorized = bundle.hostAuthorization.authorizeInput({ activation_token: token, source: 'user', text: 'I approve this exact custom presentation before drift.' });
    assert.equal(authorized.ok, true);
    if (authorized.approval_token === null) throw new Error('missing approval token');

    currentInventory = kimiInventory();
    const drifted = await invoke(bundle, customV2SaveRequest(token, authorized.approval_token, proposed));
    assert.equal(drifted.schema_version, 'autopilot.roster_tool_result.v2');
    assert.equal(drifted.ok, false);
    assert.equal(drifted.status, 'blocked');
    assert.deepEqual(codes(drifted), ['ROSTER_APPROVAL_STALE_CANDIDATE_SET']);
    assert.equal(drifted.write_count, 0);
    assert.equal(drifted.lock_count, 0);
    assert.deepEqual(drifted.files_touched, []);
    assert.equal(saveCalls, 0);
  });

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

function customV2ProposeRequest(token: string): Record<string, unknown> {
  return {
    schema_version: 'autopilot.roster_tool_request.v2',
    action: 'propose-custom',
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
    custom_roster_request: {
      schema_version: 'autopilot.custom_roster_request.v2',
      request_id: 'custom-mixed-plan-request',
      natural_language_request: CUSTOM_NATURAL_TEXT,
      profile_id: 'precision',
      role_assignment_intent: mixedRoleIntent(),
      qualification_manifest: null,
    },
    custom_roster_approval: null,
  };
}

function customV2SaveRequest(
  token: string,
  approvalToken: string,
  proposed: Extract<ToolResult, { readonly schema_version: 'autopilot.roster_tool_result.v2' }>,
  approvalOverrides: Partial<Record<'custom_proposal_sha256' | 'validation_result_sha256' | 'roster_sha256' | 'manifest_sha256' | 'approval_sha256', unknown>> = {},
): Record<string, unknown> {
  if (proposed.candidate_set === null || proposed.custom_roster === null || proposed.approval_binding === null) throw new Error('proposal missing save facts');
  const approvalBase = {
    custom_proposal_sha256: proposed.approval_binding.custom_proposal_sha256,
    validation_result_sha256: proposed.approval_binding.validation_result_sha256,
    roster_sha256: proposed.approval_binding.roster_sha256,
    manifest_sha256: proposed.approval_binding.manifest_sha256,
    ...approvalOverrides,
  };
  const customApproval = {
    schema_version: 'autopilot.custom_roster_approval.v2',
    ...approvalBase,
    approval_sha256: approvalOverrides.approval_sha256 ?? customApprovalSha256FromBinding(approvalBase),
  };
  return {
    schema_version: 'autopilot.roster_tool_request.v2',
    action: 'save',
    activation_token: token,
    approval_token: approvalToken,
    scope: 'user',
    trusted_project_root: null,
    candidate_set_sha256: proposed.candidate_set.candidate_set_sha256,
    approved_roster_sha256s: [proposed.custom_roster.roster_sha256],
    default_roster_id: proposed.custom_roster.roster_id,
    default_roster_revision: proposed.custom_roster.roster_revision,
    default_roster_sha256: proposed.custom_roster.roster_sha256,
    original_command: '/autopilot phase37 custom',
    custom_roster_request: null,
    custom_roster_approval: customApproval,
  };
}

function branchForAction(branches: readonly Record<string, unknown>[], action: string): Record<string, unknown> {
  const branch = branches.find((entry) => {
    const properties = entry['properties'] as Record<string, Record<string, unknown>> | undefined;
    const actionSchema = properties?.['action'];
    const schemaVersion = properties?.['schema_version'];
    return Array.isArray(actionSchema?.['enum']) &&
      (actionSchema['enum'] as readonly unknown[]).includes(action) &&
      Array.isArray(schemaVersion?.['enum']) &&
      (schemaVersion['enum'] as readonly unknown[]).includes('autopilot.roster_tool_request.v2');
  });
  if (branch === undefined) throw new Error(`missing schema branch ${action}`);
  return branch;
}

function customApprovalSha256FromBinding(value: {
  readonly custom_proposal_sha256?: unknown;
  readonly validation_result_sha256?: unknown;
  readonly roster_sha256?: unknown;
  readonly manifest_sha256?: unknown;
} | null | undefined): string {
  if (value === null || value === undefined) throw new Error('missing approval binding');
  return canonicalSha256({
    schema_version: 'autopilot.custom_roster_approval.v2',
    custom_proposal_sha256: value.custom_proposal_sha256,
    validation_result_sha256: value.validation_result_sha256,
    roster_sha256: value.roster_sha256,
    manifest_sha256: value.manifest_sha256,
  });
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

function mixedInventory(): RosterInventory {
  return fakeInventoryFromProviders({
    inventory_id: 'inventory-w5-custom-setup-tool-mixed',
    providers: [providerForRecipe(mustRecipe('kimi-coding-plan')), providerForRecipe(mustRecipe('zai-coding-plan'))],
  });
}

function mixedRoleIntent(): readonly Record<string, unknown>[] {
  const kimi = mustRecipe('kimi-coding-plan');
  const zai = mustRecipe('zai-coding-plan');
  return ['parent', 'strategy', 'implement', 'validate', 'fix', 'adjudicate', 'bughunt', 'extract'].map((role) => {
    const recipe = role === 'implement' || role === 'fix' || role === 'adjudicate' ? zai : kimi;
    const profile = recipe.profile_templates.find((entry) => entry.profile_id === 'precision');
    if (profile === undefined) throw new Error('missing precision profile');
    const template = profile.role_templates.find((entry) => entry.role === role);
    if (template === undefined) throw new Error(`missing role ${role}`);
    return {
      role,
      provider_id: recipe.provider_family,
      model_id: template.model_id,
      api: template.api,
      thinking: template.thinking,
      service_tier: template.service_tier,
      cache_policy: template.cache_policy,
      system_prompt_profile: template.system_prompt_profile,
    };
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
