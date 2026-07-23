import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AutopilotForcedOutputEvidenceError,
  buildAutopilotObservedProfile,
  buildAutopilotProviderIdentityFromRequestProfile,
  buildAutopilotRosterExecutionIdentity,
  buildAutopilotStatusToolContext,
  emitAutopilotStatus,
  lowerAutopilotUnitSpecV2ToV1,
  validateAutopilotStatusEvidence,
  type AutopilotObservedExecutionEvidence,
} from '../../src/core/forced-output/index.ts';
import {
  computeAutopilotRosterContractObjectHash,
  parseAutopilotReceiptV2,
  parseAutopilotUnitSpecV2,
  type AutopilotRosterRequestProfileV1,
  type AutopilotStatusEntry,
  type AutopilotUnitSpecV2,
} from '../../src/core/contracts/index.ts';

void describe('roster forced-output execution identity', () => {
  void it('fails closed on missing observed receipt.v2 execution evidence, then finalizes with observed profile hashes', async () => {
    await withTempDir(async (root) => {
      const { lowered, rosterIdentity, requestProfile, providerIdentity } = makeRuntime(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: lowered, providerIdentity, rosterExecutionIdentity: rosterIdentity });
      const emitted = emitAutopilotStatus(context, makeStatus(lowered), 'call-roster-forced-output-1');
      assert.equal(emitted.receipt.schema_version, 'autopilot.receipt.v2');
      const provisionalReceiptText = await readFile(lowered.receipt_output, 'utf8');

      await assert.rejects(
        () => validateAutopilotStatusEvidence({ unitSpec: lowered, providerIdentity, rosterExecutionIdentity: rosterIdentity }),
        (error: unknown) => error instanceof AutopilotForcedOutputEvidenceError &&
          error.code === 'receipt-identity-mismatch' &&
          /missing observed execution identity evidence/u.test(error.message),
      );

      const observedExecution = observedEvidence(requestProfile);
      const evidence = await validateAutopilotStatusEvidence({
        unitSpec: lowered,
        providerIdentity,
        rosterExecutionIdentity: rosterIdentity,
        observedExecution,
      });
      assert.equal(evidence.receipt.schema_version, 'autopilot.receipt.v2');
      assert.deepEqual(evidence.finalModelMetadata, observedExecution.final_model_metadata);
      const finalReceiptText = await readFile(lowered.receipt_output, 'utf8');
      assert.notEqual(finalReceiptText, provisionalReceiptText);
      const receipt = parseAutopilotReceiptV2(JSON.parse(finalReceiptText) as unknown);
      assert.equal(receipt.observed_profile.system_prompt_sha256, observedExecution.system_prompt_sha256);
      assert.equal(receipt.observed_profile.observed_profile_sha256, buildAutopilotObservedProfile(observedExecution).observed_profile_sha256);
    });
  });

  void it('rejects requested versus observed executed-model mismatch instead of trusting the request receipt', async () => {
    await withTempDir(async (root) => {
      const { lowered, rosterIdentity, requestProfile, providerIdentity } = makeRuntime(root);
      const context = buildAutopilotStatusToolContext({ unitSpec: lowered, providerIdentity, rosterExecutionIdentity: rosterIdentity });
      emitAutopilotStatus(context, makeStatus(lowered), 'call-roster-forced-output-2');

      await assert.rejects(
        () => validateAutopilotStatusEvidence({
          unitSpec: lowered,
          providerIdentity,
          rosterExecutionIdentity: rosterIdentity,
          observedExecution: { ...observedEvidence(requestProfile), executed_model_id: 'gpt-5.6-terra' },
        }),
        (error: unknown) => error instanceof AutopilotForcedOutputEvidenceError &&
          error.code === 'receipt-identity-mismatch' &&
          /executed_model_id mismatch/u.test(error.message),
      );
    });
  });
});

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'autopilot-roster-forced-output-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeRuntime(root: string): {
  readonly lowered: ReturnType<typeof lowerAutopilotUnitSpecV2ToV1>;
  readonly rosterIdentity: ReturnType<typeof buildAutopilotRosterExecutionIdentity>;
  readonly requestProfile: AutopilotRosterRequestProfileV1;
  readonly providerIdentity: ReturnType<typeof buildAutopilotProviderIdentityFromRequestProfile>;
} {
  const requestProfile = makeRequestProfile();
  const unitV2 = parseAutopilotUnitSpecV2(makeUnitSpecV2(root, requestProfile));
  const lowered = lowerAutopilotUnitSpecV2ToV1(unitV2);
  const rosterIdentity = buildAutopilotRosterExecutionIdentity(unitV2);
  const providerIdentity = buildAutopilotProviderIdentityFromRequestProfile(requestProfile);
  return { lowered, rosterIdentity, requestProfile, providerIdentity };
}

function makeStatus(spec: ReturnType<typeof lowerAutopilotUnitSpecV2ToV1>): AutopilotStatusEntry {
  return {
    schema_version: 'autopilot.status.v1',
    workstream: spec.workstream,
    unit_id: spec.unit_id,
    role: spec.role,
    attempt: spec.attempt,
    verdict: 'PASS',
    severity: 'clean',
    summary: 'Roster forced-output validation passed.',
    changed_paths: [],
    findings: [],
    commands: [{ command: 'true', status: 'passed', exit_code: 0, summary: 'true passed' }],
    evidence_refs: [],
    report_ref: null,
    covered_witness_ids: ['positive-validation-command'],
    next_action: 'accept receipt.v2',
  };
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
    objective: 'Validate roster forced output.',
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
    acceptance_criteria: ['forced output validated'],
    verification_plan: verificationPlan(),
    closure_criteria: ['receipt accepted'],
    upstream_refs: [],
    timeout_seconds: 60,
    render_prompt_snapshot: false,
    roster_id: 'codexroster',
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
    provider_id: 'openai-codex',
    model_id: 'gpt-5.6-sol',
    model: 'openai-codex/gpt-5.6-sol',
    api: 'openai-codex-responses' as const,
    thinking: 'xhigh' as const,
    service_tier: null,
    cache_policy: 'provider-default' as const,
    system_prompt_profile: 'pi-default.v1' as const,
    context_window: 512000,
    max_output_tokens: 65536,
    input_modalities: ['text'] as const,
    output_modalities: ['text'] as const,
    reasoning_capability: 'reasoning-supported' as const,
    tool_capability: 'tool-use-supported' as const,
    route_policy_id: 'codex-subscription-v1',
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
    system_prompt_sha256: sha('actual-system-prompt'),
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
