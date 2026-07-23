import { createHash } from 'node:crypto';

export const PHASE37_FREEZE_ID = 'phase37-roster-w0-2026-07-22' as const;
export const PHASE37_PACKAGE_VERSION = '1.3.0' as const;
export const PHASE37_PI_VERSION = '0.80.6' as const;
export const PHASE37_W0_SEED_CREATED_AT = '2026-07-22T00:00:00.000Z' as const;
export const PHASE37_FIXTURE_CLOCK = '2026-07-22T12:00:00.000Z' as const;

export const ROSTER_ROLE_ORDER = [
  'parent',
  'strategy',
  'implement',
  'validate',
  'fix',
  'adjudicate',
  'bughunt',
  'extract',
] as const;

export const ROSTER_CHILD_ROLE_ORDER = [
  'strategy',
  'implement',
  'validate',
  'fix',
  'adjudicate',
  'bughunt',
  'extract',
] as const;

export type RosterRole = (typeof ROSTER_ROLE_ORDER)[number];
export type ChildRosterRole = (typeof ROSTER_CHILD_ROLE_ORDER)[number];

export const ROSTER_PROFILES = [
  {
    profile_id: 'precision',
    display_name: 'Precision',
    semantics: 'quality',
    recommended_by_default: false,
    quality_contract: 'perfect-quality',
  },
  {
    profile_id: 'cruise',
    display_name: 'Cruise',
    semantics: 'routine',
    recommended_by_default: true,
    quality_contract: 'perfect-quality',
  },
  {
    profile_id: 'afterburner',
    display_name: 'Afterburner',
    semantics: 'quick',
    recommended_by_default: false,
    quality_contract: 'perfect-quality',
  },
] as const;

export type RosterProfileId = (typeof ROSTER_PROFILES)[number]['profile_id'];
export type RosterScope = 'user' | 'trusted-project';
export type Digest = `sha256:${string}`;
export type ApiId = 'openai-codex-responses' | 'anthropic-messages' | 'openai-completions';
export type ThinkingValue = 'high' | 'xhigh';
export type ServiceTier = null | 'priority';
export type CachePolicy = 'provider-default' | 'none' | 'short' | 'long';
export type SystemPromptProfile = 'pi-default.v1' | 'anthropic-autopilot-sanitized.v1';
export type Modality = 'text' | 'image' | 'audio' | 'file' | 'patch';
export type ReasoningCapability = 'reasoning-supported' | 'reasoning-unsupported';
export type ToolCapability = 'tool-use-supported' | 'tool-use-unsupported';
export type AuthClass = 'oauth' | 'api-key-plan-token' | 'api-key' | 'none' | 'unknown';
export type InventoryAuthClass = Exclude<AuthClass, 'none' | 'unknown'> | null;
export type AuthSource = 'stored' | 'runtime' | 'environment' | 'not-configured' | 'unknown';
export type InventoryAuthSource = Exclude<AuthSource, 'unknown'> | null;
export type AuthStatus = 'configured' | 'missing' | 'forbidden' | 'unknown';
export type BillingClass =
  | 'plan-backed-subscription'
  | 'plan-token'
  | 'metered-third-party-blocked'
  | 'forbidden-metered-gateway'
  | 'unknown';
export type BillingRouteClass =
  | 'subscription-oauth'
  | 'plan-api-token'
  | 'third-party-metered-blocked'
  | 'gateway-forbidden'
  | 'unknown';
export type RouteBillingRouteClass = Exclude<BillingRouteClass, 'unknown'>;
export type QualificationState =
  | 'unqualified-non-certifying-seed'
  | 'qualification-required'
  | 'synthetic-test-ready'
  | 'w4-certified-ready'
  | 'blocked-live-certification';
export type RoutePolicyState = 'unqualified-seed' | 'blocked-live-certification';
export type CandidateState = 'qualification-required' | 'blocked-live-certification' | 'synthetic-fixture-ready';
export type LaunchReadiness = 'not-ready-until-w4' | 'blocked' | 'synthetic-fixture-only';

export const ROSTER_RECOMMENDED_PROFILE_ID: RosterProfileId = 'cruise';

export interface RoutePolicy {
  readonly schema_version: 'autopilot.route_policy.v1';
  readonly route_policy_id: string;
  readonly revision: number;
  readonly provider_id: string;
  readonly allowed_auth_classes: readonly AuthClass[];
  readonly allowed_auth_sources: readonly AuthSource[];
  readonly billing_class: BillingClass;
  readonly billing_route_class: RouteBillingRouteClass;
  readonly allowed_apis: readonly ApiId[];
  readonly allowed_service_tiers: readonly ServiceTier[];
  readonly allowed_cache_policies: readonly CachePolicy[];
  readonly allowed_system_prompt_profiles: readonly SystemPromptProfile[];
  readonly forbidden_gateways: readonly ('arbitrary-api-key' | 'metered-frontier' | 'openrouter')[];
  readonly requires_live_billing_proof: boolean;
  readonly policy_state: RoutePolicyState;
  readonly qualification_state: QualificationState;
  readonly non_certifying_seed: boolean;
  readonly route_policy_sha256: Digest;
}

export interface RoutePolicyRegistryEntry {
  readonly route_policy_id: string;
  readonly revision: number;
  readonly route_policy_sha256: Digest;
}

export interface RoutePolicyRegistry {
  readonly schema_version: 'autopilot.route_policy_registry.v1';
  readonly freeze_id: typeof PHASE37_FREEZE_ID;
  readonly route_policies: readonly RoutePolicyRegistryEntry[];
  readonly route_policy_registry_sha256: Digest;
}

export interface InventoryModel {
  readonly model_id: string;
  readonly api: ApiId;
  readonly context_window: number;
  readonly max_output_tokens: number;
  readonly input_modalities: readonly Modality[];
  readonly output_modalities: readonly Modality[];
  readonly reasoning_capability: ReasoningCapability;
  readonly tool_capability: ToolCapability;
  readonly thinking_values: readonly ThinkingValue[];
  readonly service_tiers: readonly ServiceTier[];
  readonly cache_policies: readonly CachePolicy[];
  readonly system_prompt_profiles: readonly SystemPromptProfile[];
}

export interface InventoryProvider {
  readonly provider_id: string;
  readonly auth_configured: boolean;
  readonly auth_class: InventoryAuthClass;
  readonly auth_source: InventoryAuthSource;
  readonly auth_status: AuthStatus;
  readonly is_using_oauth: boolean;
  readonly billing_route_class: BillingRouteClass;
  readonly models: readonly InventoryModel[];
}

export interface RosterInventory {
  readonly schema_version: 'autopilot.roster_inventory.v1';
  readonly inventory_id: string;
  readonly created_at: string;
  readonly source: 'ctx.modelRegistry' | 'synthetic-fixture';
  readonly project_trusted: boolean;
  readonly providers: readonly InventoryProvider[];
  readonly inventory_sha256: Digest;
}

export interface RosterDiagnostic {
  readonly code: RosterDiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly remediation: string;
  readonly secret_free: true;
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error' | 'fatal';

export const ROSTER_DIAGNOSTIC_CODES = [
  'ROSTER_AUTH_REQUIRED',
  'ROSTER_AUTH_CHANNEL_FORBIDDEN',
  'ROSTER_ROUTE_FORBIDDEN',
  'ROSTER_PROJECT_UNTRUSTED',
  'ROSTER_PROPOSAL_REJECTED',
  'ROSTER_APPROVAL_STALE_CANDIDATE_SET',
  'ROSTER_APPROVAL_STALE_CONFIG',
  'ROSTER_PRIORITY_PROOF_REQUIRED',
  'ROSTER_PUBLICATION_INTERRUPTED_CONFIG_MISSING',
  'ROSTER_RECEIPT_REPLAY_REQUIRED',
  'ROSTER_CONVERGED_ASSIGNMENT_SET',
  'ROSTER_EXPLICIT_CHOICE_REQUIRED',
  'ROSTER_RECOMMENDED_PROFILE_BLOCKED',
  'ROSTER_TRANSITION_REQUIRED',
  'ROSTER_PINNED_SELECTION_UNAVAILABLE',
  'ROSTER_HISTORICAL_V1_BYTES_PRESERVED',
  'ROSTER_REQUEST_PROFILE_DRIFT',
  'ROSTER_OBSERVED_MODEL_MISMATCH',
  'ROSTER_OBSERVED_THINKING_MISMATCH',
  'ROSTER_QUALIFICATION_REQUIRED',
  'ROSTER_CREATE_ONLY_CONFLICT',
  'ROSTER_SELECTION_IDEMPOTENT_REPLAY',
  'ROSTER_STORAGE_TRUST_REQUIRED',
  'ROSTER_CONFIG_CAS_MISMATCH',
  'ROSTER_READBACK_MISMATCH',
  'ROSTER_LOCK_STALE_PROCESS_UNPROVEN',
  'ROSTER_HISTORICAL_PROOF_REQUIRED',
  'ROSTER_HISTORICAL_SELECTION_PRESENT',
  'ROSTER_HISTORICAL_VERSION_UNSUPPORTED',
  'ROSTER_HISTORICAL_FIXED_ROSTER_MISMATCH',
  'ROSTER_HISTORICAL_CONFLICTING_EVIDENCE',
] as const;

export type RosterDiagnosticCode = (typeof ROSTER_DIAGNOSTIC_CODES)[number];

function severityForDiagnosticCode(code: RosterDiagnosticCode): DiagnosticSeverity {
  switch (code) {
    case 'ROSTER_CONVERGED_ASSIGNMENT_SET':
    case 'ROSTER_HISTORICAL_V1_BYTES_PRESERVED':
    case 'ROSTER_PROPOSAL_REJECTED':
    case 'ROSTER_SELECTION_IDEMPOTENT_REPLAY':
      return 'info';
    case 'ROSTER_PRIORITY_PROOF_REQUIRED':
    case 'ROSTER_QUALIFICATION_REQUIRED':
      return 'warning';
    case 'ROSTER_PUBLICATION_INTERRUPTED_CONFIG_MISSING':
    case 'ROSTER_READBACK_MISMATCH':
      return 'fatal';
    default:
      return 'error';
  }
}

export const ROSTER_DIAGNOSTICS: Readonly<Record<RosterDiagnosticCode, RosterDiagnostic>> =
  Object.freeze(
    Object.fromEntries(
      ROSTER_DIAGNOSTIC_CODES.map((code) => [
        code,
        Object.freeze({
          code,
          severity: severityForDiagnosticCode(code),
          message: `${code} fixture diagnostic`,
          remediation: 'Follow the Phase 37 W0 roster contract freeze.',
          secret_free: true as const,
        }),
      ]),
    ) as Record<RosterDiagnosticCode, RosterDiagnostic>,
  );

export function rosterDiagnostic(code: RosterDiagnosticCode): RosterDiagnostic {
  const diagnostic = ROSTER_DIAGNOSTICS[code];
  return { ...diagnostic };
}

export function sortDiagnostics(diagnostics: readonly RosterDiagnostic[]): readonly RosterDiagnostic[] {
  return [...diagnostics].sort((left, right) => left.code.localeCompare(right.code));
}

export function dedupeDiagnostics(
  diagnostics: readonly (RosterDiagnostic | RosterDiagnosticCode)[],
): readonly RosterDiagnostic[] {
  const byCode = new Map<RosterDiagnosticCode, RosterDiagnostic>();
  for (const diagnostic of diagnostics) {
    const materialized = typeof diagnostic === 'string' ? rosterDiagnostic(diagnostic) : diagnostic;
    byCode.set(materialized.code, { ...materialized, secret_free: true });
  }
  return sortDiagnostics([...byCode.values()]);
}

export function roleSortIndex(role: RosterRole): number {
  return ROSTER_ROLE_ORDER.indexOf(role);
}

export function isRosterRole(value: string): value is RosterRole {
  return (ROSTER_ROLE_ORDER as readonly string[]).includes(value);
}

export function isRosterProfileId(value: string): value is RosterProfileId {
  return ROSTER_PROFILES.some((profile) => profile.profile_id === value);
}

export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('canonical JSON rejects non-finite numbers');
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) {
        const array = value as readonly unknown[];
        const encoded: string[] = [];
        for (let index = 0; index < array.length; index += 1) {
          if (!(index in array)) {
            throw new Error('canonical JSON rejects sparse arrays');
          }
          encoded.push(canonicalJson(array[index]));
        }
        return `[${encoded.join(',')}]`;
      }
      return canonicalJsonObject(value as Record<string, unknown>);
    case 'undefined':
      throw new Error('canonical JSON rejects undefined values');
    default:
      throw new Error(`canonical JSON rejects ${typeof value} values`);
  }
}

function canonicalJsonObject(value: Record<string, unknown>): string {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('canonical JSON accepts only plain objects');
  }
  const members: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const member = value[key];
    if (member === undefined) {
      throw new Error(`canonical JSON rejects undefined object member ${key}`);
    }
    members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
  }
  return `{${members.join(',')}}`;
}

export function canonicalJsonWithLf(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

export function sha256Digest(bytes: string): Digest {
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

export function canonicalSha256(value: unknown): Digest {
  return sha256Digest(canonicalJsonWithLf(value));
}

export function hashObjectOmitting<T extends Record<string, unknown>>(value: T, hashField: keyof T): Digest {
  const withoutHash: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key !== hashField) {
      withoutHash[key] = value[key];
    }
  }
  return canonicalSha256(withoutHash);
}

export function assertNoSecretFields(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretFields(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/secret|credential|token|api[_-]?key|password/i.test(key) && key !== 'secret_free' && key !== 'secret_fields_present') {
      throw new Error(`secret-bearing field ${path}.${key} is forbidden`);
    }
    assertNoSecretFields(nested, `${path}.${key}`);
  }
}

const ROUTE_POLICIES_JSON = '[{"schema_version":"autopilot.route_policy.v1","route_policy_id":"anthropic-sanitized-v1","revision":1,"provider_id":"anthropic","allowed_auth_classes":["api-key"],"allowed_auth_sources":["runtime","stored"],"billing_class":"metered-third-party-blocked","billing_route_class":"third-party-metered-blocked","allowed_apis":["anthropic-messages"],"allowed_service_tiers":[null],"allowed_cache_policies":["provider-default"],"allowed_system_prompt_profiles":["anthropic-autopilot-sanitized.v1"],"forbidden_gateways":["arbitrary-api-key","metered-frontier","openrouter"],"requires_live_billing_proof":true,"policy_state":"blocked-live-certification","qualification_state":"blocked-live-certification","non_certifying_seed":true,"route_policy_sha256":"sha256:dfe744bad274907e700d18357e70ec15a239c26e6b115a450aead641d195860b"},{"schema_version":"autopilot.route_policy.v1","route_policy_id":"codex-subscription-v1","revision":1,"provider_id":"openai-codex","allowed_auth_classes":["oauth"],"allowed_auth_sources":["runtime","stored"],"billing_class":"plan-backed-subscription","billing_route_class":"subscription-oauth","allowed_apis":["openai-codex-responses"],"allowed_service_tiers":[null,"priority"],"allowed_cache_policies":["provider-default"],"allowed_system_prompt_profiles":["pi-default.v1"],"forbidden_gateways":["arbitrary-api-key","metered-frontier","openrouter"],"requires_live_billing_proof":true,"policy_state":"unqualified-seed","qualification_state":"unqualified-non-certifying-seed","non_certifying_seed":true,"route_policy_sha256":"sha256:1a23f607a9fce47701ee5e7576205d29c7cb8451bc9186190ea4e9e550e60ccc"},{"schema_version":"autopilot.route_policy.v1","route_policy_id":"kimi-coding-plan-v1","revision":1,"provider_id":"kimi-coding","allowed_auth_classes":["api-key-plan-token"],"allowed_auth_sources":["runtime","stored"],"billing_class":"plan-token","billing_route_class":"plan-api-token","allowed_apis":["openai-completions"],"allowed_service_tiers":[null],"allowed_cache_policies":["provider-default"],"allowed_system_prompt_profiles":["pi-default.v1"],"forbidden_gateways":["arbitrary-api-key","metered-frontier","openrouter"],"requires_live_billing_proof":true,"policy_state":"unqualified-seed","qualification_state":"unqualified-non-certifying-seed","non_certifying_seed":true,"route_policy_sha256":"sha256:0925d0371e2f7f5ffae54e02ee9cf5c6d106dd5b47d7ec4698b68f754272d688"},{"schema_version":"autopilot.route_policy.v1","route_policy_id":"opencode-go-plan-v1","revision":1,"provider_id":"opencode-go","allowed_auth_classes":["api-key-plan-token"],"allowed_auth_sources":["runtime","stored"],"billing_class":"plan-token","billing_route_class":"plan-api-token","allowed_apis":["openai-completions"],"allowed_service_tiers":[null],"allowed_cache_policies":["provider-default"],"allowed_system_prompt_profiles":["pi-default.v1"],"forbidden_gateways":["arbitrary-api-key","metered-frontier","openrouter"],"requires_live_billing_proof":true,"policy_state":"unqualified-seed","qualification_state":"unqualified-non-certifying-seed","non_certifying_seed":true,"route_policy_sha256":"sha256:1fb2706f2e6c7192134f788a829fc199b3f5905cf45b77c7dbd511457d9350f5"},{"schema_version":"autopilot.route_policy.v1","route_policy_id":"zai-coding-plan-v1","revision":1,"provider_id":"zai","allowed_auth_classes":["api-key-plan-token"],"allowed_auth_sources":["runtime","stored"],"billing_class":"plan-token","billing_route_class":"plan-api-token","allowed_apis":["openai-completions"],"allowed_service_tiers":[null],"allowed_cache_policies":["provider-default"],"allowed_system_prompt_profiles":["pi-default.v1"],"forbidden_gateways":["arbitrary-api-key","metered-frontier","openrouter"],"requires_live_billing_proof":true,"policy_state":"unqualified-seed","qualification_state":"unqualified-non-certifying-seed","non_certifying_seed":true,"route_policy_sha256":"sha256:f59565fcef0baadf95010064cb8a4fde9423f2089a88076fe615859d15c6df54"}]';

export const ROUTE_POLICIES: readonly RoutePolicy[] = Object.freeze(
  (JSON.parse(ROUTE_POLICIES_JSON) as RoutePolicy[]).map((policy) => Object.freeze(policy)),
);

export function routePolicySortKey(policy: Pick<RoutePolicy, 'route_policy_id' | 'revision'>): string {
  return `${policy.route_policy_id}:${String(policy.revision).padStart(10, '0')}`;
}

export function sortRoutePolicies(policies: readonly RoutePolicy[]): readonly RoutePolicy[] {
  return [...policies].sort((left, right) => routePolicySortKey(left).localeCompare(routePolicySortKey(right)));
}

export function computeRoutePolicyRegistry(policies: readonly RoutePolicy[] = ROUTE_POLICIES): RoutePolicyRegistry {
  const route_policies = sortRoutePolicies(policies).map((policy) => ({
    route_policy_id: policy.route_policy_id,
    revision: policy.revision,
    route_policy_sha256: policy.route_policy_sha256,
  }));
  const preimage = {
    schema_version: 'autopilot.route_policy_registry.v1' as const,
    freeze_id: PHASE37_FREEZE_ID,
    route_policies,
  };
  return {
    ...preimage,
    route_policy_registry_sha256: canonicalSha256(preimage),
  };
}

export const ROUTE_POLICY_REGISTRY: RoutePolicyRegistry = Object.freeze(computeRoutePolicyRegistry());
export const ROUTE_POLICY_REGISTRY_SHA256: Digest = ROUTE_POLICY_REGISTRY.route_policy_registry_sha256;

export function findRoutePolicy(
  routePolicyId: string,
  revision: number,
  policies: readonly RoutePolicy[] = ROUTE_POLICIES,
): RoutePolicy | null {
  return policies.find((policy) => policy.route_policy_id === routePolicyId && policy.revision === revision) ?? null;
}

export function findRoutePolicyForProviderApi(
  providerId: string,
  api: ApiId,
  policies: readonly RoutePolicy[] = ROUTE_POLICIES,
): RoutePolicy | null {
  const matches = policies.filter((policy) => policy.provider_id === providerId && policy.allowed_apis.includes(api));
  if (matches.length === 0) {
    return null;
  }
  return sortRoutePolicies(matches)[0] ?? null;
}

export function verifyRoutePolicySeeds(policies: readonly RoutePolicy[] = ROUTE_POLICIES): readonly string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const policy of sortRoutePolicies(policies)) {
    const identity = `${policy.route_policy_id}@${policy.revision}`;
    if (seen.has(identity)) {
      issues.push(`duplicate route policy ${identity}`);
    }
    seen.add(identity);
    const expected = hashObjectOmitting(policy as unknown as Record<string, unknown>, 'route_policy_sha256');
    if (expected !== policy.route_policy_sha256) {
      issues.push(`${identity} hash mismatch: expected ${expected}, found ${policy.route_policy_sha256}`);
    }
    if (policy.non_certifying_seed !== true) {
      issues.push(`${identity} must remain a non-certifying seed`);
    }
    if (!policy.forbidden_gateways.includes('openrouter')) {
      issues.push(`${identity} must forbid OpenRouter`);
    }
  }
  const registry = computeRoutePolicyRegistry(policies);
  if (registry.route_policy_registry_sha256 !== ROUTE_POLICY_REGISTRY_SHA256 && policies === ROUTE_POLICIES) {
    issues.push(`route policy registry hash mismatch: expected ${ROUTE_POLICY_REGISTRY_SHA256}, found ${registry.route_policy_registry_sha256}`);
  }
  return issues;
}

export function authClassForRoute(provider: Pick<InventoryProvider, 'auth_class' | 'auth_configured'>): AuthClass {
  if (!provider.auth_configured) {
    return 'none';
  }
  return provider.auth_class ?? 'unknown';
}

export function authSourceForRoute(provider: Pick<InventoryProvider, 'auth_source' | 'auth_configured'>): AuthSource {
  if (!provider.auth_configured) {
    return 'not-configured';
  }
  return provider.auth_source ?? 'unknown';
}

export function isForbiddenGatewayProvider(providerId: string): boolean {
  return providerId === 'openrouter' || providerId === 'metered-frontier' || providerId === 'arbitrary-api-key';
}

function isAuthRequired(authClass: AuthClass, authSource: AuthSource): boolean {
  return authClass === 'none' || authClass === 'unknown' || authSource === 'not-configured' || authSource === 'unknown';
}

export interface RouteResolutionRequest {
  readonly schema_version?: 'autopilot.route_resolution_request.v1';
  readonly provider_id: string;
  readonly api: ApiId;
  readonly auth_class: AuthClass;
  readonly auth_source: AuthSource;
  readonly project_trusted: boolean;
}

export interface RouteResolutionResult {
  readonly schema_version: 'autopilot.route_resolution_result.v1';
  readonly matched: boolean;
  readonly route_policy_id: string | null;
  readonly route_policy_revision: number | null;
  readonly diagnostics: readonly RosterDiagnostic[];
  readonly result_sha256: Digest;
}

export function resolveRoute(
  request: RouteResolutionRequest,
  policies: readonly RoutePolicy[] = ROUTE_POLICIES,
): RouteResolutionResult {
  const diagnostics: RosterDiagnosticCode[] = [];
  let matchedPolicy: RoutePolicy | null = null;

  if (!request.project_trusted) {
    diagnostics.push('ROSTER_PROJECT_UNTRUSTED');
  }

  if (isForbiddenGatewayProvider(request.provider_id)) {
    diagnostics.push('ROSTER_AUTH_CHANNEL_FORBIDDEN', 'ROSTER_ROUTE_FORBIDDEN');
  } else {
    matchedPolicy = findRoutePolicyForProviderApi(request.provider_id, request.api, policies);
    if (matchedPolicy === null) {
      diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
    }
  }

  if (isAuthRequired(request.auth_class, request.auth_source)) {
    diagnostics.push('ROSTER_AUTH_REQUIRED');
  }

  if (matchedPolicy !== null) {
    if (!matchedPolicy.allowed_auth_classes.includes(request.auth_class)) {
      if (request.auth_class === 'api-key' || request.auth_source === 'environment') {
        diagnostics.push('ROSTER_AUTH_CHANNEL_FORBIDDEN');
      } else {
        diagnostics.push('ROSTER_AUTH_REQUIRED');
      }
    }
    if (
      !matchedPolicy.allowed_auth_sources.includes(request.auth_source) &&
      request.auth_source !== 'not-configured' &&
      request.auth_source !== 'unknown'
    ) {
      diagnostics.push('ROSTER_AUTH_CHANNEL_FORBIDDEN');
    }
    if (matchedPolicy.policy_state === 'blocked-live-certification') {
      diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
    }
    if (
      matchedPolicy.billing_class === 'metered-third-party-blocked' ||
      matchedPolicy.billing_class === 'forbidden-metered-gateway' ||
      matchedPolicy.billing_route_class === 'third-party-metered-blocked' ||
      matchedPolicy.billing_route_class === 'gateway-forbidden'
    ) {
      diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
    }
  }

  const uniqueDiagnostics = dedupeDiagnostics(diagnostics);
  const matched = matchedPolicy !== null && uniqueDiagnostics.length === 0;
  const preimage = {
    schema_version: 'autopilot.route_resolution_result.v1' as const,
    matched,
    route_policy_id: matchedPolicy?.route_policy_id ?? null,
    route_policy_revision: matchedPolicy?.revision ?? null,
    diagnostics: uniqueDiagnostics,
  };
  return {
    ...preimage,
    result_sha256: canonicalSha256(preimage),
  };
}

export interface RouteConformanceRequest {
  readonly provider_id: string;
  readonly api: ApiId;
  readonly auth_class: AuthClass;
  readonly auth_source: AuthSource;
  readonly billing_class: BillingClass;
  readonly billing_route_class: BillingRouteClass;
  readonly service_tier: ServiceTier;
  readonly cache_policy: CachePolicy;
  readonly system_prompt_profile: SystemPromptProfile;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
}

export function validateRouteConformance(
  request: RouteConformanceRequest,
  policies: readonly RoutePolicy[] = ROUTE_POLICIES,
): readonly RosterDiagnostic[] {
  const policy = findRoutePolicy(request.route_policy_id, request.route_policy_revision, policies);
  const diagnostics: RosterDiagnosticCode[] = [];
  if (policy === null) {
    diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
    return dedupeDiagnostics(diagnostics);
  }
  if (policy.provider_id !== request.provider_id || !policy.allowed_apis.includes(request.api)) {
    diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
  }
  if (!policy.allowed_auth_classes.includes(request.auth_class)) {
    diagnostics.push(request.auth_class === 'none' || request.auth_class === 'unknown' ? 'ROSTER_AUTH_REQUIRED' : 'ROSTER_AUTH_CHANNEL_FORBIDDEN');
  }
  if (
    !policy.allowed_auth_sources.includes(request.auth_source) &&
    request.auth_source !== 'not-configured' &&
    request.auth_source !== 'unknown'
  ) {
    diagnostics.push('ROSTER_AUTH_CHANNEL_FORBIDDEN');
  }
  if (policy.billing_class !== request.billing_class || policy.billing_route_class !== request.billing_route_class) {
    diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
  }
  if (!policy.allowed_service_tiers.some((tier) => tier === request.service_tier)) {
    diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
  }
  if (!policy.allowed_cache_policies.includes(request.cache_policy)) {
    diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
  }
  if (!policy.allowed_system_prompt_profiles.includes(request.system_prompt_profile)) {
    diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
  }
  if (policy.policy_state === 'blocked-live-certification') {
    diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
  }
  return dedupeDiagnostics(diagnostics);
}

function compareNullableStrings(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  return left.localeCompare(right);
}

function uniqueSorted<T>(values: readonly T[], compare: (left: T, right: T) => number): readonly T[] {
  const sorted = [...values].sort(compare);
  for (let index = 1; index < sorted.length; index += 1) {
    if (compare(sorted[index - 1] as T, sorted[index] as T) === 0) {
      throw new Error('duplicate unique inventory value');
    }
  }
  return sorted;
}

function sortLexicographic<T extends string>(values: readonly T[]): readonly T[] {
  return uniqueSorted(values, (left, right) => left.localeCompare(right));
}

function sortServiceTiers(values: readonly ServiceTier[]): readonly ServiceTier[] {
  return uniqueSorted(values, compareNullableStrings);
}

export function normalizeRosterInventory(input: Omit<RosterInventory, 'inventory_sha256'> & { readonly inventory_sha256?: Digest }): RosterInventory {
  const providers = uniqueSorted(input.providers, (left, right) => left.provider_id.localeCompare(right.provider_id)).map(
    (provider) => ({
      ...provider,
      models: uniqueSorted(
        provider.models,
        (left, right) => left.model_id.localeCompare(right.model_id) || left.api.localeCompare(right.api),
      ).map((model) => ({
        ...model,
        input_modalities: sortLexicographic(model.input_modalities),
        output_modalities: sortLexicographic(model.output_modalities),
        thinking_values: sortLexicographic(model.thinking_values),
        service_tiers: sortServiceTiers(model.service_tiers),
        cache_policies: sortLexicographic(model.cache_policies),
        system_prompt_profiles: sortLexicographic(model.system_prompt_profiles),
      })),
    }),
  );
  const withoutHash = {
    schema_version: input.schema_version,
    inventory_id: input.inventory_id,
    created_at: input.created_at,
    source: input.source,
    project_trusted: input.project_trusted,
    providers,
  };
  const inventory_sha256 = canonicalSha256(withoutHash);
  return {
    ...withoutHash,
    inventory_sha256,
  };
}

export function hashRosterInventory(input: Omit<RosterInventory, 'inventory_sha256'> | RosterInventory): Digest {
  return normalizeRosterInventory(input).inventory_sha256;
}

export function verifyRosterInventoryHash(inventory: RosterInventory): boolean {
  return normalizeRosterInventory(inventory).inventory_sha256 === inventory.inventory_sha256;
}

export function findInventoryProvider(inventory: RosterInventory, providerId: string): InventoryProvider | null {
  return inventory.providers.find((provider) => provider.provider_id === providerId) ?? null;
}

export function findInventoryModel(
  provider: InventoryProvider,
  modelId: string,
  api: ApiId,
): InventoryModel | null {
  return provider.models.find((model) => model.model_id === modelId && model.api === api) ?? null;
}
