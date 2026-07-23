import { createHash } from 'node:crypto';
import { dirname, normalize, sep } from 'node:path';

import { AUTOPILOT_STATUS_TOOL } from '../names.ts';
import {
  autopilotSchemaSha256,
  computeAutopilotRosterContractObjectHash,
  parseAutopilotReceiptV2,
  parseAutopilotRosterContract,
  parseAutopilotUnitSpec,
} from '../contracts/index.ts';
import type {
  AutopilotReceipt,
  AutopilotReceiptV2,
  AutopilotRosterObservedProfileV1,
  AutopilotRosterRequestProfileV1,
  AutopilotUnitSpec,
  AutopilotUnitSpecV2,
} from '../contracts/types.ts';

export const AUTOPILOT_EXPECTED_STATUS_IDENTITY_SCHEMA_VERSION =
  'autopilot.expected_status_identity.v1' as const;
export const AUTOPILOT_STATUS_TOOL_CONTEXT_SCHEMA_VERSION =
  'autopilot.status_tool_context.v1' as const;
export const AUTOPILOT_ROSTER_EXECUTION_IDENTITY_SCHEMA_VERSION =
  'autopilot.roster_execution_identity.v1' as const;

export type AutopilotProviderIdentity = AutopilotReceipt['provider_identity'];
export type AutopilotStatusReceipt = AutopilotReceipt | AutopilotReceiptV2;
export type AutopilotStatusReceiptSchemaVersion = AutopilotStatusReceipt['schema_version'];

export interface AutopilotRosterExecutionIdentity {
  readonly schema_version: typeof AUTOPILOT_ROSTER_EXECUTION_IDENTITY_SCHEMA_VERSION;
  readonly roster_id: string;
  readonly roster_revision: number;
  readonly roster_sha256: `sha256:${string}`;
  readonly assignment_sha256: `sha256:${string}`;
  readonly pre_run_selection_sha256: `sha256:${string}`;
  readonly request_profile: AutopilotRosterRequestProfileV1;
  readonly request_profile_sha256: `sha256:${string}`;
}

export interface AutopilotExpectedStatusIdentity {
  readonly schema_version: typeof AUTOPILOT_EXPECTED_STATUS_IDENTITY_SCHEMA_VERSION;
  readonly tool_name: typeof AUTOPILOT_STATUS_TOOL;
  readonly workstream: string;
  readonly unit_id: string;
  readonly role: AutopilotUnitSpec['role'];
  readonly attempt: number;
  readonly status_output: string;
  readonly receipt_output: string;
  readonly schema_sha256: `sha256:${string}`;
  readonly provider_identity: AutopilotProviderIdentity;
  readonly receipt_schema_version?: 'autopilot.receipt.v2';
  readonly roster_execution_identity?: AutopilotRosterExecutionIdentity;
}

export interface AutopilotStatusToolContext {
  readonly schema_version: typeof AUTOPILOT_STATUS_TOOL_CONTEXT_SCHEMA_VERSION;
  readonly unit_spec: AutopilotUnitSpec;
  readonly status_output: string;
  readonly receipt_output: string;
  readonly artifact_root: string;
  readonly schema_sha256: `sha256:${string}`;
  readonly provider_identity: AutopilotProviderIdentity;
  readonly expected_identity_hash: `sha256:${string}`;
  readonly receipt_schema_version?: 'autopilot.receipt.v2';
  readonly roster_execution_identity?: AutopilotRosterExecutionIdentity;
}

export interface AutopilotObservedExecutionEvidence {
  readonly provider_id: string;
  readonly requested_model_id: string;
  readonly executed_model_id: string;
  readonly api: AutopilotRosterRequestProfileV1['api'];
  readonly thinking: AutopilotRosterRequestProfileV1['thinking'];
  readonly service_tier: AutopilotRosterRequestProfileV1['service_tier'];
  readonly cache_policy: AutopilotRosterRequestProfileV1['cache_policy'];
  readonly system_prompt_profile: AutopilotRosterRequestProfileV1['system_prompt_profile'];
  readonly system_prompt_sha256: `sha256:${string}`;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly request_profile_sha256: `sha256:${string}`;
  readonly final_model_metadata?: JsonRecord;
}

export interface AutopilotReceiptV2BuildInput {
  readonly unitSpec: AutopilotUnitSpec;
  readonly emittedAt: string;
  readonly statusSha256: `sha256:${string}`;
  readonly schemaSha256: `sha256:${string}`;
  readonly toolCallId: string;
  readonly providerIdentity: AutopilotProviderIdentity;
  readonly expectedIdentityHash: `sha256:${string}`;
  readonly rosterExecutionIdentity: AutopilotRosterExecutionIdentity;
  readonly observedProfile: AutopilotRosterObservedProfileV1;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

export class AutopilotForcedOutputIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutopilotForcedOutputIdentityError';
  }
}

export const AUTOPILOT_SUBSCRIPTION_PROVIDER_IDS = [
  'openai-codex',
  'anthropic',
  'opencode-go',
  'kimi-coding',
  'zai',
] as const;

export type AutopilotSubscriptionProviderId = (typeof AUTOPILOT_SUBSCRIPTION_PROVIDER_IDS)[number];

export const AUTOPILOT_SUBSCRIPTION_MODEL_PATTERNS = AUTOPILOT_SUBSCRIPTION_PROVIDER_IDS.map(
  (provider) => `${provider}/*`,
);

const OPENCODE_GO_ANTHROPIC_API_MODEL_IDS = [
  'minimax-m3',
  'qwen3.7-max',
  'qwen3.7-plus',
] as const;

export function buildAutopilotProviderIdentity(
  model: string,
  thinking: AutopilotUnitSpec['thinking'],
): AutopilotProviderIdentity {
  const { provider, modelId } = splitAutopilotModelId(model);
  return Object.freeze({
    provider_id: provider,
    requested_model_id: model,
    executed_model_id: model,
    api: autopilotApiForSubscriptionModel(provider, modelId),
    thinking_level: thinking,
  });
}

export function buildAutopilotProviderIdentityFromRequestProfile(
  requestProfile: AutopilotRosterRequestProfileV1,
): AutopilotProviderIdentity {
  assertRequestProfileModelRelation(requestProfile);
  return Object.freeze({
    provider_id: requestProfile.provider_id,
    requested_model_id: requestProfile.model_id,
    executed_model_id: requestProfile.model_id,
    api: requestProfile.api,
    thinking_level: requestProfile.thinking,
  });
}

export function splitAutopilotModelId(model: string): {
  readonly provider: AutopilotSubscriptionProviderId;
  readonly modelId: string;
} {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw new AutopilotForcedOutputIdentityError(
      `unsupported Autopilot subscription model ${JSON.stringify(model)}; expected provider/model`,
    );
  }
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  if (!isAutopilotSubscriptionProviderId(provider)) {
    throw new AutopilotForcedOutputIdentityError(
      `unsupported Autopilot subscription model ${JSON.stringify(
        model,
      )}; Autopilot forbids paid frontier routes and currently accepts subscription provider patterns: ${AUTOPILOT_SUBSCRIPTION_MODEL_PATTERNS.join(', ')}`,
    );
  }
  return { provider, modelId };
}

function isAutopilotSubscriptionProviderId(
  value: string,
): value is AutopilotSubscriptionProviderId {
  return (AUTOPILOT_SUBSCRIPTION_PROVIDER_IDS as readonly string[]).includes(value);
}

function autopilotApiForSubscriptionModel(
  provider: AutopilotSubscriptionProviderId,
  modelId: string,
): AutopilotProviderIdentity['api'] {
  if (provider === 'openai-codex') return 'openai-codex-responses';
  if (provider === 'anthropic') return 'anthropic-messages';
  if (provider === 'kimi-coding') return 'anthropic-messages';
  if (provider === 'zai') return 'openai-completions';
  if (provider === 'opencode-go') {
    return (OPENCODE_GO_ANTHROPIC_API_MODEL_IDS as readonly string[]).includes(modelId)
      ? 'anthropic-messages'
      : 'openai-completions';
  }
  const exhaustive: never = provider;
  throw new AutopilotForcedOutputIdentityError(`unsupported Autopilot provider ${exhaustive}`);
}

export function expectedAutopilotStatusIdentityFromSpec(
  spec: AutopilotUnitSpec,
  providerIdentity: AutopilotProviderIdentity = buildAutopilotProviderIdentity(
    spec.model,
    spec.thinking,
  ),
  rosterExecutionIdentity?: AutopilotRosterExecutionIdentity,
): AutopilotExpectedStatusIdentity {
  const base = {
    schema_version: AUTOPILOT_EXPECTED_STATUS_IDENTITY_SCHEMA_VERSION,
    tool_name: AUTOPILOT_STATUS_TOOL,
    workstream: spec.workstream,
    unit_id: spec.unit_id,
    role: spec.role,
    attempt: spec.attempt,
    status_output: spec.status_output,
    receipt_output: spec.receipt_output,
    schema_sha256: autopilotSchemaSha256('statusEntry'),
    provider_identity: { ...providerIdentity },
  } as const;
  if (rosterExecutionIdentity === undefined) return Object.freeze(base);
  return Object.freeze({
    ...base,
    receipt_schema_version: 'autopilot.receipt.v2' as const,
    roster_execution_identity: cloneRosterExecutionIdentity(rosterExecutionIdentity),
  });
}

export function autopilotExpectedIdentityHash(
  identity: AutopilotExpectedStatusIdentity,
): `sha256:${string}` {
  return sha256String(canonicalJson(identity));
}

export function buildAutopilotStatusToolContext(input: {
  readonly unitSpec: AutopilotUnitSpec;
  readonly artifactRoot?: string;
  readonly providerIdentity?: AutopilotProviderIdentity;
  readonly rosterExecutionIdentity?: AutopilotRosterExecutionIdentity;
}): AutopilotStatusToolContext {
  const unitSpec = parseAutopilotUnitSpec(input.unitSpec);
  const rosterExecutionIdentity = input.rosterExecutionIdentity;
  const providerIdentity = input.providerIdentity ?? (rosterExecutionIdentity === undefined
    ? buildAutopilotProviderIdentity(unitSpec.model, unitSpec.thinking)
    : buildAutopilotProviderIdentityFromRequestProfile(rosterExecutionIdentity.request_profile));
  if (rosterExecutionIdentity === undefined) {
    assertProviderIdentityMatchesSpec(providerIdentity, unitSpec);
  } else {
    assertUnitSpecMatchesRosterExecutionIdentity(unitSpec, rosterExecutionIdentity);
    assertProviderIdentityMatchesRequestProfile(providerIdentity, rosterExecutionIdentity.request_profile);
  }
  const expectedIdentity = expectedAutopilotStatusIdentityFromSpec(unitSpec, providerIdentity, rosterExecutionIdentity);
  const artifactRoot = input.artifactRoot ?? deriveAutopilotArtifactRoot(unitSpec);
  const base = {
    schema_version: AUTOPILOT_STATUS_TOOL_CONTEXT_SCHEMA_VERSION,
    unit_spec: unitSpec,
    status_output: unitSpec.status_output,
    receipt_output: unitSpec.receipt_output,
    artifact_root: artifactRoot,
    schema_sha256: expectedIdentity.schema_sha256,
    provider_identity: { ...providerIdentity },
    expected_identity_hash: autopilotExpectedIdentityHash(expectedIdentity),
  } as const;
  if (rosterExecutionIdentity === undefined) return Object.freeze(base);
  return Object.freeze({
    ...base,
    receipt_schema_version: 'autopilot.receipt.v2' as const,
    roster_execution_identity: cloneRosterExecutionIdentity(rosterExecutionIdentity),
  });
}

export function parseAutopilotStatusToolContext(value: unknown): AutopilotStatusToolContext {
  if (!isJsonObject(value)) {
    throw new AutopilotForcedOutputIdentityError(
      'Autopilot status tool context must be a JSON object',
    );
  }
  if (value['schema_version'] !== AUTOPILOT_STATUS_TOOL_CONTEXT_SCHEMA_VERSION) {
    throw new AutopilotForcedOutputIdentityError(
      `Autopilot status tool context schema_version must be ${AUTOPILOT_STATUS_TOOL_CONTEXT_SCHEMA_VERSION}`,
    );
  }
  const unitSpec = parseAutopilotUnitSpec(value['unit_spec']);
  const statusOutput = stringField(value, 'status_output');
  const receiptOutput = stringField(value, 'receipt_output');
  const artifactRoot = stringField(value, 'artifact_root');
  const schemaSha256 = shaField(value, 'schema_sha256');
  const expectedIdentityHash = shaField(value, 'expected_identity_hash');
  const providerIdentity = parseAutopilotProviderIdentity(value['provider_identity']);
  const receiptSchemaVersion = optionalReceiptSchemaVersion(value);
  const rosterExecutionIdentity = receiptSchemaVersion === undefined
    ? undefined
    : parseAutopilotRosterExecutionIdentity(value['roster_execution_identity']);

  const issues: string[] = [];
  if (statusOutput !== unitSpec.status_output) {
    issues.push('status_output does not match unit_spec');
  }
  if (receiptOutput !== unitSpec.receipt_output) {
    issues.push('receipt_output does not match unit_spec');
  }
  if (schemaSha256 !== autopilotSchemaSha256('statusEntry')) {
    issues.push('schema_sha256 does not match Autopilot status schema');
  }
  try {
    if (rosterExecutionIdentity === undefined) {
      assertProviderIdentityMatchesSpec(providerIdentity, unitSpec);
    } else {
      assertUnitSpecMatchesRosterExecutionIdentity(unitSpec, rosterExecutionIdentity);
      assertProviderIdentityMatchesRequestProfile(providerIdentity, rosterExecutionIdentity.request_profile);
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const expectedIdentity = expectedAutopilotStatusIdentityFromSpec(unitSpec, providerIdentity, rosterExecutionIdentity);
  if (expectedIdentityHash !== autopilotExpectedIdentityHash(expectedIdentity)) {
    issues.push('expected_identity_hash does not match context identity');
  }
  if (issues.length > 0) {
    throw new AutopilotForcedOutputIdentityError(
      `invalid Autopilot status tool context: ${issues.join('; ')}`,
    );
  }

  const base = {
    schema_version: AUTOPILOT_STATUS_TOOL_CONTEXT_SCHEMA_VERSION,
    unit_spec: unitSpec,
    status_output: statusOutput,
    receipt_output: receiptOutput,
    artifact_root: artifactRoot,
    schema_sha256: schemaSha256,
    provider_identity: { ...providerIdentity },
    expected_identity_hash: expectedIdentityHash,
  } as const;
  if (rosterExecutionIdentity === undefined) return Object.freeze(base);
  return Object.freeze({
    ...base,
    receipt_schema_version: 'autopilot.receipt.v2' as const,
    roster_execution_identity: cloneRosterExecutionIdentity(rosterExecutionIdentity),
  });
}

export function parseAutopilotProviderIdentity(value: unknown): AutopilotProviderIdentity {
  if (!isJsonObject(value)) {
    throw new AutopilotForcedOutputIdentityError('provider_identity must be a JSON object');
  }
  const providerIdentity: AutopilotProviderIdentity = {
    provider_id: nonEmptyStringField(value, 'provider_id'),
    requested_model_id: nonEmptyStringField(value, 'requested_model_id'),
    executed_model_id: nonEmptyStringField(value, 'executed_model_id'),
    api: nonEmptyStringField(value, 'api'),
    thinking_level: nonEmptyStringField(value, 'thinking_level'),
  };
  return Object.freeze(providerIdentity);
}

export function assertProviderIdentityMatchesSpec(
  providerIdentity: AutopilotProviderIdentity,
  spec: AutopilotUnitSpec,
): void {
  const expected = buildAutopilotProviderIdentity(spec.model, spec.thinking);
  const mismatches = (
    Object.keys(expected) as Array<keyof AutopilotProviderIdentity>
  ).filter((key) => providerIdentity[key] !== expected[key]);
  if (mismatches.length > 0) {
    throw new AutopilotForcedOutputIdentityError(
      `provider_identity does not match unit spec model/thinking at ${mismatches.join(', ')}`,
    );
  }
}

export function assertProviderIdentityMatchesRequestProfile(
  providerIdentity: AutopilotProviderIdentity,
  requestProfile: AutopilotRosterRequestProfileV1,
): void {
  const expected = buildAutopilotProviderIdentityFromRequestProfile(requestProfile);
  const mismatches = (
    Object.keys(expected) as Array<keyof AutopilotProviderIdentity>
  ).filter((key) => providerIdentity[key] !== expected[key]);
  if (mismatches.length > 0) {
    throw new AutopilotForcedOutputIdentityError(
      `provider_identity does not match roster request profile at ${mismatches.join(', ')}`,
    );
  }
}

export function buildAutopilotRosterExecutionIdentity(
  spec: AutopilotUnitSpecV2,
): AutopilotRosterExecutionIdentity {
  const requestProfile = parseAutopilotRosterContract('autopilot.request_profile.v1', spec.request_profile);
  const identity: AutopilotRosterExecutionIdentity = {
    schema_version: AUTOPILOT_ROSTER_EXECUTION_IDENTITY_SCHEMA_VERSION,
    roster_id: spec.roster_id,
    roster_revision: spec.roster_revision,
    roster_sha256: spec.roster_sha256 as `sha256:${string}`,
    assignment_sha256: spec.assignment_sha256 as `sha256:${string}`,
    pre_run_selection_sha256: spec.pre_run_selection_sha256 as `sha256:${string}`,
    request_profile: requestProfile,
    request_profile_sha256: requestProfile.request_profile_sha256 as `sha256:${string}`,
  };
  assertUnitSpecMatchesRosterExecutionIdentity(lowerAutopilotUnitSpecV2ToV1(spec), identity);
  return Object.freeze(identity);
}

export function parseAutopilotRosterExecutionIdentity(value: unknown): AutopilotRosterExecutionIdentity {
  if (!isJsonObject(value)) {
    throw new AutopilotForcedOutputIdentityError('roster_execution_identity must be a JSON object');
  }
  const issues: string[] = [];
  if (value['schema_version'] !== AUTOPILOT_ROSTER_EXECUTION_IDENTITY_SCHEMA_VERSION) {
    issues.push(`schema_version must be ${AUTOPILOT_ROSTER_EXECUTION_IDENTITY_SCHEMA_VERSION}`);
  }
  const requestProfile = parseAutopilotRosterContract('autopilot.request_profile.v1', value['request_profile']);
  const requestProfileSha256 = shaField(value, 'request_profile_sha256');
  if (requestProfileSha256 !== requestProfile.request_profile_sha256) {
    issues.push('request_profile_sha256 does not match request_profile.request_profile_sha256');
  }
  const identity: AutopilotRosterExecutionIdentity = {
    schema_version: AUTOPILOT_ROSTER_EXECUTION_IDENTITY_SCHEMA_VERSION,
    roster_id: nonEmptyStringField(value, 'roster_id'),
    roster_revision: positiveIntegerField(value, 'roster_revision'),
    roster_sha256: shaField(value, 'roster_sha256'),
    assignment_sha256: shaField(value, 'assignment_sha256'),
    pre_run_selection_sha256: shaField(value, 'pre_run_selection_sha256'),
    request_profile: requestProfile,
    request_profile_sha256: requestProfileSha256,
  };
  if (issues.length > 0) {
    throw new AutopilotForcedOutputIdentityError(
      `invalid roster_execution_identity: ${issues.join('; ')}`,
    );
  }
  return Object.freeze(identity);
}

export function lowerAutopilotUnitSpecV2ToV1(spec: AutopilotUnitSpecV2): AutopilotUnitSpec {
  const lowered: Record<string, unknown> = {
    schema_version: 'autopilot.unit_spec.v1',
    workstream: spec.workstream,
    unit_id: spec.unit_id,
    role: spec.role,
    template: spec.template,
    attempt: spec.attempt,
    objective: spec.objective,
    cwd: spec.cwd,
    model: spec.model,
    thinking: spec.thinking,
    owned_paths: [...spec.owned_paths],
    read_only_paths: [...spec.read_only_paths],
    untouchable_paths: [...spec.untouchable_paths],
    context_refs: spec.context_refs.map((ref) => ({
      path: ref.path,
      purpose: ref.purpose,
      ...(ref.sha256 === null ? {} : { sha256: ref.sha256 }),
      ...(ref.byte_count === null ? {} : { byte_count: ref.byte_count }),
    })),
    validation_commands: [...spec.validation_commands],
    status_output: spec.status_output,
    receipt_output: spec.receipt_output,
    evidence_dir: spec.evidence_dir,
    stop_boundary: spec.stop_boundary,
  };
  if (spec.quality_profile !== null) lowered['quality_profile'] = spec.quality_profile;
  if (spec.risk_level !== null) lowered['risk_level'] = spec.risk_level;
  if (spec.acceptance_criteria.length > 0) lowered['acceptance_criteria'] = [...spec.acceptance_criteria];
  if (spec.verification_plan !== null) lowered['verification_plan'] = spec.verification_plan;
  if (spec.closure_criteria.length > 0) lowered['closure_criteria'] = [...spec.closure_criteria];
  if (spec.upstream_refs.length > 0) lowered['upstream_refs'] = [...spec.upstream_refs];
  if (spec.timeout_seconds !== null) lowered['timeout_seconds'] = spec.timeout_seconds;
  if (spec.render_prompt_snapshot !== null) lowered['render_prompt_snapshot'] = spec.render_prompt_snapshot;
  return parseAutopilotUnitSpec(lowered);
}

export function assertUnitSpecMatchesRosterExecutionIdentity(
  spec: AutopilotUnitSpec,
  identity: AutopilotRosterExecutionIdentity,
): void {
  const requestProfile = identity.request_profile;
  const issues: string[] = [];
  if (spec.model !== requestProfile.model) issues.push('unit spec model does not match roster request_profile.model');
  if (spec.thinking !== requestProfile.thinking) issues.push('unit spec thinking does not match roster request_profile.thinking');
  if (requestProfile.request_profile_sha256 !== identity.request_profile_sha256) issues.push('request_profile_sha256 does not match request profile');
  assertRequestProfileModelRelation(requestProfile);
  if (issues.length > 0) {
    throw new AutopilotForcedOutputIdentityError(issues.join('; '));
  }
}

export function buildAutopilotObservedProfile(
  observed: AutopilotObservedExecutionEvidence,
): AutopilotRosterObservedProfileV1 {
  const preimage = {
    provider_id: observed.provider_id,
    requested_model_id: observed.requested_model_id,
    executed_model_id: observed.executed_model_id,
    api: observed.api,
    thinking: observed.thinking,
    service_tier: observed.service_tier,
    cache_policy: observed.cache_policy,
    system_prompt_profile: observed.system_prompt_profile,
    system_prompt_sha256: observed.system_prompt_sha256,
    route_policy_id: observed.route_policy_id,
    route_policy_revision: observed.route_policy_revision,
    request_profile_sha256: observed.request_profile_sha256,
  } as const;
  const observedProfile = {
    ...preimage,
    observed_profile_sha256: computeRequiredRosterHash('autopilot.observed_profile.v1', preimage),
  };
  return parseAutopilotRosterContract('autopilot.observed_profile.v1', observedProfile);
}

export function buildProvisionalAutopilotObservedProfile(
  requestProfile: AutopilotRosterRequestProfileV1,
): AutopilotRosterObservedProfileV1 {
  return buildAutopilotObservedProfile({
    provider_id: requestProfile.provider_id,
    requested_model_id: requestProfile.model_id,
    executed_model_id: requestProfile.model_id,
    api: requestProfile.api,
    thinking: requestProfile.thinking,
    service_tier: requestProfile.service_tier,
    cache_policy: requestProfile.cache_policy,
    system_prompt_profile: requestProfile.system_prompt_profile,
    system_prompt_sha256: sha256String('autopilot.provisional-unobserved-system-prompt.v1'),
    route_policy_id: requestProfile.route_policy_id,
    route_policy_revision: requestProfile.route_policy_revision,
    request_profile_sha256: requestProfile.request_profile_sha256 as `sha256:${string}`,
  });
}

export function autopilotObservedProfileMismatches(input: {
  readonly requestProfile: AutopilotRosterRequestProfileV1;
  readonly observedProfile: AutopilotRosterObservedProfileV1;
}): readonly string[] {
  const { requestProfile, observedProfile } = input;
  const mismatches: string[] = [];
  compareObserved('provider_id', requestProfile.provider_id, observedProfile.provider_id, mismatches);
  compareObserved('requested_model_id', requestProfile.model_id, observedProfile.requested_model_id, mismatches);
  compareObserved('executed_model_id', requestProfile.model_id, observedProfile.executed_model_id, mismatches);
  compareObserved('api', requestProfile.api, observedProfile.api, mismatches);
  compareObserved('thinking', requestProfile.thinking, observedProfile.thinking, mismatches);
  compareObserved('service_tier', requestProfile.service_tier, observedProfile.service_tier, mismatches);
  compareObserved('cache_policy', requestProfile.cache_policy, observedProfile.cache_policy, mismatches);
  compareObserved('system_prompt_profile', requestProfile.system_prompt_profile, observedProfile.system_prompt_profile, mismatches);
  compareObserved('route_policy_id', requestProfile.route_policy_id, observedProfile.route_policy_id, mismatches);
  compareObserved('route_policy_revision', requestProfile.route_policy_revision, observedProfile.route_policy_revision, mismatches);
  compareObserved('request_profile_sha256', requestProfile.request_profile_sha256, observedProfile.request_profile_sha256, mismatches);
  return Object.freeze(mismatches);
}

export function buildAutopilotReceiptV2(input: AutopilotReceiptV2BuildInput): AutopilotReceiptV2 {
  const receipt = {
    schema_version: 'autopilot.receipt.v2' as const,
    tool_name: AUTOPILOT_STATUS_TOOL,
    workstream: input.unitSpec.workstream,
    unit_id: input.unitSpec.unit_id,
    role: input.unitSpec.role,
    attempt: input.unitSpec.attempt,
    emitted_at: input.emittedAt,
    status_output: input.unitSpec.status_output,
    status_sha256: input.statusSha256,
    schema_sha256: input.schemaSha256,
    tool_call_id: input.toolCallId,
    provider_identity: { ...input.providerIdentity },
    expected_identity_hash: input.expectedIdentityHash,
    roster_id: input.rosterExecutionIdentity.roster_id,
    roster_revision: input.rosterExecutionIdentity.roster_revision,
    roster_sha256: input.rosterExecutionIdentity.roster_sha256,
    assignment_sha256: input.rosterExecutionIdentity.assignment_sha256,
    pre_run_selection_sha256: input.rosterExecutionIdentity.pre_run_selection_sha256,
    request_profile: input.rosterExecutionIdentity.request_profile,
    observed_profile: input.observedProfile,
  };
  return parseAutopilotReceiptV2(receipt);
}

export function providerIdentityFromObservedProfile(
  observedProfile: AutopilotRosterObservedProfileV1,
): AutopilotProviderIdentity {
  return Object.freeze({
    provider_id: observedProfile.provider_id,
    requested_model_id: observedProfile.requested_model_id,
    executed_model_id: observedProfile.executed_model_id,
    api: observedProfile.api,
    thinking_level: observedProfile.thinking,
  });
}

export function deriveAutopilotArtifactRoot(spec: AutopilotUnitSpec): string {
  const candidates = [
    rootBeforeNamedSegment(spec.status_output, 'statuses'),
    rootBeforeNamedSegment(spec.receipt_output, 'receipts'),
    rootBeforeNamedSegment(spec.evidence_dir, 'evidence'),
  ].filter((candidate): candidate is string => candidate !== undefined);
  const unique = [...new Set(candidates.map((candidate) => normalize(candidate)))];
  if (unique.length === 1) {
    const [only] = unique;
    if (only === undefined) {
      throw new AutopilotForcedOutputIdentityError('internal error: missing unique artifact root');
    }
    return only;
  }
  if (unique.length > 1) {
    throw new AutopilotForcedOutputIdentityError(
      `Autopilot artifact paths disagree on workstream root: ${unique.join(', ')}`,
    );
  }
  return dirname(dirname(spec.status_output));
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (!isJsonObject(value)) {
    throw new AutopilotForcedOutputIdentityError(
      `cannot canonicalize non-JSON value of type ${typeof value}`,
    );
  }
  const entries = Object.entries(value)
    .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

export function sha256String(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function sha256Buffer(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function cloneRosterExecutionIdentity(
  identity: AutopilotRosterExecutionIdentity,
): AutopilotRosterExecutionIdentity {
  return {
    schema_version: AUTOPILOT_ROSTER_EXECUTION_IDENTITY_SCHEMA_VERSION,
    roster_id: identity.roster_id,
    roster_revision: identity.roster_revision,
    roster_sha256: identity.roster_sha256,
    assignment_sha256: identity.assignment_sha256,
    pre_run_selection_sha256: identity.pre_run_selection_sha256,
    request_profile: { ...identity.request_profile },
    request_profile_sha256: identity.request_profile_sha256,
  };
}

function optionalReceiptSchemaVersion(
  object: Record<string, unknown>,
): AutopilotStatusToolContext['receipt_schema_version'] | undefined {
  const value = object['receipt_schema_version'];
  if (value === undefined) return undefined;
  if (value !== 'autopilot.receipt.v2') {
    throw new AutopilotForcedOutputIdentityError(
      'receipt_schema_version must be autopilot.receipt.v2 when present',
    );
  }
  return value;
}

function assertRequestProfileModelRelation(requestProfile: AutopilotRosterRequestProfileV1): void {
  if (requestProfile.model !== `${requestProfile.provider_id}/${requestProfile.model_id}`) {
    throw new AutopilotForcedOutputIdentityError('request_profile model must equal provider_id/model_id');
  }
}

function computeRequiredRosterHash(
  schemaVersion: Parameters<typeof computeAutopilotRosterContractObjectHash>[0],
  value: unknown,
): `sha256:${string}` {
  const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
  if (hash === null) {
    throw new AutopilotForcedOutputIdentityError(`${schemaVersion} has no hash field`);
  }
  return hash as `sha256:${string}`;
}

function compareObserved(
  field: string,
  expected: string | number | null,
  actual: string | number | null,
  mismatches: string[],
): void {
  if (actual !== expected) {
    mismatches.push(`${field} mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
  }
}

function rootBeforeNamedSegment(pathValue: string, segment: string): string | undefined {
  const normalized = normalize(pathValue);
  const parts = normalized.split(sep);
  const index = parts.lastIndexOf(segment);
  if (index <= 0) return undefined;
  const rootPrefix = normalized.startsWith(sep) ? sep : '';
  return (
    rootPrefix +
    parts.slice(normalized.startsWith(sep) ? 1 : 0, index).join(sep)
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(object: Record<string, unknown>, field: string): string {
  const value = object[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AutopilotForcedOutputIdentityError(`${field} must be a non-empty string`);
  }
  return value;
}

function nonEmptyStringField(object: Record<string, unknown>, field: string): string {
  const value = stringField(object, field);
  if (value.trim() !== value) {
    throw new AutopilotForcedOutputIdentityError(
      `${field} must not have leading/trailing whitespace`,
    );
  }
  return value;
}

function positiveIntegerField(object: Record<string, unknown>, field: string): number {
  const value = object[field];
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1) {
    throw new AutopilotForcedOutputIdentityError(`${field} must be a positive integer`);
  }
  return value;
}

function shaField(object: Record<string, unknown>, field: string): `sha256:${string}` {
  const value = stringField(object, field);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new AutopilotForcedOutputIdentityError(
      `${field} must be sha256:<64 lowercase hex>`,
    );
  }
  return value as `sha256:${string}`;
}
