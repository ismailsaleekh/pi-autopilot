import { createHash } from 'node:crypto';
import { dirname, normalize, sep } from 'node:path';

import { AUTOPILOT_STATUS_TOOL } from '../names.ts';
import { autopilotSchemaSha256, parseAutopilotUnitSpec } from '../contracts/index.ts';
import type { AutopilotReceipt, AutopilotUnitSpec } from '../contracts/types.ts';

export const AUTOPILOT_EXPECTED_STATUS_IDENTITY_SCHEMA_VERSION =
  'autopilot.expected_status_identity.v1' as const;
export const AUTOPILOT_STATUS_TOOL_CONTEXT_SCHEMA_VERSION =
  'autopilot.status_tool_context.v1' as const;

export type AutopilotProviderIdentity = AutopilotReceipt['provider_identity'];

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
): AutopilotExpectedStatusIdentity {
  return Object.freeze({
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
}): AutopilotStatusToolContext {
  const unitSpec = parseAutopilotUnitSpec(input.unitSpec);
  const providerIdentity =
    input.providerIdentity ?? buildAutopilotProviderIdentity(unitSpec.model, unitSpec.thinking);
  assertProviderIdentityMatchesSpec(providerIdentity, unitSpec);
  const expectedIdentity = expectedAutopilotStatusIdentityFromSpec(unitSpec, providerIdentity);
  const artifactRoot = input.artifactRoot ?? deriveAutopilotArtifactRoot(unitSpec);
  return Object.freeze({
    schema_version: AUTOPILOT_STATUS_TOOL_CONTEXT_SCHEMA_VERSION,
    unit_spec: unitSpec,
    status_output: unitSpec.status_output,
    receipt_output: unitSpec.receipt_output,
    artifact_root: artifactRoot,
    schema_sha256: expectedIdentity.schema_sha256,
    provider_identity: { ...providerIdentity },
    expected_identity_hash: autopilotExpectedIdentityHash(expectedIdentity),
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
    assertProviderIdentityMatchesSpec(providerIdentity, unitSpec);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const expectedIdentity = expectedAutopilotStatusIdentityFromSpec(unitSpec, providerIdentity);
  if (expectedIdentityHash !== autopilotExpectedIdentityHash(expectedIdentity)) {
    issues.push('expected_identity_hash does not match context identity');
  }
  if (issues.length > 0) {
    throw new AutopilotForcedOutputIdentityError(
      `invalid Autopilot status tool context: ${issues.join('; ')}`,
    );
  }

  return Object.freeze({
    schema_version: AUTOPILOT_STATUS_TOOL_CONTEXT_SCHEMA_VERSION,
    unit_spec: unitSpec,
    status_output: statusOutput,
    receipt_output: receiptOutput,
    artifact_root: artifactRoot,
    schema_sha256: schemaSha256,
    provider_identity: { ...providerIdentity },
    expected_identity_hash: expectedIdentityHash,
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

function shaField(object: Record<string, unknown>, field: string): `sha256:${string}` {
  const value = stringField(object, field);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new AutopilotForcedOutputIdentityError(
      `${field} must be sha256:<64 lowercase hex>`,
    );
  }
  return value as `sha256:${string}`;
}
