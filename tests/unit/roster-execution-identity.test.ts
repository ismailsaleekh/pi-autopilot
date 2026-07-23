import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildAutopilotObservedProfile,
  buildAutopilotProviderIdentityFromRequestProfile,
  buildAutopilotReceiptV2,
  buildAutopilotRosterExecutionIdentity,
  buildAutopilotStatusToolContext,
  lowerAutopilotUnitSpecV2ToV1,
  parseAutopilotStatusToolContext,
  providerIdentityFromObservedProfile,
  type AutopilotObservedExecutionEvidence,
} from '../../src/core/forced-output/index.ts';
import {
  computeAutopilotRosterContractObjectHash,
  parseAutopilotReceiptV2,
  parseAutopilotUnitSpecV2,
  type AutopilotRosterRequestProfileV1,
  type AutopilotUnitSpecV2,
} from '../../src/core/contracts/index.ts';

void describe('Phase 37 W3 roster execution identity', () => {
  void it('binds pinned roster identity and full request profile into the status context hash', async () => {
    await withTempDir(async (root) => {
      const requestProfile = makeRequestProfile();
      const unitV2 = parseAutopilotUnitSpecV2(makeUnitSpecV2(root, requestProfile));
      const lowered = lowerAutopilotUnitSpecV2ToV1(unitV2);
      const rosterIdentity = buildAutopilotRosterExecutionIdentity(unitV2);
      const providerIdentity = buildAutopilotProviderIdentityFromRequestProfile(requestProfile);
      const context = buildAutopilotStatusToolContext({ unitSpec: lowered, providerIdentity, rosterExecutionIdentity: rosterIdentity });

      assert.equal(context.receipt_schema_version, 'autopilot.receipt.v2');
      assert.equal(context.roster_execution_identity?.roster_id, unitV2.roster_id);
      assert.equal(context.roster_execution_identity?.request_profile.request_profile_sha256, requestProfile.request_profile_sha256);
      assert.equal(context.provider_identity.requested_model_id, requestProfile.model_id);

      const parsedContext = parseAutopilotStatusToolContext(JSON.parse(JSON.stringify(context)) as unknown);
      assert.deepEqual(parsedContext, context);

      const changedIdentity = { ...rosterIdentity, assignment_sha256: sha('b') };
      const changedContext = buildAutopilotStatusToolContext({ unitSpec: lowered, providerIdentity, rosterExecutionIdentity: changedIdentity });
      assert.notEqual(changedContext.expected_identity_hash, context.expected_identity_hash);
    });
  });

  void it('builds observed profile hashes from actual evidence and reports executed model drift', () => {
    const requestProfile = makeRequestProfile();
    const observed = buildAutopilotObservedProfile(observedEvidence(requestProfile));
    assert.equal(observed.request_profile_sha256, requestProfile.request_profile_sha256);
    assert.match(observed.observed_profile_sha256, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(providerIdentityFromObservedProfile(observed).executed_model_id, requestProfile.model_id);

    const drifted = buildAutopilotObservedProfile({ ...observedEvidence(requestProfile), executed_model_id: 'claude-opus-4-9' });
    assert.notEqual(drifted.executed_model_id, requestProfile.model_id);
  });

  void it('materializes parseable receipt.v2 with observed profile hashes separate from request pins', async () => {
    await withTempDir(async (root) => {
      const requestProfile = makeRequestProfile();
      const unitV2 = parseAutopilotUnitSpecV2(makeUnitSpecV2(root, requestProfile));
      const lowered = lowerAutopilotUnitSpecV2ToV1(unitV2);
      const rosterIdentity = buildAutopilotRosterExecutionIdentity(unitV2);
      const observedProfile = buildAutopilotObservedProfile(observedEvidence(requestProfile));
      const receipt = buildAutopilotReceiptV2({
        unitSpec: lowered,
        emittedAt: '2026-07-23T00:00:00.000Z',
        statusSha256: sha('status'),
        schemaSha256: sha('schema'),
        toolCallId: 'call-roster-identity-1',
        providerIdentity: providerIdentityFromObservedProfile(observedProfile),
        expectedIdentityHash: sha('identity'),
        rosterExecutionIdentity: rosterIdentity,
        observedProfile,
      });

      assert.equal(parseAutopilotReceiptV2(receipt).schema_version, 'autopilot.receipt.v2');
      assert.equal(receipt.roster_sha256, unitV2.roster_sha256);
      assert.equal(receipt.assignment_sha256, unitV2.assignment_sha256);
      assert.equal(receipt.request_profile.request_profile_sha256, requestProfile.request_profile_sha256);
      assert.equal(receipt.observed_profile.request_profile_sha256, requestProfile.request_profile_sha256);
      assert.equal(receipt.observed_profile.system_prompt_sha256, observedProfile.system_prompt_sha256);
    });
  });
});

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-roster-identity-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeUnitSpecV2(root: string, requestProfile: AutopilotRosterRequestProfileV1): AutopilotUnitSpecV2 {
  const runtimeRoot = join(root, 'worktree', '.pi', 'autopilot', 'rosterw3');
  return {
    schema_version: 'autopilot.unit_spec.v2',
    workstream: 'rosterw3',
    unit_id: 'u01validate',
    role: 'validate',
    template: 'validate',
    attempt: 1,
    objective: 'Validate roster execution identity.',
    cwd: join(root, 'worktree'),
    model: requestProfile.model,
    thinking: requestProfile.thinking,
    owned_paths: [],
    read_only_paths: ['src/index.ts'],
    untouchable_paths: [],
    context_refs: [
      { path: '.pi/autopilot/rosterw3/mission.md', purpose: 'Mission', sha256: null, byte_count: null },
      { path: '.pi/autopilot/rosterw3/master-plan.json', purpose: 'Plan', sha256: null, byte_count: null },
    ],
    validation_commands: ['true'],
    status_output: join(runtimeRoot, 'statuses', 'u01validate.validate.attempt-1.json'),
    receipt_output: join(runtimeRoot, 'receipts', 'u01validate.validate.attempt-1.receipt.json'),
    evidence_dir: join(runtimeRoot, 'evidence', 'u01validate'),
    stop_boundary: 'Validate only.',
    quality_profile: 'validation-only',
    risk_level: 'low',
    acceptance_criteria: ['identity validated'],
    verification_plan: verificationPlan(),
    closure_criteria: ['done'],
    upstream_refs: [],
    timeout_seconds: 60,
    render_prompt_snapshot: false,
    roster_id: 'anthropicroster',
    roster_revision: 1,
    roster_sha256: sha('roster'),
    assignment_sha256: sha('assignment'),
    pre_run_selection_sha256: sha('selection'),
    request_profile: requestProfile,
  };
}

function verificationPlan(): AutopilotUnitSpecV2['verification_plan'] {
  return {
    positive_witnesses: [{ id: 'positive-validation-command', command: 'true', expected_signal: 'passes', required: true }],
    negative_witnesses: [],
    regression_witnesses: [],
    real_boundary_witnesses: [],
    blast_radius_checks: [],
    docs_schema_prompt_checks: [],
    dirty_tree_checks: [],
  };
}

function makeRequestProfile(): AutopilotRosterRequestProfileV1 {
  const preimage = {
    provider_id: 'anthropic',
    model_id: 'claude-sonnet-4-5',
    model: 'anthropic/claude-sonnet-4-5',
    api: 'anthropic-messages' as const,
    thinking: 'xhigh' as const,
    service_tier: null,
    cache_policy: 'provider-default' as const,
    system_prompt_profile: 'anthropic-autopilot-sanitized.v1' as const,
    context_window: 200000,
    max_output_tokens: 64000,
    input_modalities: ['text'] as const,
    output_modalities: ['text'] as const,
    reasoning_capability: 'reasoning-supported' as const,
    tool_capability: 'tool-use-supported' as const,
    route_policy_id: 'anthropic-subscription-v1',
    route_policy_revision: 1,
  };
  return { ...preimage, request_profile_sha256: requiredHash('autopilot.request_profile.v1', preimage) };
}

function observedEvidence(requestProfile: AutopilotRosterRequestProfileV1): AutopilotObservedExecutionEvidence {
  return {
    provider_id: requestProfile.provider_id,
    requested_model_id: requestProfile.model_id,
    executed_model_id: requestProfile.model_id,
    api: requestProfile.api,
    thinking: requestProfile.thinking,
    service_tier: requestProfile.service_tier,
    cache_policy: requestProfile.cache_policy,
    system_prompt_profile: requestProfile.system_prompt_profile,
    system_prompt_sha256: sha('system-prompt'),
    route_policy_id: requestProfile.route_policy_id,
    route_policy_revision: requestProfile.route_policy_revision,
    request_profile_sha256: requestProfile.request_profile_sha256 as `sha256:${string}`,
    final_model_metadata: { provider: requestProfile.provider_id, model: requestProfile.model_id, api: requestProfile.api },
  };
}

function requiredHash(schemaVersion: Parameters<typeof computeAutopilotRosterContractObjectHash>[0], value: unknown): `sha256:${string}` {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
  if (hash === null) throw new Error(`${schemaVersion} has no hash field`);
  return hash as `sha256:${string}`;
}

function sha(label: string): `sha256:${string}` {
  return `sha256:${Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64)}` as `sha256:${string}`;
}
