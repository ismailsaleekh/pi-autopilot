import {
  ROSTER_ROLE_ORDER,
  type ApiId,
  type AuthClass,
  type AuthSource,
  type BillingClass,
  type BillingRouteClass,
  type CachePolicy,
  type Digest,
  type Modality,
  type QualificationState,
  type ReasoningCapability,
  type RosterRole,
  type ServiceTier,
  type SystemPromptProfile,
  type ThinkingValue,
  type ToolCapability,
  canonicalSha256,
} from '../route-policies.ts';

function deepFreezeKimiCodingAuthority<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return value;
  }
  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return value;
  }
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    deepFreezeKimiCodingAuthority((objectValue as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(objectValue) as T;
}

export const KIMI_CODING_PROVIDER_ID = 'kimi-coding' as const;
export const KIMI_CODING_ROUTE_POLICY_ID = 'kimi-coding-plan-v1' as const;
export const KIMI_CODING_ROUTE_POLICY_REVISION = 1 as const;
export const KIMI_CODING_BASE_URL = 'https://api.kimi.com/coding' as const;
export const KIMI_CODING_API = 'anthropic-messages' as const satisfies ApiId;
export const KIMI_CODING_AUTH_CLASS = 'api-key-plan-token' as const satisfies AuthClass;
export const KIMI_CODING_BILLING_CLASS = 'plan-token' as const satisfies BillingClass;
export const KIMI_CODING_BILLING_ROUTE_CLASS = 'plan-api-token' as const satisfies BillingRouteClass;
export const KIMI_CODING_SYSTEM_PROMPT_PROFILE = 'anthropic-autopilot-sanitized.v1' as const satisfies SystemPromptProfile;
export const KIMI_CODING_CACHE_POLICY = 'provider-default' as const satisfies CachePolicy;
export const KIMI_CODING_SERVICE_TIER = null as ServiceTier;
export const KIMI_CODING_USER_AGENT = 'KimiCLI/1.5' as const;

export type KimiCodingDeclaredModelId = 'K3' | 'kimi-for-coding' | 'highspeed';
export type KimiCodingRequestModelId = 'K3' | 'kimi-for-coding';
export type KimiCodingEvidenceKind = 'live-observed-request' | 'live-entitlement-billing' | 'synthetic-fixture';

export type KimiCodingDiagnosticCode =
  | 'KIMI_CODING_QUALIFICATION_REQUIRED'
  | 'KIMI_CODING_SYNTHETIC_NON_CERTIFYING'
  | 'KIMI_CODING_MISSING_ROLE'
  | 'KIMI_CODING_ROUTE_FORBIDDEN'
  | 'KIMI_CODING_API_MISMATCH'
  | 'KIMI_CODING_AUTH_FORBIDDEN'
  | 'KIMI_CODING_BILLING_REQUIRED'
  | 'KIMI_CODING_ENTITLEMENT_REQUIRED'
  | 'KIMI_CODING_REQUEST_PROFILE_DRIFT'
  | 'KIMI_CODING_OBSERVED_MODEL_MISMATCH'
  | 'KIMI_CODING_THINKING_MISMATCH'
  | 'KIMI_CODING_CONTEXT_MISMATCH'
  | 'KIMI_CODING_CACHE_MISMATCH'
  | 'KIMI_CODING_PROMPT_MISMATCH'
  | 'KIMI_CODING_TOOL_MISMATCH';

export interface KimiCodingRouteFacts {
  readonly schema_version: 'autopilot.kimi_coding_route.v1';
  readonly provider_id: typeof KIMI_CODING_PROVIDER_ID;
  readonly route_policy_id: typeof KIMI_CODING_ROUTE_POLICY_ID;
  readonly route_policy_revision: typeof KIMI_CODING_ROUTE_POLICY_REVISION;
  readonly base_url: typeof KIMI_CODING_BASE_URL;
  readonly api: typeof KIMI_CODING_API;
  readonly auth_class: typeof KIMI_CODING_AUTH_CLASS;
  readonly allowed_auth_classes: readonly [typeof KIMI_CODING_AUTH_CLASS];
  readonly allowed_auth_sources: readonly ['runtime', 'stored'];
  readonly billing_class: typeof KIMI_CODING_BILLING_CLASS;
  readonly billing_route_class: typeof KIMI_CODING_BILLING_ROUTE_CLASS;
  readonly service_tier: ServiceTier;
  readonly cache_policy: typeof KIMI_CODING_CACHE_POLICY;
  readonly system_prompt_profile: typeof KIMI_CODING_SYSTEM_PROMPT_PROFILE;
  readonly request_headers: readonly [{ readonly name: 'User-Agent'; readonly value: typeof KIMI_CODING_USER_AGENT }];
  readonly forbidden_gateways: readonly ['openrouter', 'arbitrary-api-key', 'metered-frontier'];
  readonly requires_live_entitlement_proof: true;
  readonly requires_live_billing_proof: true;
  readonly plan_token_grants_generic_api_key: false;
  readonly labels_rank_candidates: false;
  readonly network_calls_allowed_by_pack: false;
  readonly qualification_state: 'qualification-required';
}

export interface KimiCodingRoleTemplate {
  readonly role: RosterRole;
  readonly declared_model_id: KimiCodingDeclaredModelId;
  readonly request_model_id: KimiCodingRequestModelId;
  readonly highspeed_substitution: boolean;
  readonly api: typeof KIMI_CODING_API;
  readonly thinking: ThinkingValue;
  readonly service_tier: ServiceTier;
  readonly cache_policy: typeof KIMI_CODING_CACHE_POLICY;
  readonly system_prompt_profile: typeof KIMI_CODING_SYSTEM_PROMPT_PROFILE;
  readonly context_window: number;
  readonly max_output_tokens: number;
  readonly input_modalities: readonly Modality[];
  readonly output_modalities: readonly Modality[];
  readonly reasoning_capability: ReasoningCapability;
  readonly tool_capability: ToolCapability;
}

export interface KimiCodingRequestProfile {
  readonly schema_version: 'autopilot.kimi_coding_request_profile.v1';
  readonly role: RosterRole;
  readonly provider_id: typeof KIMI_CODING_PROVIDER_ID;
  readonly declared_model_id: KimiCodingDeclaredModelId;
  readonly model_id: KimiCodingRequestModelId;
  readonly model: `${typeof KIMI_CODING_PROVIDER_ID}/${KimiCodingRequestModelId}`;
  readonly api: typeof KIMI_CODING_API;
  readonly thinking: ThinkingValue;
  readonly service_tier: ServiceTier;
  readonly cache_policy: typeof KIMI_CODING_CACHE_POLICY;
  readonly system_prompt_profile: typeof KIMI_CODING_SYSTEM_PROMPT_PROFILE;
  readonly context_window: number;
  readonly max_output_tokens: number;
  readonly input_modalities: readonly Modality[];
  readonly output_modalities: readonly Modality[];
  readonly reasoning_capability: ReasoningCapability;
  readonly tool_capability: ToolCapability;
  readonly route_policy_id: typeof KIMI_CODING_ROUTE_POLICY_ID;
  readonly route_policy_revision: typeof KIMI_CODING_ROUTE_POLICY_REVISION;
  readonly highspeed_substitution: boolean;
  readonly request_profile_sha256: Digest;
}

export interface KimiCodingRouteObservation {
  readonly provider_id: string;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly base_url: string;
  readonly api: string;
  readonly auth_class: AuthClass | string;
  readonly auth_source: AuthSource | string;
  readonly billing_class: BillingClass | string;
  readonly billing_route_class: BillingRouteClass | string;
  readonly service_tier: ServiceTier | string;
  readonly cache_policy: CachePolicy | string;
  readonly system_prompt_profile: SystemPromptProfile | string;
}

export interface KimiCodingObservedRequestEvidence {
  readonly role: RosterRole | string;
  readonly evidence_kind: KimiCodingEvidenceKind;
  readonly provider_id: string;
  readonly requested_model_id: string;
  readonly executed_model_id: string;
  readonly api: string;
  readonly thinking: ThinkingValue | string;
  readonly service_tier: ServiceTier | string;
  readonly cache_policy: CachePolicy | string;
  readonly system_prompt_profile: SystemPromptProfile | string;
  readonly context_window: number;
  readonly max_output_tokens: number;
  readonly input_modalities: readonly string[];
  readonly output_modalities: readonly string[];
  readonly reasoning_capability: ReasoningCapability | string;
  readonly tool_capability: ToolCapability | string;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly system_prompt_sha256: Digest;
  readonly request_profile_sha256: Digest;
  readonly observed_profile_sha256: Digest;
}

export interface KimiCodingRoleEntitlementEvidence {
  readonly role: RosterRole | string;
  readonly evidence_kind: KimiCodingEvidenceKind;
  readonly entitlement_observed: boolean;
  readonly billing_observed: boolean;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
}

export interface KimiCodingQualificationInput {
  readonly route: KimiCodingRouteObservation;
  readonly observed_requests: readonly KimiCodingObservedRequestEvidence[];
  readonly entitlements: readonly KimiCodingRoleEntitlementEvidence[];
  readonly synthetic_fixture: boolean;
  readonly issued_at: string;
}

export interface KimiCodingRoleQualificationResult {
  readonly role: RosterRole;
  readonly state: 'pass' | 'fail';
  readonly diagnostics: readonly KimiCodingDiagnosticCode[];
}

export interface KimiCodingQualificationReport {
  readonly schema_version: 'autopilot.kimi_coding_qualification_report.v1';
  readonly provider_id: typeof KIMI_CODING_PROVIDER_ID;
  readonly route_policy_id: typeof KIMI_CODING_ROUTE_POLICY_ID;
  readonly route_policy_revision: typeof KIMI_CODING_ROUTE_POLICY_REVISION;
  readonly qualification_state: Extract<QualificationState, 'qualification-required' | 'w4-certified-ready'>;
  readonly certifying: boolean;
  readonly live_evidence_complete: boolean;
  readonly synthetic_fixture: boolean;
  readonly network_calls_performed: false;
  readonly diagnostics: readonly KimiCodingDiagnosticCode[];
  readonly role_results: readonly KimiCodingRoleQualificationResult[];
  readonly issued_at: string;
  readonly report_sha256: Digest;
}

const KIMI_ROLE_FACTS = {
  context_window: 262144,
  max_output_tokens: 32768,
  input_modalities: ['image', 'text'] as const,
  output_modalities: ['text'] as const,
  reasoning_capability: 'reasoning-supported' as const,
  tool_capability: 'tool-use-supported' as const,
};

export const KIMI_CODING_ROUTE_FACTS: KimiCodingRouteFacts = deepFreezeKimiCodingAuthority({
  schema_version: 'autopilot.kimi_coding_route.v1',
  provider_id: KIMI_CODING_PROVIDER_ID,
  route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
  route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
  base_url: KIMI_CODING_BASE_URL,
  api: KIMI_CODING_API,
  auth_class: KIMI_CODING_AUTH_CLASS,
  allowed_auth_classes: [KIMI_CODING_AUTH_CLASS],
  allowed_auth_sources: ['runtime', 'stored'],
  billing_class: KIMI_CODING_BILLING_CLASS,
  billing_route_class: KIMI_CODING_BILLING_ROUTE_CLASS,
  service_tier: KIMI_CODING_SERVICE_TIER,
  cache_policy: KIMI_CODING_CACHE_POLICY,
  system_prompt_profile: KIMI_CODING_SYSTEM_PROMPT_PROFILE,
  request_headers: [{ name: 'User-Agent', value: KIMI_CODING_USER_AGENT }],
  forbidden_gateways: ['openrouter', 'arbitrary-api-key', 'metered-frontier'],
  requires_live_entitlement_proof: true,
  requires_live_billing_proof: true,
  plan_token_grants_generic_api_key: false,
  labels_rank_candidates: false,
  network_calls_allowed_by_pack: false,
  qualification_state: 'qualification-required',
});

function kimiCodingRequestModelId(declaredModelId: KimiCodingDeclaredModelId): KimiCodingRequestModelId {
  return declaredModelId === 'highspeed' ? 'kimi-for-coding' : declaredModelId;
}

function template(
  role: RosterRole,
  declared_model_id: KimiCodingDeclaredModelId,
  thinking: ThinkingValue,
): KimiCodingRoleTemplate {
  const request_model_id = kimiCodingRequestModelId(declared_model_id);
  return {
    role,
    declared_model_id,
    request_model_id,
    highspeed_substitution: declared_model_id === 'highspeed',
    api: KIMI_CODING_API,
    thinking,
    service_tier: KIMI_CODING_SERVICE_TIER,
    cache_policy: KIMI_CODING_CACHE_POLICY,
    system_prompt_profile: KIMI_CODING_SYSTEM_PROMPT_PROFILE,
    ...KIMI_ROLE_FACTS,
  };
}

export const KIMI_CODING_ROLE_TEMPLATES: readonly KimiCodingRoleTemplate[] = deepFreezeKimiCodingAuthority([
  template('parent', 'K3', 'xhigh'),
  template('strategy', 'K3', 'xhigh'),
  template('implement', 'kimi-for-coding', 'high'),
  template('validate', 'K3', 'xhigh'),
  template('fix', 'kimi-for-coding', 'high'),
  template('adjudicate', 'K3', 'xhigh'),
  template('bughunt', 'K3', 'xhigh'),
  template('extract', 'highspeed', 'high'),
]);

deepFreezeKimiCodingAuthority(ROSTER_ROLE_ORDER);

export function substituteKimiCodingHighspeedModel(modelId: KimiCodingDeclaredModelId | string): string {
  return modelId === 'highspeed' ? 'kimi-for-coding' : modelId;
}

export function getKimiCodingRoleTemplate(role: RosterRole): KimiCodingRoleTemplate {
  const found = KIMI_CODING_ROLE_TEMPLATES.find((templateEntry) => templateEntry.role === role);
  if (found === undefined) {
    throw new Error(`missing Kimi Coding role template for ${role}`);
  }
  return found;
}

export function kimiCodingRequestProfileForRole(role: RosterRole): KimiCodingRequestProfile {
  const roleTemplate = getKimiCodingRoleTemplate(role);
  const withoutHash = {
    schema_version: 'autopilot.kimi_coding_request_profile.v1' as const,
    role: roleTemplate.role,
    provider_id: KIMI_CODING_PROVIDER_ID,
    declared_model_id: roleTemplate.declared_model_id,
    model_id: roleTemplate.request_model_id,
    model: `${KIMI_CODING_PROVIDER_ID}/${roleTemplate.request_model_id}` as const,
    api: roleTemplate.api,
    thinking: roleTemplate.thinking,
    service_tier: roleTemplate.service_tier,
    cache_policy: roleTemplate.cache_policy,
    system_prompt_profile: roleTemplate.system_prompt_profile,
    context_window: roleTemplate.context_window,
    max_output_tokens: roleTemplate.max_output_tokens,
    input_modalities: roleTemplate.input_modalities,
    output_modalities: roleTemplate.output_modalities,
    reasoning_capability: roleTemplate.reasoning_capability,
    tool_capability: roleTemplate.tool_capability,
    route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
    route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
    highspeed_substitution: roleTemplate.highspeed_substitution,
  };
  return { ...withoutHash, request_profile_sha256: canonicalSha256(withoutHash) };
}

export function allKimiCodingRequestProfiles(): readonly KimiCodingRequestProfile[] {
  return ROSTER_ROLE_ORDER.map((role) => kimiCodingRequestProfileForRole(role));
}

function uniqueSortedDiagnostics(diagnostics: readonly KimiCodingDiagnosticCode[]): readonly KimiCodingDiagnosticCode[] {
  return [...new Set(diagnostics)].sort((left, right) => left.localeCompare(right));
}

export function exactKimiCodingRouteObservation(auth_source: AuthSource = 'runtime'): KimiCodingRouteObservation {
  return {
    provider_id: KIMI_CODING_PROVIDER_ID,
    route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
    route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
    base_url: KIMI_CODING_BASE_URL,
    api: KIMI_CODING_API,
    auth_class: KIMI_CODING_AUTH_CLASS,
    auth_source,
    billing_class: KIMI_CODING_BILLING_CLASS,
    billing_route_class: KIMI_CODING_BILLING_ROUTE_CLASS,
    service_tier: KIMI_CODING_SERVICE_TIER,
    cache_policy: KIMI_CODING_CACHE_POLICY,
    system_prompt_profile: KIMI_CODING_SYSTEM_PROMPT_PROFILE,
  };
}

export function validateKimiCodingRouteObservation(route: KimiCodingRouteObservation): readonly KimiCodingDiagnosticCode[] {
  const diagnostics: KimiCodingDiagnosticCode[] = [];
  const forbiddenGatewayProvider =
    route.provider_id === 'openrouter' || route.provider_id === 'arbitrary-api-key' || route.provider_id === 'metered-frontier';
  if (forbiddenGatewayProvider) {
    diagnostics.push('KIMI_CODING_ROUTE_FORBIDDEN');
  }
  if (
    route.provider_id !== KIMI_CODING_PROVIDER_ID ||
    route.route_policy_id !== KIMI_CODING_ROUTE_POLICY_ID ||
    route.route_policy_revision !== KIMI_CODING_ROUTE_POLICY_REVISION ||
    route.base_url !== KIMI_CODING_BASE_URL
  ) {
    diagnostics.push('KIMI_CODING_ROUTE_FORBIDDEN');
  }
  if (route.api !== KIMI_CODING_API) {
    diagnostics.push('KIMI_CODING_API_MISMATCH');
  }
  if (route.auth_class !== KIMI_CODING_AUTH_CLASS || (route.auth_source !== 'runtime' && route.auth_source !== 'stored')) {
    diagnostics.push('KIMI_CODING_AUTH_FORBIDDEN');
  }
  if (route.billing_class !== KIMI_CODING_BILLING_CLASS || route.billing_route_class !== KIMI_CODING_BILLING_ROUTE_CLASS) {
    diagnostics.push('KIMI_CODING_BILLING_REQUIRED');
  }
  if (route.service_tier !== KIMI_CODING_SERVICE_TIER) {
    diagnostics.push('KIMI_CODING_ROUTE_FORBIDDEN');
  }
  if (route.cache_policy !== KIMI_CODING_CACHE_POLICY) {
    diagnostics.push('KIMI_CODING_CACHE_MISMATCH');
  }
  if (route.system_prompt_profile !== KIMI_CODING_SYSTEM_PROMPT_PROFILE) {
    diagnostics.push('KIMI_CODING_PROMPT_MISMATCH');
  }
  return uniqueSortedDiagnostics(diagnostics);
}

function arraysEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function observedPreimage(observed: Omit<KimiCodingObservedRequestEvidence, 'observed_profile_sha256'>): Omit<KimiCodingObservedRequestEvidence, 'observed_profile_sha256'> {
  return observed;
}

export function makeKimiCodingObservedEvidence(
  profile: KimiCodingRequestProfile,
  options: Partial<Omit<KimiCodingObservedRequestEvidence, 'role' | 'observed_profile_sha256'>> & {
    readonly role?: RosterRole | string;
  } = {},
): KimiCodingObservedRequestEvidence {
  const withoutHash = observedPreimage({
    role: options.role ?? profile.role,
    evidence_kind: options.evidence_kind ?? 'live-observed-request',
    provider_id: options.provider_id ?? profile.provider_id,
    requested_model_id: options.requested_model_id ?? profile.model_id,
    executed_model_id: options.executed_model_id ?? profile.model_id,
    api: options.api ?? profile.api,
    thinking: options.thinking ?? profile.thinking,
    service_tier: options.service_tier ?? profile.service_tier,
    cache_policy: options.cache_policy ?? profile.cache_policy,
    system_prompt_profile: options.system_prompt_profile ?? profile.system_prompt_profile,
    context_window: options.context_window ?? profile.context_window,
    max_output_tokens: options.max_output_tokens ?? profile.max_output_tokens,
    input_modalities: options.input_modalities ?? profile.input_modalities,
    output_modalities: options.output_modalities ?? profile.output_modalities,
    reasoning_capability: options.reasoning_capability ?? profile.reasoning_capability,
    tool_capability: options.tool_capability ?? profile.tool_capability,
    route_policy_id: options.route_policy_id ?? profile.route_policy_id,
    route_policy_revision: options.route_policy_revision ?? profile.route_policy_revision,
    system_prompt_sha256: options.system_prompt_sha256 ?? (`sha256:${'a'.repeat(64)}` as Digest),
    request_profile_sha256: options.request_profile_sha256 ?? profile.request_profile_sha256,
  });
  return { ...withoutHash, observed_profile_sha256: canonicalSha256(withoutHash) };
}

export function makeKimiCodingRoleEntitlementEvidence(
  role: RosterRole,
  options: Partial<Omit<KimiCodingRoleEntitlementEvidence, 'role'>> = {},
): KimiCodingRoleEntitlementEvidence {
  return {
    role,
    evidence_kind: options.evidence_kind ?? 'live-entitlement-billing',
    entitlement_observed: options.entitlement_observed ?? true,
    billing_observed: options.billing_observed ?? true,
    route_policy_id: options.route_policy_id ?? KIMI_CODING_ROUTE_POLICY_ID,
    route_policy_revision: options.route_policy_revision ?? KIMI_CODING_ROUTE_POLICY_REVISION,
  };
}

function validateObservedProfile(role: RosterRole, observed: KimiCodingObservedRequestEvidence): readonly KimiCodingDiagnosticCode[] {
  const expected = kimiCodingRequestProfileForRole(role);
  const diagnostics: KimiCodingDiagnosticCode[] = [];
  const recomputedObservedSha = canonicalSha256(observedPreimage({
    role: observed.role,
    evidence_kind: observed.evidence_kind,
    provider_id: observed.provider_id,
    requested_model_id: observed.requested_model_id,
    executed_model_id: observed.executed_model_id,
    api: observed.api,
    thinking: observed.thinking,
    service_tier: observed.service_tier,
    cache_policy: observed.cache_policy,
    system_prompt_profile: observed.system_prompt_profile,
    context_window: observed.context_window,
    max_output_tokens: observed.max_output_tokens,
    input_modalities: observed.input_modalities,
    output_modalities: observed.output_modalities,
    reasoning_capability: observed.reasoning_capability,
    tool_capability: observed.tool_capability,
    route_policy_id: observed.route_policy_id,
    route_policy_revision: observed.route_policy_revision,
    system_prompt_sha256: observed.system_prompt_sha256,
    request_profile_sha256: observed.request_profile_sha256,
  }));
  if (observed.evidence_kind !== 'live-observed-request') {
    diagnostics.push('KIMI_CODING_SYNTHETIC_NON_CERTIFYING');
  }
  if (recomputedObservedSha !== observed.observed_profile_sha256 || observed.request_profile_sha256 !== expected.request_profile_sha256) {
    diagnostics.push('KIMI_CODING_REQUEST_PROFILE_DRIFT');
  }
  if (observed.provider_id !== expected.provider_id || observed.route_policy_id !== expected.route_policy_id || observed.route_policy_revision !== expected.route_policy_revision) {
    diagnostics.push('KIMI_CODING_ROUTE_FORBIDDEN');
  }
  if (observed.api !== expected.api) {
    diagnostics.push('KIMI_CODING_API_MISMATCH');
  }
  if (observed.requested_model_id !== expected.model_id || observed.executed_model_id !== expected.model_id) {
    diagnostics.push('KIMI_CODING_OBSERVED_MODEL_MISMATCH');
  }
  if (observed.thinking !== expected.thinking) {
    diagnostics.push('KIMI_CODING_THINKING_MISMATCH');
  }
  if (observed.cache_policy !== expected.cache_policy) {
    diagnostics.push('KIMI_CODING_CACHE_MISMATCH');
  }
  if (observed.system_prompt_profile !== expected.system_prompt_profile) {
    diagnostics.push('KIMI_CODING_PROMPT_MISMATCH');
  }
  if (
    observed.context_window !== expected.context_window ||
    observed.max_output_tokens !== expected.max_output_tokens ||
    !arraysEqual(observed.input_modalities, expected.input_modalities) ||
    !arraysEqual(observed.output_modalities, expected.output_modalities)
  ) {
    diagnostics.push('KIMI_CODING_CONTEXT_MISMATCH');
  }
  if (observed.reasoning_capability !== expected.reasoning_capability || observed.tool_capability !== expected.tool_capability) {
    diagnostics.push('KIMI_CODING_TOOL_MISMATCH');
  }
  return uniqueSortedDiagnostics(diagnostics);
}

function validateEntitlement(role: RosterRole, entitlement: KimiCodingRoleEntitlementEvidence): readonly KimiCodingDiagnosticCode[] {
  const diagnostics: KimiCodingDiagnosticCode[] = [];
  if (entitlement.evidence_kind !== 'live-entitlement-billing') {
    diagnostics.push('KIMI_CODING_SYNTHETIC_NON_CERTIFYING');
  }
  if (!entitlement.entitlement_observed) {
    diagnostics.push('KIMI_CODING_ENTITLEMENT_REQUIRED');
  }
  if (!entitlement.billing_observed) {
    diagnostics.push('KIMI_CODING_BILLING_REQUIRED');
  }
  if (entitlement.route_policy_id !== KIMI_CODING_ROUTE_POLICY_ID || entitlement.route_policy_revision !== KIMI_CODING_ROUTE_POLICY_REVISION) {
    diagnostics.push('KIMI_CODING_ROUTE_FORBIDDEN');
  }
  void role;
  return uniqueSortedDiagnostics(diagnostics);
}

function singleByRole<T extends { readonly role: RosterRole | string }>(items: readonly T[], role: RosterRole): T | null {
  const matches = items.filter((item) => item.role === role);
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function buildKimiCodingQualification(input: KimiCodingQualificationInput): KimiCodingQualificationReport {
  const globalDiagnostics: KimiCodingDiagnosticCode[] = [...validateKimiCodingRouteObservation(input.route)];
  if (input.synthetic_fixture) {
    globalDiagnostics.push('KIMI_CODING_SYNTHETIC_NON_CERTIFYING');
  }

  const roleResults: KimiCodingRoleQualificationResult[] = [];
  for (const role of ROSTER_ROLE_ORDER) {
    const diagnostics: KimiCodingDiagnosticCode[] = [];
    const observed = singleByRole(input.observed_requests, role);
    const entitlement = singleByRole(input.entitlements, role);
    if (observed === null) {
      diagnostics.push('KIMI_CODING_MISSING_ROLE');
    } else {
      diagnostics.push(...validateObservedProfile(role, observed));
    }
    if (entitlement === null) {
      diagnostics.push('KIMI_CODING_MISSING_ROLE', 'KIMI_CODING_ENTITLEMENT_REQUIRED', 'KIMI_CODING_BILLING_REQUIRED');
    } else {
      diagnostics.push(...validateEntitlement(role, entitlement));
    }
    const unique = uniqueSortedDiagnostics(diagnostics);
    roleResults.push({ role, state: unique.length === 0 ? 'pass' : 'fail', diagnostics: unique });
  }

  const preliminaryDiagnostics = uniqueSortedDiagnostics([...globalDiagnostics, ...roleResults.flatMap((result) => result.diagnostics)]);
  const live_evidence_complete = preliminaryDiagnostics.length === 0;
  const diagnostics = live_evidence_complete
    ? preliminaryDiagnostics
    : uniqueSortedDiagnostics([...preliminaryDiagnostics, 'KIMI_CODING_QUALIFICATION_REQUIRED']);
  const qualification_state: Extract<QualificationState, 'qualification-required' | 'w4-certified-ready'> = live_evidence_complete
    ? 'w4-certified-ready'
    : 'qualification-required';
  const withoutHash = {
    schema_version: 'autopilot.kimi_coding_qualification_report.v1' as const,
    provider_id: KIMI_CODING_PROVIDER_ID,
    route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
    route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
    qualification_state,
    certifying: live_evidence_complete,
    live_evidence_complete,
    synthetic_fixture: input.synthetic_fixture,
    network_calls_performed: false as const,
    diagnostics,
    role_results: roleResults,
    issued_at: input.issued_at,
  };
  return { ...withoutHash, report_sha256: canonicalSha256(withoutHash) };
}

export function assertKimiCodingRoleTemplateCompleteness(templates: readonly KimiCodingRoleTemplate[] = KIMI_CODING_ROLE_TEMPLATES): void {
  const roles = templates.map((roleTemplate) => roleTemplate.role);
  if (JSON.stringify(roles) !== JSON.stringify(ROSTER_ROLE_ORDER)) {
    throw new Error(`Kimi Coding role templates must cover ROLE_ORDER exactly; found ${roles.join(',')}`);
  }
  for (const roleTemplate of templates) {
    if (roleTemplate.api !== KIMI_CODING_API) {
      throw new Error(`Kimi Coding role ${roleTemplate.role} must use anthropic-messages`);
    }
    if (roleTemplate.cache_policy !== KIMI_CODING_CACHE_POLICY || roleTemplate.system_prompt_profile !== KIMI_CODING_SYSTEM_PROMPT_PROFILE) {
      throw new Error(`Kimi Coding role ${roleTemplate.role} request facts drifted`);
    }
  }
}

export const KIMI_CODING_LABELS = deepFreezeKimiCodingAuthority({
  schema_version: 'autopilot.kimi_coding_labels.v1' as const,
  provider_label: 'Kimi For Coding',
  model_labels: ['K3', 'kimi-for-coding', 'highspeed'] as const,
  labels_rank_candidates: false,
});
