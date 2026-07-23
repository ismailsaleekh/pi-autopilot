import {
  PHASE37_PACKAGE_VERSION,
  PHASE37_PI_VERSION,
  ROSTER_ROLE_ORDER,
  canonicalSha256,
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
} from '../route-policies.ts';
import {
  PROVIDER_RECIPES,
  type EvidenceRef,
  type ObservedProfile,
  type ProfileTemplate,
  type ProviderRecipe,
  type QualificationManifest,
  type RequestProfile,
  type RoleTemplate,
} from '../provider-recipes.ts';

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
export const KIMI_CODING_RECIPE_ID = 'kimi-coding-plan' as const;
export const KIMI_CODING_RECIPE_REVISION = 1 as const;
export const KIMI_CODING_ROUTE_POLICY_ID = 'kimi-coding-plan-v1' as const;
export const KIMI_CODING_ROUTE_POLICY_REVISION = 1 as const;
export const KIMI_CODING_PROFILE_ID = 'precision' as const;
export const KIMI_CODING_BASE_URL = 'https://api.kimi.com/coding' as const;
export const KIMI_CODING_API = 'openai-completions' as const satisfies ApiId;
export const KIMI_CODING_AUTH_CLASS = 'api-key-plan-token' as const satisfies AuthClass;
export const KIMI_CODING_BILLING_CLASS = 'plan-token' as const satisfies BillingClass;
export const KIMI_CODING_BILLING_ROUTE_CLASS = 'plan-api-token' as const satisfies BillingRouteClass;
export const KIMI_CODING_AUTH_MATERIAL_SHAPE = 'api-key-shaped-plan-token' as const;
export const KIMI_CODING_SYSTEM_PROMPT_PROFILE = 'pi-default.v1' as const satisfies SystemPromptProfile;
export const KIMI_CODING_CACHE_POLICY = 'provider-default' as const satisfies CachePolicy;
export const KIMI_CODING_SERVICE_TIER = null as ServiceTier;
export const KIMI_CODING_ISSUED_AT = '2026-07-23T00:00:00.000Z' as const;
export const KIMI_CODING_EXPIRES_AT = '2026-08-22T00:00:00.000Z' as const;
export const KIMI_CODING_EVALUATION_SCHEMA_VERSION = 'autopilot.kimi_coding_qualification_evaluation.v1' as const;
export const KIMI_CODING_MANIFEST_CANDIDATE_SCHEMA_VERSION = 'autopilot.kimi_coding_qualification_manifest_candidate.v1' as const;
export const KIMI_CODING_OFFLINE_REPORT_SCHEMA_VERSION = 'autopilot.kimi_coding_w4_offline_qualification_report.v1' as const;
export const KIMI_CODING_SYNTHETIC_FIXTURE_SCHEMA_VERSION = 'autopilot.kimi_coding_provider_fixture.v1' as const;

const TEXT_MODALITIES = ['text'] as const satisfies readonly Modality[];
const FORBIDDEN_GATEWAYS = ['arbitrary-api-key', 'metered-frontier', 'openrouter'] as const;
const ALLOWED_AUTH_SOURCES = ['runtime', 'stored'] as const satisfies readonly AuthSource[];

export const KIMI_CODING_FORBIDDEN_GATEWAYS = deepFreezeKimiCodingAuthority(FORBIDDEN_GATEWAYS);
export const KIMI_CODING_ALLOWED_AUTH_SOURCES = deepFreezeKimiCodingAuthority(ALLOWED_AUTH_SOURCES);

export type KimiCodingFrozenModelId = 'kimi-k3' | 'kimi-for-coding' | 'kimi-for-coding-highspeed';
export type KimiCodingEvidenceSource = 'synthetic-fixture' | 'live-post-w3-witness';
export type KimiCodingAuthMaterialShape =
  | typeof KIMI_CODING_AUTH_MATERIAL_SHAPE
  | 'generic-api-key'
  | 'oauth-token'
  | 'unknown';
export type KimiCodingProofKind = 'entitlement' | 'billing-route';

export type KimiCodingQualificationIssueCode =
  | 'KIMI_CODING_API_MISMATCH'
  | 'KIMI_CODING_AUTH_FORBIDDEN'
  | 'KIMI_CODING_AUTH_SOURCE_FORBIDDEN'
  | 'KIMI_CODING_AUTHENTICATED_W3_EXECUTION_REQUIRED'
  | 'KIMI_CODING_BILLING_EVIDENCE_REQUIRED'
  | 'KIMI_CODING_BILLING_REQUIRED'
  | 'KIMI_CODING_CACHE_MISMATCH'
  | 'KIMI_CODING_CONTEXT_MISMATCH'
  | 'KIMI_CODING_ENTITLEMENT_EVIDENCE_REQUIRED'
  | 'KIMI_CODING_ENTITLEMENT_REQUIRED'
  | 'KIMI_CODING_EVIDENCE_DIGEST_REQUIRED'
  | 'KIMI_CODING_EVIDENCE_REF_REQUIRED'
  | 'KIMI_CODING_EVIDENCE_REF_SECRET_FORBIDDEN'
  | 'KIMI_CODING_EVIDENCE_REF_UNTRUSTED'
  | 'KIMI_CODING_GENERIC_API_KEY_FORBIDDEN'
  | 'KIMI_CODING_LIVE_W3_EVIDENCE_REQUIRED'
  | 'KIMI_CODING_MANIFEST_BINDING_MISMATCH'
  | 'KIMI_CODING_MANIFEST_HASH_MISMATCH'
  | 'KIMI_CODING_MISSING_ROLE'
  | 'KIMI_CODING_MIXED_ROUTE_FORBIDDEN'
  | 'KIMI_CODING_MODEL_SUBSTITUTION_FORBIDDEN'
  | 'KIMI_CODING_NETWORK_EVIDENCE_FORBIDDEN'
  | 'KIMI_CODING_NO_FALLBACK_REQUIRED'
  | 'KIMI_CODING_OBSERVED_MODEL_MISMATCH'
  | 'KIMI_CODING_OBSERVED_PROFILE_MISMATCH'
  | 'KIMI_CODING_OLD_DIVERGENT_PROFILE_FORBIDDEN'
  | 'KIMI_CODING_PLAN_TOKEN_PROOF_REQUIRED'
  | 'KIMI_CODING_PROMPT_MISMATCH'
  | 'KIMI_CODING_QUALIFICATION_REQUIRED'
  | 'KIMI_CODING_REPORT_HASH_MISMATCH'
  | 'KIMI_CODING_REQUEST_PROFILE_DRIFT'
  | 'KIMI_CODING_REQUEST_PROFILE_MISMATCH'
  | 'KIMI_CODING_REQUIRED_EVIDENCE_MISMATCH'
  | 'KIMI_CODING_ROUTE_FORBIDDEN'
  | 'KIMI_CODING_ROUTE_TOKEN_SHAPE_IS_NOT_API_KEY_PERMISSION'
  | 'KIMI_CODING_SYNTHETIC_NON_CERTIFYING'
  | 'KIMI_CODING_THINKING_MISMATCH'
  | 'KIMI_CODING_TOOL_MISMATCH';

export type KimiCodingDiagnosticCode = KimiCodingQualificationIssueCode;

export interface KimiCodingRouteFacts {
  readonly schema_version: 'autopilot.kimi_coding_route.v1';
  readonly provider_id: typeof KIMI_CODING_PROVIDER_ID;
  readonly recipe_id: typeof KIMI_CODING_RECIPE_ID;
  readonly recipe_revision: typeof KIMI_CODING_RECIPE_REVISION;
  readonly profile_id: typeof KIMI_CODING_PROFILE_ID;
  readonly route_policy_id: typeof KIMI_CODING_ROUTE_POLICY_ID;
  readonly route_policy_revision: typeof KIMI_CODING_ROUTE_POLICY_REVISION;
  readonly base_url: typeof KIMI_CODING_BASE_URL;
  readonly api: typeof KIMI_CODING_API;
  readonly auth_class: typeof KIMI_CODING_AUTH_CLASS;
  readonly auth_material_shape: typeof KIMI_CODING_AUTH_MATERIAL_SHAPE;
  readonly allowed_auth_classes: readonly [typeof KIMI_CODING_AUTH_CLASS];
  readonly allowed_auth_sources: readonly ['runtime', 'stored'];
  readonly billing_class: typeof KIMI_CODING_BILLING_CLASS;
  readonly billing_route_class: typeof KIMI_CODING_BILLING_ROUTE_CLASS;
  readonly service_tier: ServiceTier;
  readonly cache_policy: typeof KIMI_CODING_CACHE_POLICY;
  readonly system_prompt_profile: typeof KIMI_CODING_SYSTEM_PROMPT_PROFILE;
  readonly allowed_apis: readonly [typeof KIMI_CODING_API];
  readonly allowed_service_tiers: readonly [null];
  readonly allowed_cache_policies: readonly [typeof KIMI_CODING_CACHE_POLICY];
  readonly allowed_system_prompt_profiles: readonly [typeof KIMI_CODING_SYSTEM_PROMPT_PROFILE];
  readonly forbidden_gateways: readonly ['arbitrary-api-key', 'metered-frontier', 'openrouter'];
  readonly requires_live_entitlement_proof: true;
  readonly requires_live_billing_proof: true;
  readonly requires_w3_authenticated_execution_refs: true;
  readonly plan_token_grants_generic_api_key: false;
  readonly labels_rank_candidates: false;
  readonly network_calls_allowed_by_pack: false;
  readonly qualification_state: 'qualification-required';
  readonly minimum_pi_version: typeof PHASE37_PI_VERSION;
  readonly w0_recipe_sha256: Digest;
}

export interface KimiCodingRouteObservation {
  readonly provider_id: string;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly base_url: string;
  readonly api: string;
  readonly auth_class: AuthClass | string;
  readonly auth_source: AuthSource | string;
  readonly auth_material_shape: KimiCodingAuthMaterialShape | string;
  readonly billing_class: BillingClass | string;
  readonly billing_route_class: BillingRouteClass | string;
  readonly service_tier: ServiceTier | string;
  readonly cache_policy: CachePolicy | string;
  readonly system_prompt_profile: SystemPromptProfile | string;
}

export interface KimiCodingQualificationProof {
  readonly proof_id: string;
  readonly proof_kind: KimiCodingProofKind;
  readonly provider_id: string;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly auth_class: AuthClass;
  readonly auth_source: AuthSource;
  readonly auth_material_shape: KimiCodingAuthMaterialShape;
  readonly billing_class: BillingClass;
  readonly billing_route_class: BillingRouteClass;
  readonly no_fallback: boolean;
  readonly observed_at: string;
  readonly evidence_ref: EvidenceRef;
}

export interface KimiCodingRoleExecutionWitness {
  readonly witness_id: string;
  readonly role: RosterRole;
  readonly provider_id: string;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly authenticated: boolean;
  readonly auth_class: AuthClass;
  readonly auth_source: AuthSource;
  readonly auth_material_shape: KimiCodingAuthMaterialShape;
  readonly billing_class: BillingClass;
  readonly billing_route_class: BillingRouteClass;
  readonly request_profile: RequestProfile;
  readonly observed_profile: ObservedProfile;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly no_fallback: boolean;
}

export interface KimiCodingQualificationInput {
  readonly schema_version: 'autopilot.kimi_coding_qualification_input.v1';
  readonly evidence_source: KimiCodingEvidenceSource;
  readonly route: KimiCodingRouteObservation;
  readonly gateway_id: string | null;
  readonly entitlement_proof: KimiCodingQualificationProof | null;
  readonly billing_route_proof: KimiCodingQualificationProof | null;
  readonly role_witnesses: readonly KimiCodingRoleExecutionWitness[];
  readonly no_fallback: boolean;
}

export interface KimiCodingQualificationIssue {
  readonly code: KimiCodingQualificationIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface KimiCodingQualificationEvaluation {
  readonly schema_version: typeof KIMI_CODING_EVALUATION_SCHEMA_VERSION;
  readonly provider_id: typeof KIMI_CODING_PROVIDER_ID;
  readonly route_policy_id: typeof KIMI_CODING_ROUTE_POLICY_ID;
  readonly route_policy_revision: typeof KIMI_CODING_ROUTE_POLICY_REVISION;
  readonly evidence_source: KimiCodingEvidenceSource;
  readonly structural_pass: boolean;
  readonly certification_ready: boolean;
  readonly qualification_state: QualificationState;
  readonly non_certifying: boolean;
  readonly synthetic_fixture_non_certifying: boolean;
  readonly no_network: true;
  readonly pending_live_post_w3_witnesses: readonly string[];
  readonly issues: readonly KimiCodingQualificationIssue[];
  readonly evaluation_sha256: Digest;
}

export interface KimiCodingManifestCandidate {
  readonly schema_version: typeof KIMI_CODING_MANIFEST_CANDIDATE_SCHEMA_VERSION;
  readonly provider_id: typeof KIMI_CODING_PROVIDER_ID;
  readonly recipe_id: typeof KIMI_CODING_RECIPE_ID;
  readonly recipe_revision: typeof KIMI_CODING_RECIPE_REVISION;
  readonly route_policy_id: typeof KIMI_CODING_ROUTE_POLICY_ID;
  readonly route_policy_revision: typeof KIMI_CODING_ROUTE_POLICY_REVISION;
  readonly qualification_state: QualificationState;
  readonly certification_ready: boolean;
  readonly non_certifying: boolean;
  readonly synthetic_fixture_non_certifying: boolean;
  readonly no_network: true;
  readonly pending_live_post_w3_witnesses: readonly string[];
  readonly evaluation: KimiCodingQualificationEvaluation;
  readonly certification_manifest: QualificationManifest;
  readonly manifest_candidate_sha256: Digest;
}

export interface KimiCodingOfflineQualificationReport {
  readonly schema_version: typeof KIMI_CODING_OFFLINE_REPORT_SCHEMA_VERSION;
  readonly phase: 'phase37-w4';
  readonly provider_id: typeof KIMI_CODING_PROVIDER_ID;
  readonly recipe_id: typeof KIMI_CODING_RECIPE_ID;
  readonly route_policy_id: typeof KIMI_CODING_ROUTE_POLICY_ID;
  readonly offline: true;
  readonly network_calls: 0;
  readonly network_calls_performed: false;
  readonly qualification_state: QualificationState;
  readonly certifying: false;
  readonly launch_ready: false;
  readonly synthetic_fixture_non_certifying: true;
  readonly live_provider_certification_asserted: false;
  readonly synthetic_fixtures_certifying: false;
  readonly openrouter_or_arbitrary_keys_allowed: false;
  readonly generic_api_key_permission_allowed: false;
  readonly model_substitution_allowed: false;
  readonly pending_live_post_w3_witnesses: readonly string[];
  readonly report: string;
  readonly route_facts: KimiCodingRouteFacts;
  readonly role_templates: readonly RoleTemplate[];
  readonly manifest_candidate: KimiCodingManifestCandidate;
  readonly report_sha256: Digest;
}

export interface KimiCodingRoleQualificationResult {
  readonly role: RosterRole;
  readonly state: 'pass' | 'fail' | 'synthetic-pass';
  readonly diagnostics: readonly KimiCodingDiagnosticCode[];
}

export interface KimiCodingQualificationReport {
  readonly schema_version: typeof KIMI_CODING_EVALUATION_SCHEMA_VERSION;
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
  readonly issued_at: typeof KIMI_CODING_ISSUED_AT;
  readonly expires_at: typeof KIMI_CODING_EXPIRES_AT;
  readonly report_sha256: Digest;
}

export const KIMI_CODING_PROVIDER_RECIPE: ProviderRecipe = (() => {
  const recipe = PROVIDER_RECIPES.find(
    (candidate) => candidate.recipe_id === KIMI_CODING_RECIPE_ID && candidate.recipe_revision === KIMI_CODING_RECIPE_REVISION,
  );
  if (recipe === undefined) {
    throw new Error('Kimi Coding W0 recipe authority is missing');
  }
  return recipe;
})();

const KIMI_CODING_PROVIDER_PROFILE: ProfileTemplate = (() => {
  const profile = KIMI_CODING_PROVIDER_RECIPE.profile_templates.find((candidate) => candidate.profile_id === KIMI_CODING_PROFILE_ID);
  if (profile === undefined) {
    throw new Error('Kimi Coding W0 precision profile is missing');
  }
  return profile;
})();

function cloneRoleTemplate(template: RoleTemplate): RoleTemplate {
  return {
    ...template,
    input_modalities: [...template.input_modalities],
    output_modalities: [...template.output_modalities],
  };
}

export const KIMI_CODING_ROLE_TEMPLATES: readonly RoleTemplate[] = deepFreezeKimiCodingAuthority(
  KIMI_CODING_PROVIDER_PROFILE.role_templates.map((template) => cloneRoleTemplate(template)),
);

const KIMI_CODING_ROLE_TEMPLATE_MAP: ReadonlyMap<RosterRole, RoleTemplate> = new Map(
  KIMI_CODING_ROLE_TEMPLATES.map((template) => [template.role, template]),
);

deepFreezeKimiCodingAuthority(ROSTER_ROLE_ORDER);

export const KIMI_CODING_ROUTE_FACTS: KimiCodingRouteFacts = deepFreezeKimiCodingAuthority({
  schema_version: 'autopilot.kimi_coding_route.v1',
  provider_id: KIMI_CODING_PROVIDER_ID,
  recipe_id: KIMI_CODING_RECIPE_ID,
  recipe_revision: KIMI_CODING_RECIPE_REVISION,
  profile_id: KIMI_CODING_PROFILE_ID,
  route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
  route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
  base_url: KIMI_CODING_BASE_URL,
  api: KIMI_CODING_API,
  auth_class: KIMI_CODING_AUTH_CLASS,
  auth_material_shape: KIMI_CODING_AUTH_MATERIAL_SHAPE,
  allowed_auth_classes: [KIMI_CODING_AUTH_CLASS],
  allowed_auth_sources: ['runtime', 'stored'],
  billing_class: KIMI_CODING_BILLING_CLASS,
  billing_route_class: KIMI_CODING_BILLING_ROUTE_CLASS,
  service_tier: KIMI_CODING_SERVICE_TIER,
  cache_policy: KIMI_CODING_CACHE_POLICY,
  system_prompt_profile: KIMI_CODING_SYSTEM_PROMPT_PROFILE,
  allowed_apis: [KIMI_CODING_API],
  allowed_service_tiers: [null],
  allowed_cache_policies: [KIMI_CODING_CACHE_POLICY],
  allowed_system_prompt_profiles: [KIMI_CODING_SYSTEM_PROMPT_PROFILE],
  forbidden_gateways: ['arbitrary-api-key', 'metered-frontier', 'openrouter'],
  requires_live_entitlement_proof: true,
  requires_live_billing_proof: true,
  requires_w3_authenticated_execution_refs: true,
  plan_token_grants_generic_api_key: false,
  labels_rank_candidates: false,
  network_calls_allowed_by_pack: false,
  qualification_state: 'qualification-required',
  minimum_pi_version: PHASE37_PI_VERSION,
  w0_recipe_sha256: KIMI_CODING_PROVIDER_RECIPE.recipe_sha256,
});

export const KIMI_CODING_LABELS = deepFreezeKimiCodingAuthority({
  schema_version: 'autopilot.kimi_coding_labels.v1' as const,
  provider_label: 'Kimi Coding',
  model_labels: ['kimi-k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'] as const,
  labels_are_display_only: true,
  labels_rank_candidates: false,
  labels_do_not_authorize_aliases: true,
});

export const KIMI_CODING_PENDING_LIVE_POST_W3_WITNESSES = deepFreezeKimiCodingAuthority([
  'non-secret Kimi Coding plan entitlement proof under kimi-coding-plan-v1',
  'non-secret Kimi Coding billing-route proof for plan-api-token proving it is not OpenRouter or an arbitrary metered key',
  'W3-authenticated observed execution evidence ref/digest for parent with exact frozen request/observed profile',
  'W3-authenticated observed execution evidence ref/digest for strategy with exact frozen request/observed profile',
  'W3-authenticated observed execution evidence ref/digest for implement with exact frozen request/observed profile',
  'W3-authenticated observed execution evidence ref/digest for validate with exact frozen request/observed profile',
  'W3-authenticated observed execution evidence ref/digest for fix with exact frozen request/observed profile',
  'W3-authenticated observed execution evidence ref/digest for adjudicate with exact frozen request/observed profile',
  'W3-authenticated observed execution evidence ref/digest for bughunt with exact frozen request/observed profile',
  'W3-authenticated observed execution evidence ref/digest for extract with exact requested and executed model kimi-for-coding-highspeed',
  'certification manifest bound to kimi-coding-plan package 1.3.0, Pi 0.80.6, issued 2026-07-23, expires 2026-08-22 with recomputed hashes',
] as const);

export function isKimiCodingRole(value: string): value is RosterRole {
  return (ROSTER_ROLE_ORDER as readonly string[]).includes(value);
}

export function getKimiCodingRoleTemplate(role: RosterRole): RoleTemplate {
  return kimiCodingRoleTemplate(role);
}

export function kimiCodingRoleTemplate(role: RosterRole): RoleTemplate {
  const template = KIMI_CODING_ROLE_TEMPLATE_MAP.get(role);
  if (template === undefined) {
    throw new Error(`Kimi Coding role template missing for ${role}`);
  }
  return template;
}

export function buildKimiCodingRequestProfile(role: RosterRole): RequestProfile {
  const template = kimiCodingRoleTemplate(role);
  const withoutHash = {
    provider_id: KIMI_CODING_PROVIDER_ID,
    model_id: template.model_id,
    model: `${KIMI_CODING_PROVIDER_ID}/${template.model_id}`,
    api: template.api,
    thinking: template.thinking,
    service_tier: template.service_tier,
    cache_policy: template.cache_policy,
    system_prompt_profile: template.system_prompt_profile,
    context_window: template.context_window,
    max_output_tokens: template.max_output_tokens,
    input_modalities: template.input_modalities,
    output_modalities: template.output_modalities,
    reasoning_capability: template.reasoning_capability,
    tool_capability: template.tool_capability,
    route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
    route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
  } satisfies Omit<RequestProfile, 'request_profile_sha256'>;
  return { ...withoutHash, request_profile_sha256: canonicalSha256(withoutHash) };
}

export function kimiCodingRequestProfileForRole(role: RosterRole): RequestProfile {
  return buildKimiCodingRequestProfile(role);
}

export function allKimiCodingRequestProfiles(): readonly RequestProfile[] {
  return ROSTER_ROLE_ORDER.map((role) => buildKimiCodingRequestProfile(role));
}

export function buildKimiCodingObservedProfile(role: RosterRole, systemPromptSha256: Digest): ObservedProfile {
  const requestProfile = buildKimiCodingRequestProfile(role);
  const withoutHash = {
    provider_id: KIMI_CODING_PROVIDER_ID,
    requested_model_id: requestProfile.model_id,
    executed_model_id: requestProfile.model_id,
    api: requestProfile.api,
    thinking: requestProfile.thinking,
    service_tier: requestProfile.service_tier,
    cache_policy: requestProfile.cache_policy,
    system_prompt_profile: requestProfile.system_prompt_profile,
    system_prompt_sha256: systemPromptSha256,
    route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
    route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
    request_profile_sha256: requestProfile.request_profile_sha256,
  } satisfies Omit<ObservedProfile, 'observed_profile_sha256'>;
  return { ...withoutHash, observed_profile_sha256: canonicalSha256(withoutHash) };
}

export function makeKimiCodingObservedEvidence(
  profile: RequestProfile,
  options: Partial<Omit<ObservedProfile, 'observed_profile_sha256'>> = {},
): ObservedProfile {
  const withoutHash = {
    provider_id: options.provider_id ?? profile.provider_id,
    requested_model_id: options.requested_model_id ?? profile.model_id,
    executed_model_id: options.executed_model_id ?? profile.model_id,
    api: options.api ?? profile.api,
    thinking: options.thinking ?? profile.thinking,
    service_tier: options.service_tier ?? profile.service_tier,
    cache_policy: options.cache_policy ?? profile.cache_policy,
    system_prompt_profile: options.system_prompt_profile ?? profile.system_prompt_profile,
    system_prompt_sha256: options.system_prompt_sha256 ?? (`sha256:${'a'.repeat(64)}` as Digest),
    route_policy_id: options.route_policy_id ?? profile.route_policy_id,
    route_policy_revision: options.route_policy_revision ?? profile.route_policy_revision,
    request_profile_sha256: options.request_profile_sha256 ?? profile.request_profile_sha256,
  } satisfies Omit<ObservedProfile, 'observed_profile_sha256'>;
  return { ...withoutHash, observed_profile_sha256: canonicalSha256(withoutHash) };
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
    auth_material_shape: KIMI_CODING_AUTH_MATERIAL_SHAPE,
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
  if (route.auth_class === 'api-key') {
    diagnostics.push('KIMI_CODING_GENERIC_API_KEY_FORBIDDEN');
  }
  if (route.auth_class !== KIMI_CODING_AUTH_CLASS) {
    diagnostics.push('KIMI_CODING_AUTH_FORBIDDEN');
  }
  if (route.auth_material_shape !== KIMI_CODING_AUTH_MATERIAL_SHAPE) {
    diagnostics.push('KIMI_CODING_PLAN_TOKEN_PROOF_REQUIRED');
  }
  if (!(ALLOWED_AUTH_SOURCES as readonly string[]).includes(String(route.auth_source))) {
    diagnostics.push('KIMI_CODING_AUTH_SOURCE_FORBIDDEN');
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
  if (isOldDivergentRoute(route)) {
    diagnostics.push('KIMI_CODING_OLD_DIVERGENT_PROFILE_FORBIDDEN');
  }
  return uniqueSortedDiagnostics(diagnostics);
}

export function evaluateKimiCodingQualification(input: KimiCodingQualificationInput): KimiCodingQualificationEvaluation {
  const issues: KimiCodingQualificationIssue[] = [];
  const routeKeys: string[] = [];

  validateTopLevelRoute(input, issues, routeKeys);
  validateQualificationProof(input.entitlement_proof, 'entitlement', 'entitlement_proof', input.evidence_source, issues, routeKeys);
  validateQualificationProof(input.billing_route_proof, 'billing-route', 'billing_route_proof', input.evidence_source, issues, routeKeys);
  validateRoleWitnesses(input.role_witnesses, input.evidence_source, issues, routeKeys);
  validateMixedRoute(routeKeys, issues);

  const uniqueIssues = sortIssues(issues);
  const structuralPass = uniqueIssues.length === 0;
  const certificationReady = structuralPass && input.evidence_source === 'live-post-w3-witness';
  const pendingLiveWitnesses = certificationReady ? [] : KIMI_CODING_PENDING_LIVE_POST_W3_WITNESSES;
  const qualificationState: QualificationState = certificationReady ? 'w4-certified-ready' : 'qualification-required';
  const withoutHash = {
    schema_version: KIMI_CODING_EVALUATION_SCHEMA_VERSION,
    provider_id: KIMI_CODING_PROVIDER_ID,
    route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
    route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
    evidence_source: input.evidence_source,
    structural_pass: structuralPass,
    certification_ready: certificationReady,
    qualification_state: qualificationState,
    non_certifying: !certificationReady,
    synthetic_fixture_non_certifying: input.evidence_source === 'synthetic-fixture',
    no_network: true as const,
    pending_live_post_w3_witnesses: pendingLiveWitnesses,
    issues: uniqueIssues,
  } satisfies Omit<KimiCodingQualificationEvaluation, 'evaluation_sha256'>;
  return { ...withoutHash, evaluation_sha256: canonicalSha256(withoutHash) };
}

export function buildKimiCodingQualificationManifestCandidate(input: KimiCodingQualificationInput): KimiCodingManifestCandidate {
  const evaluation = evaluateKimiCodingQualification(input);
  const certificationManifest = buildQualificationManifest(input, evaluation);
  const withoutHash = {
    schema_version: KIMI_CODING_MANIFEST_CANDIDATE_SCHEMA_VERSION,
    provider_id: KIMI_CODING_PROVIDER_ID,
    recipe_id: KIMI_CODING_RECIPE_ID,
    recipe_revision: KIMI_CODING_RECIPE_REVISION,
    route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
    route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
    qualification_state: evaluation.qualification_state,
    certification_ready: evaluation.certification_ready,
    non_certifying: evaluation.non_certifying,
    synthetic_fixture_non_certifying: evaluation.synthetic_fixture_non_certifying,
    no_network: true as const,
    pending_live_post_w3_witnesses: evaluation.pending_live_post_w3_witnesses,
    evaluation,
    certification_manifest: certificationManifest,
  } satisfies Omit<KimiCodingManifestCandidate, 'manifest_candidate_sha256'>;
  return { ...withoutHash, manifest_candidate_sha256: canonicalSha256(withoutHash) };
}

export function buildKimiCodingOfflineQualificationReport(input: KimiCodingQualificationInput): KimiCodingOfflineQualificationReport {
  const manifestCandidate = buildKimiCodingQualificationManifestCandidate(input);
  const withoutHash = {
    schema_version: KIMI_CODING_OFFLINE_REPORT_SCHEMA_VERSION,
    phase: 'phase37-w4' as const,
    provider_id: KIMI_CODING_PROVIDER_ID,
    recipe_id: KIMI_CODING_RECIPE_ID,
    route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
    offline: true as const,
    network_calls: 0 as const,
    network_calls_performed: false as const,
    qualification_state: manifestCandidate.qualification_state,
    certifying: false as const,
    launch_ready: false as const,
    synthetic_fixture_non_certifying: true as const,
    live_provider_certification_asserted: false as const,
    synthetic_fixtures_certifying: false as const,
    openrouter_or_arbitrary_keys_allowed: false as const,
    generic_api_key_permission_allowed: false as const,
    model_substitution_allowed: false as const,
    pending_live_post_w3_witnesses: manifestCandidate.pending_live_post_w3_witnesses,
    report: 'qualification-required: live W3-authenticated role-complete Kimi Coding entitlement, billing, and observed request/executed-model evidence refs/digests are pending; synthetic offline fixture is non-certifying.',
    route_facts: KIMI_CODING_ROUTE_FACTS,
    role_templates: KIMI_CODING_ROLE_TEMPLATES,
    manifest_candidate: manifestCandidate,
  } satisfies Omit<KimiCodingOfflineQualificationReport, 'report_sha256'>;
  return { ...withoutHash, report_sha256: canonicalSha256(withoutHash) };
}

export function buildKimiCodingQualification(input: KimiCodingQualificationInput): KimiCodingQualificationReport {
  const manifestCandidate = buildKimiCodingQualificationManifestCandidate(input);
  const evaluation = manifestCandidate.evaluation;
  const roleResults: KimiCodingRoleQualificationResult[] = ROSTER_ROLE_ORDER.map((role) => {
    const roleIssues = evaluation.issues
      .filter((issue) => issue.path.includes(role))
      .map((issue) => issue.code);
    const uniqueDiagnostics = uniqueSortedDiagnostics(roleIssues);
    const state: KimiCodingRoleQualificationResult['state'] = evaluation.certification_ready
      ? 'pass'
      : evaluation.structural_pass && input.evidence_source === 'synthetic-fixture'
        ? 'synthetic-pass'
        : 'fail';
    return { role, state, diagnostics: uniqueDiagnostics };
  });
  const diagnostics = evaluation.certification_ready
    ? []
    : uniqueSortedDiagnostics([...evaluation.issues.map((issue) => issue.code), 'KIMI_CODING_QUALIFICATION_REQUIRED']);
  const withoutHash = {
    schema_version: KIMI_CODING_EVALUATION_SCHEMA_VERSION,
    provider_id: KIMI_CODING_PROVIDER_ID,
    route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
    route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
    qualification_state: evaluation.qualification_state as Extract<QualificationState, 'qualification-required' | 'w4-certified-ready'>,
    certifying: evaluation.certification_ready,
    live_evidence_complete: evaluation.certification_ready,
    synthetic_fixture: input.evidence_source === 'synthetic-fixture',
    network_calls_performed: false as const,
    diagnostics,
    role_results: roleResults,
    issued_at: KIMI_CODING_ISSUED_AT,
    expires_at: KIMI_CODING_EXPIRES_AT,
  } satisfies Omit<KimiCodingQualificationReport, 'report_sha256'>;
  return { ...withoutHash, report_sha256: canonicalSha256(withoutHash) };
}

export function verifyKimiCodingOfflineQualificationReport(report: KimiCodingOfflineQualificationReport): readonly KimiCodingQualificationIssue[] {
  const issues: KimiCodingQualificationIssue[] = [];
  if (report.schema_version !== KIMI_CODING_OFFLINE_REPORT_SCHEMA_VERSION) {
    pushIssue(issues, 'KIMI_CODING_MANIFEST_BINDING_MISMATCH', 'schema_version', 'offline report schema must be exact');
  }
  if (report.provider_id !== KIMI_CODING_PROVIDER_ID || report.recipe_id !== KIMI_CODING_RECIPE_ID || report.route_policy_id !== KIMI_CODING_ROUTE_POLICY_ID) {
    pushIssue(issues, 'KIMI_CODING_MANIFEST_BINDING_MISMATCH', 'provider_id', 'report subject must remain the exact Kimi Coding provider recipe');
  }
  if (report.offline !== true || report.network_calls !== 0 || report.network_calls_performed !== false) {
    pushIssue(issues, 'KIMI_CODING_NETWORK_EVIDENCE_FORBIDDEN', 'network_calls', 'Kimi Coding W4 offline report must perform no network calls');
  }
  if (report.certifying !== false || report.launch_ready !== false || report.synthetic_fixture_non_certifying !== true) {
    pushIssue(issues, 'KIMI_CODING_SYNTHETIC_NON_CERTIFYING', 'certifying', 'current Kimi Coding artifact must remain blocked and non-certifying');
  }
  if (report.live_provider_certification_asserted !== false || report.synthetic_fixtures_certifying !== false) {
    pushIssue(issues, 'KIMI_CODING_SYNTHETIC_NON_CERTIFYING', 'live_provider_certification_asserted', 'offline artifacts must not self-certify synthetic evidence');
  }
  if (report.model_substitution_allowed !== false) {
    pushIssue(issues, 'KIMI_CODING_MODEL_SUBSTITUTION_FORBIDDEN', 'model_substitution_allowed', 'Kimi Coding allows no highspeed-to-base or other model substitution');
  }
  if (!jsonEqual(report.route_facts, KIMI_CODING_ROUTE_FACTS)) {
    pushIssue(issues, 'KIMI_CODING_ROUTE_FORBIDDEN', 'route_facts', 'route facts must match W0 frozen Kimi Coding route');
  }
  if (!jsonEqual(report.role_templates, KIMI_CODING_ROLE_TEMPLATES)) {
    pushIssue(issues, 'KIMI_CODING_REQUEST_PROFILE_MISMATCH', 'role_templates', 'role templates must match W0 frozen Kimi Coding profile');
  }
  validateReportHashes(report, issues);
  validateManifestCandidateBinding(report.manifest_candidate, issues);
  return sortIssues(issues);
}

export function makeKimiCodingSyntheticQualificationInput(): KimiCodingQualificationInput {
  const entitlementEvidence = evidenceRef(
    'fixture-kimi-coding-plan-entitlement-proof',
    'route-proof',
    'fixture://phase37/kimi-coding/entitlement-route-proof',
    null,
    null,
  );
  const billingEvidence = evidenceRef(
    'fixture-kimi-coding-billing-route-proof',
    'billing-proof',
    'fixture://phase37/kimi-coding/billing-route-proof',
    null,
    null,
  );
  return {
    schema_version: 'autopilot.kimi_coding_qualification_input.v1',
    evidence_source: 'synthetic-fixture',
    route: exactKimiCodingRouteObservation('stored'),
    gateway_id: KIMI_CODING_PROVIDER_ID,
    entitlement_proof: proof('fixture-kimi-coding-plan-entitlement-proof', 'entitlement', entitlementEvidence, KIMI_CODING_ISSUED_AT),
    billing_route_proof: proof('fixture-kimi-coding-billing-route-proof', 'billing-route', billingEvidence, KIMI_CODING_ISSUED_AT),
    role_witnesses: ROSTER_ROLE_ORDER.map((role) => makeSyntheticRoleWitness(role)),
    no_fallback: true,
  };
}

export function makeKimiCodingRoleEntitlementEvidence(role: RosterRole): KimiCodingQualificationProof {
  void role;
  return proof(
    'fixture-kimi-coding-plan-entitlement-proof',
    'entitlement',
    evidenceRef('fixture-kimi-coding-plan-entitlement-proof', 'route-proof', 'fixture://phase37/kimi-coding/entitlement-route-proof', null, null),
    KIMI_CODING_ISSUED_AT,
  );
}

export function kimiCodingFixtureDigest(label: string): Digest {
  return canonicalSha256({ provider_id: KIMI_CODING_PROVIDER_ID, fixture_label: label });
}

function makeSyntheticRoleWitness(role: RosterRole): KimiCodingRoleExecutionWitness {
  const systemPromptSha256 = kimiCodingFixtureDigest(`system-prompt-${role}`);
  const evidence = evidenceRef(
    `fixture-kimi-coding-exec-${role}-proof`,
    'execution-proof',
    `fixture://phase37/kimi-coding/execution/${role}`,
    null,
    null,
  );
  return {
    witness_id: `fixture-kimi-coding-${role}-execution`,
    role,
    provider_id: KIMI_CODING_PROVIDER_ID,
    route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
    route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
    authenticated: true,
    auth_class: KIMI_CODING_AUTH_CLASS,
    auth_source: 'stored',
    auth_material_shape: KIMI_CODING_AUTH_MATERIAL_SHAPE,
    billing_class: KIMI_CODING_BILLING_CLASS,
    billing_route_class: KIMI_CODING_BILLING_ROUTE_CLASS,
    request_profile: buildKimiCodingRequestProfile(role),
    observed_profile: buildKimiCodingObservedProfile(role, systemPromptSha256),
    evidence_refs: [evidence],
    no_fallback: true,
  };
}

function proof(
  proofId: string,
  proofKind: KimiCodingProofKind,
  evidence: EvidenceRef,
  observedAt: string,
): KimiCodingQualificationProof {
  return {
    proof_id: proofId,
    proof_kind: proofKind,
    provider_id: KIMI_CODING_PROVIDER_ID,
    route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
    route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
    auth_class: KIMI_CODING_AUTH_CLASS,
    auth_source: 'stored',
    auth_material_shape: KIMI_CODING_AUTH_MATERIAL_SHAPE,
    billing_class: KIMI_CODING_BILLING_CLASS,
    billing_route_class: KIMI_CODING_BILLING_ROUTE_CLASS,
    no_fallback: true,
    observed_at: observedAt,
    evidence_ref: evidence,
  };
}

function evidenceRef(evidenceId: string, kind: EvidenceRef['kind'], uri: string, sha256: Digest | null, byteCount: number | null): EvidenceRef {
  return {
    evidence_id: evidenceId,
    kind,
    uri,
    sha256,
    byte_count: byteCount,
    secret_free: true,
  };
}

function validateTopLevelRoute(
  input: KimiCodingQualificationInput,
  issues: KimiCodingQualificationIssue[],
  routeKeys: string[],
): void {
  routeKeys.push(routeKey(input.route.provider_id, input.route.route_policy_id, input.route.route_policy_revision, String(input.route.billing_route_class)));
  if (input.schema_version !== 'autopilot.kimi_coding_qualification_input.v1') {
    pushIssue(issues, 'KIMI_CODING_ROUTE_FORBIDDEN', 'schema_version', 'Kimi Coding qualification input schema is exact');
  }
  for (const code of validateKimiCodingRouteObservation(input.route)) {
    pushIssue(issues, code, `route.${routePathForDiagnostic(code)}`, 'top-level route must match the W0 frozen Kimi Coding plan-token route');
  }
  if (input.gateway_id !== null && FORBIDDEN_GATEWAYS.includes(input.gateway_id as (typeof FORBIDDEN_GATEWAYS)[number])) {
    pushIssue(issues, 'KIMI_CODING_ROUTE_FORBIDDEN', 'gateway_id', 'OpenRouter, arbitrary keys, and metered gateways are forbidden');
  } else if (input.gateway_id !== null && input.gateway_id !== KIMI_CODING_PROVIDER_ID) {
    pushIssue(issues, 'KIMI_CODING_MIXED_ROUTE_FORBIDDEN', 'gateway_id', 'gateway/provider must remain the exact Kimi Coding plan route');
  }
  if (input.no_fallback !== true) {
    pushIssue(issues, 'KIMI_CODING_NO_FALLBACK_REQUIRED', 'no_fallback', 'fallback model or route is forbidden');
  }
  if (input.evidence_source !== 'synthetic-fixture' && input.evidence_source !== 'live-post-w3-witness') {
    pushIssue(issues, 'KIMI_CODING_LIVE_W3_EVIDENCE_REQUIRED', 'evidence_source', 'evidence source must be synthetic-fixture or live-post-W3 witness');
  }
}

function routePathForDiagnostic(code: KimiCodingDiagnosticCode): string {
  switch (code) {
    case 'KIMI_CODING_API_MISMATCH':
      return 'api';
    case 'KIMI_CODING_AUTH_FORBIDDEN':
    case 'KIMI_CODING_AUTH_SOURCE_FORBIDDEN':
    case 'KIMI_CODING_GENERIC_API_KEY_FORBIDDEN':
    case 'KIMI_CODING_PLAN_TOKEN_PROOF_REQUIRED':
      return 'auth_class';
    case 'KIMI_CODING_BILLING_REQUIRED':
      return 'billing_route_class';
    case 'KIMI_CODING_CACHE_MISMATCH':
      return 'cache_policy';
    case 'KIMI_CODING_PROMPT_MISMATCH':
    case 'KIMI_CODING_OLD_DIVERGENT_PROFILE_FORBIDDEN':
      return 'system_prompt_profile';
    default:
      return 'route_policy_id';
  }
}

function validateQualificationProof(
  proofValue: KimiCodingQualificationProof | null,
  expectedKind: KimiCodingProofKind,
  path: string,
  evidenceSource: KimiCodingEvidenceSource,
  issues: KimiCodingQualificationIssue[],
  routeKeys: string[],
): void {
  const missingCode = expectedKind === 'entitlement' ? 'KIMI_CODING_ENTITLEMENT_EVIDENCE_REQUIRED' : 'KIMI_CODING_BILLING_EVIDENCE_REQUIRED';
  if (proofValue === null) {
    pushIssue(
      issues,
      missingCode,
      path,
      expectedKind === 'entitlement'
        ? 'non-secret Kimi Coding plan entitlement evidence ref/digest is required'
        : 'non-secret Kimi Coding billing-route evidence ref/digest is required',
    );
    return;
  }
  routeKeys.push(routeKey(proofValue.provider_id, proofValue.route_policy_id, proofValue.route_policy_revision, proofValue.billing_route_class));
  if (proofValue.proof_kind !== expectedKind) {
    pushIssue(issues, missingCode, `${path}.proof_kind`, `proof kind must be ${expectedKind}`);
  }
  validateRoutePolicyCarrier(proofValue, path, issues);
  const expectedEvidenceKind: EvidenceRef['kind'] = expectedKind === 'entitlement' ? 'route-proof' : 'billing-proof';
  if (proofValue.evidence_ref.kind !== expectedEvidenceKind) {
    pushIssue(issues, missingCode, `${path}.evidence_ref.kind`, `proof evidence kind must be ${expectedEvidenceKind}`);
  }
  validateEvidenceRefs(
    [proofValue.evidence_ref],
    `${path}.evidence_ref`,
    evidenceSource,
    issues,
    expectedEvidenceKind,
    expectedKind === 'entitlement' ? 'plan-entitlement' : 'billing-route',
  );
}

interface RoutePolicyCarrier {
  readonly provider_id: string;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly auth_class: AuthClass;
  readonly auth_source: AuthSource;
  readonly auth_material_shape: KimiCodingAuthMaterialShape;
  readonly billing_class: BillingClass;
  readonly billing_route_class: BillingRouteClass;
  readonly no_fallback: boolean;
}

function validateRoutePolicyCarrier(carrier: RoutePolicyCarrier, pathPrefix: string, issues: KimiCodingQualificationIssue[]): void {
  const path = (field: string): string => pathPrefix.length === 0 ? field : `${pathPrefix}.${field}`;
  if (carrier.provider_id !== KIMI_CODING_PROVIDER_ID) {
    pushIssue(issues, 'KIMI_CODING_ROUTE_FORBIDDEN', path('provider_id'), 'provider_id must be exactly kimi-coding');
  }
  if (carrier.route_policy_id !== KIMI_CODING_ROUTE_POLICY_ID || carrier.route_policy_revision !== KIMI_CODING_ROUTE_POLICY_REVISION) {
    pushIssue(issues, 'KIMI_CODING_ROUTE_FORBIDDEN', path('route_policy_id'), 'route policy must be exactly kimi-coding-plan-v1@1');
  }
  if (carrier.auth_class === 'api-key') {
    pushIssue(issues, 'KIMI_CODING_GENERIC_API_KEY_FORBIDDEN', path('auth_class'), 'generic API keys do not qualify the Kimi Coding plan-token route');
  }
  if (carrier.auth_class !== KIMI_CODING_AUTH_CLASS) {
    pushIssue(issues, 'KIMI_CODING_PLAN_TOKEN_PROOF_REQUIRED', path('auth_class'), 'auth_class must be api-key-plan-token');
  }
  if (carrier.auth_material_shape === KIMI_CODING_AUTH_MATERIAL_SHAPE && carrier.auth_class !== KIMI_CODING_AUTH_CLASS) {
    pushIssue(
      issues,
      'KIMI_CODING_ROUTE_TOKEN_SHAPE_IS_NOT_API_KEY_PERMISSION',
      path('auth_material_shape'),
      'API-key-shaped token shape proves only the plan-token route when auth_class is api-key-plan-token',
    );
  }
  if (carrier.auth_material_shape !== KIMI_CODING_AUTH_MATERIAL_SHAPE) {
    pushIssue(issues, 'KIMI_CODING_PLAN_TOKEN_PROOF_REQUIRED', path('auth_material_shape'), 'auth material shape must be the plan-token shape');
  }
  if (!(ALLOWED_AUTH_SOURCES as readonly string[]).includes(carrier.auth_source)) {
    pushIssue(issues, 'KIMI_CODING_AUTH_SOURCE_FORBIDDEN', path('auth_source'), 'auth_source must be runtime or stored, never environment fallback');
  }
  if (carrier.billing_class !== KIMI_CODING_BILLING_CLASS || carrier.billing_route_class !== KIMI_CODING_BILLING_ROUTE_CLASS) {
    pushIssue(issues, 'KIMI_CODING_BILLING_EVIDENCE_REQUIRED', path('billing_route_class'), 'billing route must be plan-api-token');
  }
  if (carrier.no_fallback !== true) {
    pushIssue(issues, 'KIMI_CODING_NO_FALLBACK_REQUIRED', path('no_fallback'), 'fallback is forbidden');
  }
}

function validateRoleWitnesses(
  roleWitnesses: readonly KimiCodingRoleExecutionWitness[],
  evidenceSource: KimiCodingEvidenceSource,
  issues: KimiCodingQualificationIssue[],
  routeKeys: string[],
): void {
  for (const role of ROSTER_ROLE_ORDER) {
    const matching = roleWitnesses.filter((witness) => witness.role === role);
    if (matching.length !== 1) {
      pushIssue(issues, 'KIMI_CODING_MISSING_ROLE', `role_witnesses.${role}`, 'exactly one W3-authenticated observed execution witness is required for every role');
    }
  }

  roleWitnesses.forEach((witness, index) => {
    const path = `role_witnesses[${String(index)}]`;
    routeKeys.push(routeKey(witness.provider_id, witness.route_policy_id, witness.route_policy_revision, witness.billing_route_class));
    if (!isKimiCodingRole(String(witness.role))) {
      pushIssue(issues, 'KIMI_CODING_MISSING_ROLE', `${path}.role`, 'role must be one of the frozen roster roles');
      return;
    }
    validateWitnessRoute(witness, path, issues);
    validateRequestProfileExact(witness.role, witness.request_profile, `${path}.request_profile`, issues, routeKeys);
    validateObservedProfileExact(witness.role, witness.observed_profile, `${path}.observed_profile`, issues, routeKeys);
    validateEvidenceRefs(witness.evidence_refs, `${path}.evidence_refs`, evidenceSource, issues, 'execution-proof', `execution/${witness.role}`);
  });
}

function validateWitnessRoute(witness: KimiCodingRoleExecutionWitness, path: string, issues: KimiCodingQualificationIssue[]): void {
  validateRoutePolicyCarrier(witness, path, issues);
  if (witness.authenticated !== true) {
    pushIssue(issues, 'KIMI_CODING_AUTHENTICATED_W3_EXECUTION_REQUIRED', `${path}.authenticated`, 'role execution must be authenticated by W3 evidence');
  }
}

function validateRequestProfileExact(
  role: RosterRole,
  requestProfile: RequestProfile,
  path: string,
  issues: KimiCodingQualificationIssue[],
  routeKeys: string[],
): void {
  const expected = buildKimiCodingRequestProfile(role);
  routeKeys.push(routeKey(requestProfile.provider_id, requestProfile.route_policy_id, requestProfile.route_policy_revision, KIMI_CODING_BILLING_ROUTE_CLASS));
  for (const key of Object.keys(expected) as readonly (keyof RequestProfile)[]) {
    if (!jsonEqual(requestProfile[key], expected[key])) {
      pushRequestProfileIssue(role, requestProfile, key, `${path}.${String(key)}`, issues);
    }
  }
  const recomputed = hashRequestProfile(requestProfile);
  if (requestProfile.request_profile_sha256 !== recomputed) {
    pushIssue(issues, 'KIMI_CODING_REQUEST_PROFILE_DRIFT', `${path}.request_profile_sha256`, 'request_profile_sha256 must hash the exact request profile');
  }
  if (isOldDivergentRequestProfile(requestProfile)) {
    pushIssue(issues, 'KIMI_CODING_OLD_DIVERGENT_PROFILE_FORBIDDEN', path, 'old Anthropic-compatible/image legacy Kimi profile is forbidden by W0');
  }
  if (isForbiddenModelSubstitution(role, requestProfile.model_id)) {
    pushIssue(issues, 'KIMI_CODING_MODEL_SUBSTITUTION_FORBIDDEN', `${path}.model_id`, `role ${role} must request the exact W0 frozen model`);
  }
}

function pushRequestProfileIssue(
  role: RosterRole,
  requestProfile: RequestProfile,
  key: keyof RequestProfile,
  path: string,
  issues: KimiCodingQualificationIssue[],
): void {
  const code: KimiCodingQualificationIssueCode =
    key === 'api'
      ? 'KIMI_CODING_API_MISMATCH'
      : key === 'thinking'
        ? 'KIMI_CODING_THINKING_MISMATCH'
        : key === 'cache_policy'
          ? 'KIMI_CODING_CACHE_MISMATCH'
          : key === 'system_prompt_profile'
            ? 'KIMI_CODING_PROMPT_MISMATCH'
            : key === 'context_window' || key === 'max_output_tokens' || key === 'input_modalities' || key === 'output_modalities'
              ? 'KIMI_CODING_CONTEXT_MISMATCH'
              : key === 'reasoning_capability' || key === 'tool_capability'
                ? 'KIMI_CODING_TOOL_MISMATCH'
                : key === 'model_id' || key === 'model'
                  ? 'KIMI_CODING_OBSERVED_MODEL_MISMATCH'
                  : 'KIMI_CODING_REQUEST_PROFILE_MISMATCH';
  pushIssue(issues, code, path, `request profile for ${role} must match the frozen W0 Kimi Coding role template`);
  if (key === 'model_id' && isForbiddenModelSubstitution(role, String(requestProfile.model_id))) {
    pushIssue(issues, 'KIMI_CODING_MODEL_SUBSTITUTION_FORBIDDEN', path, `role ${role} cannot substitute the frozen model`);
  }
}

function validateObservedProfileExact(
  role: RosterRole,
  observedProfile: ObservedProfile,
  path: string,
  issues: KimiCodingQualificationIssue[],
  routeKeys: string[],
): void {
  const expectedRequest = buildKimiCodingRequestProfile(role);
  routeKeys.push(routeKey(observedProfile.provider_id, observedProfile.route_policy_id, observedProfile.route_policy_revision, KIMI_CODING_BILLING_ROUTE_CLASS));
  const expectedPairs: readonly [keyof ObservedProfile, unknown][] = [
    ['provider_id', KIMI_CODING_PROVIDER_ID],
    ['requested_model_id', expectedRequest.model_id],
    ['executed_model_id', expectedRequest.model_id],
    ['api', expectedRequest.api],
    ['thinking', expectedRequest.thinking],
    ['service_tier', expectedRequest.service_tier],
    ['cache_policy', expectedRequest.cache_policy],
    ['system_prompt_profile', expectedRequest.system_prompt_profile],
    ['route_policy_id', KIMI_CODING_ROUTE_POLICY_ID],
    ['route_policy_revision', KIMI_CODING_ROUTE_POLICY_REVISION],
    ['request_profile_sha256', expectedRequest.request_profile_sha256],
  ];
  for (const [key, expectedValue] of expectedPairs) {
    if (!jsonEqual(observedProfile[key], expectedValue)) {
      const code: KimiCodingQualificationIssueCode =
        key === 'api'
          ? 'KIMI_CODING_API_MISMATCH'
          : key === 'thinking'
            ? 'KIMI_CODING_THINKING_MISMATCH'
            : key === 'cache_policy'
              ? 'KIMI_CODING_CACHE_MISMATCH'
              : key === 'system_prompt_profile'
                ? 'KIMI_CODING_PROMPT_MISMATCH'
                : key === 'requested_model_id' || key === 'executed_model_id'
                  ? 'KIMI_CODING_OBSERVED_MODEL_MISMATCH'
                  : 'KIMI_CODING_OBSERVED_PROFILE_MISMATCH';
      pushIssue(issues, code, `${path}.${String(key)}`, `observed profile for ${role} must match authenticated final W3 execution identity`);
    }
  }
  if (observedProfile.requested_model_id !== observedProfile.executed_model_id) {
    pushIssue(issues, 'KIMI_CODING_OBSERVED_MODEL_MISMATCH', `${path}.executed_model_id`, 'requested and executed model identity must match exactly');
  }
  if (isForbiddenModelSubstitution(role, observedProfile.requested_model_id) || isForbiddenModelSubstitution(role, observedProfile.executed_model_id)) {
    pushIssue(issues, 'KIMI_CODING_MODEL_SUBSTITUTION_FORBIDDEN', `${path}.requested_model_id`, `role ${role} cannot substitute the frozen requested/executed model`);
  }
  if (!isSha256Digest(observedProfile.system_prompt_sha256)) {
    pushIssue(issues, 'KIMI_CODING_OBSERVED_PROFILE_MISMATCH', `${path}.system_prompt_sha256`, 'observed profile must include a non-secret system prompt hash');
  }
  const recomputed = hashObservedProfile(observedProfile);
  if (observedProfile.observed_profile_sha256 !== recomputed) {
    pushIssue(issues, 'KIMI_CODING_REQUEST_PROFILE_DRIFT', `${path}.observed_profile_sha256`, 'observed_profile_sha256 must hash the exact observed profile');
  }
  if (isOldDivergentObservedProfile(observedProfile)) {
    pushIssue(issues, 'KIMI_CODING_OLD_DIVERGENT_PROFILE_FORBIDDEN', path, 'old Anthropic-compatible Kimi observed profile is forbidden by W0');
  }
}

function validateEvidenceRefs(
  evidenceRefs: readonly EvidenceRef[],
  path: string,
  evidenceSource: KimiCodingEvidenceSource,
  issues: KimiCodingQualificationIssue[],
  requiredKind: EvidenceRef['kind'],
  requiredScope: string,
): void {
  if (evidenceRefs.length === 0) {
    pushIssue(issues, 'KIMI_CODING_EVIDENCE_REF_REQUIRED', path, 'evidence reference is required');
    return;
  }
  let hasRequiredKind = false;
  evidenceRefs.forEach((ref, index) => {
    const refPath = path.endsWith('evidence_ref') ? path : `${path}[${String(index)}]`;
    if (ref.kind === requiredKind) {
      hasRequiredKind = true;
    }
    if (ref.secret_free !== true) {
      pushIssue(issues, 'KIMI_CODING_EVIDENCE_REF_SECRET_FORBIDDEN', `${refPath}.secret_free`, 'evidence refs must be secret-free');
    }
    if (/^https?:\/\//u.test(ref.uri)) {
      pushIssue(issues, 'KIMI_CODING_NETWORK_EVIDENCE_FORBIDDEN', `${refPath}.uri`, 'offline provider pack evidence must not require network access');
    }
    if (evidenceSource === 'live-post-w3-witness') {
      validateLiveW3EvidenceRef(ref, refPath, issues, requiredScope);
    }
  });
  if (!hasRequiredKind) {
    pushIssue(issues, 'KIMI_CODING_EVIDENCE_REF_REQUIRED', path, `at least one ${requiredKind} evidence ref is required`);
  }
}

function validateLiveW3EvidenceRef(
  ref: EvidenceRef,
  path: string,
  issues: KimiCodingQualificationIssue[],
  requiredScope: string,
): void {
  const trustedUriPrefix = `w3-evidence://phase37/kimi-coding/${requiredScope}`;
  if (ref.uri.startsWith('fixture://') || ref.evidence_id.startsWith('fixture-') || ref.kind === 'synthetic-fixture') {
    pushIssue(issues, 'KIMI_CODING_LIVE_W3_EVIDENCE_REQUIRED', path, 'live Kimi Coding certification requires non-fixture W3 evidence');
  }
  if (!ref.uri.startsWith(trustedUriPrefix)) {
    pushIssue(issues, 'KIMI_CODING_EVIDENCE_REF_UNTRUSTED', `${path}.uri`, `evidence URI must be bound to ${trustedUriPrefix}`);
  }
  if (!isSha256Digest(ref.sha256) || typeof ref.byte_count !== 'number' || ref.byte_count <= 0) {
    pushIssue(issues, 'KIMI_CODING_EVIDENCE_DIGEST_REQUIRED', path, 'live W3 evidence refs must include sha256 digest and positive byte_count');
  }
}

function validateMixedRoute(routeKeys: readonly string[], issues: KimiCodingQualificationIssue[]): void {
  const unique = new Set(routeKeys);
  if (unique.size > 1) {
    pushIssue(issues, 'KIMI_CODING_MIXED_ROUTE_FORBIDDEN', 'route', 'all proofs, request profiles, and observed profiles must use one exact Kimi Coding route');
  }
}

function buildQualificationManifest(
  input: KimiCodingQualificationInput,
  evaluation: KimiCodingQualificationEvaluation,
): QualificationManifest {
  const roleResults = ROSTER_ROLE_ORDER.map((role) => {
    const witness = input.role_witnesses.find((candidate) => candidate.role === role) ?? null;
    const state: 'pass' | 'fail' | 'synthetic-pass' = evaluation.certification_ready
      ? 'pass'
      : evaluation.structural_pass && input.evidence_source === 'synthetic-fixture'
        ? 'synthetic-pass'
        : 'fail';
    return {
      role,
      state,
      evidence_refs: sortEvidenceRefs(witness?.evidence_refs ?? [requiredExecutionEvidenceRef(role)]),
    };
  });
  const withoutHash = {
    schema_version: 'autopilot.certification_manifest.v1' as const,
    manifest_id: evaluation.certification_ready
      ? 'kimi-coding-plan-w4-qualified-v1'
      : 'kimi-coding-plan-qualification-required-v1',
    manifest_revision: 1,
    subject_kind: 'provider_recipe' as const,
    subject_id: KIMI_CODING_RECIPE_ID,
    subject_sha256: KIMI_CODING_PROVIDER_RECIPE.recipe_sha256,
    package_version: PHASE37_PACKAGE_VERSION,
    pi_version: PHASE37_PI_VERSION,
    qualification_state: evaluation.qualification_state,
    role_results: roleResults,
    required_evidence: KIMI_CODING_REQUIRED_EVIDENCE_REFS,
    live_evidence: evaluation.certification_ready ? liveEvidenceRefs(input) : [] as readonly EvidenceRef[],
    issued_at: KIMI_CODING_ISSUED_AT,
    expires_at: KIMI_CODING_EXPIRES_AT,
  } satisfies Omit<QualificationManifest, 'manifest_sha256'>;
  return { ...withoutHash, manifest_sha256: canonicalSha256(withoutHash) };
}

function requiredExecutionEvidenceRef(role: RosterRole): EvidenceRef {
  const ref = KIMI_CODING_REQUIRED_EVIDENCE_REFS.find((candidate) => candidate.evidence_id === `kimi-coding-exec-${role}-proof`);
  if (ref === undefined) {
    throw new Error(`missing required execution evidence ref for ${role}`);
  }
  return ref;
}

function liveEvidenceRefs(input: KimiCodingQualificationInput): readonly EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  if (input.entitlement_proof !== null) refs.push(input.entitlement_proof.evidence_ref);
  if (input.billing_route_proof !== null) refs.push(input.billing_route_proof.evidence_ref);
  for (const witness of input.role_witnesses) refs.push(...witness.evidence_refs);
  return sortEvidenceRefs(refs);
}

function sortEvidenceRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const byId = new Map<string, EvidenceRef>();
  for (const ref of refs) {
    if (!byId.has(ref.evidence_id)) {
      byId.set(ref.evidence_id, ref);
    }
  }
  return [...byId.values()].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
}

export const KIMI_CODING_REQUIRED_EVIDENCE_REFS = deepFreezeKimiCodingAuthority(sortEvidenceRefs([
  evidenceRef('kimi-coding-plan-entitlement-proof', 'route-proof', 'witness-required://phase37/kimi-coding/plan-entitlement', null, null),
  evidenceRef('kimi-coding-billing-route-proof', 'billing-proof', 'witness-required://phase37/kimi-coding/billing-route', null, null),
  ...ROSTER_ROLE_ORDER.map((role) => evidenceRef(
    `kimi-coding-exec-${role}-proof`,
    'execution-proof',
    `witness-required://phase37/kimi-coding/execution/${role}`,
    null,
    null,
  )),
]));

function validateReportHashes(report: KimiCodingOfflineQualificationReport, issues: KimiCodingQualificationIssue[]): void {
  const recomputedReport = canonicalSha256(omitReportHash(report));
  if (report.report_sha256 !== recomputedReport) {
    pushIssue(issues, 'KIMI_CODING_REPORT_HASH_MISMATCH', 'report_sha256', 'report_sha256 must hash the exact offline report body');
  }
  const candidate = report.manifest_candidate;
  const recomputedCandidate = canonicalSha256(omitManifestCandidateHash(candidate));
  if (candidate.manifest_candidate_sha256 !== recomputedCandidate) {
    pushIssue(issues, 'KIMI_CODING_MANIFEST_HASH_MISMATCH', 'manifest_candidate.manifest_candidate_sha256', 'manifest candidate hash must be recomputed');
  }
  const evaluation = candidate.evaluation;
  const recomputedEvaluation = canonicalSha256(omitEvaluationHash(evaluation));
  if (evaluation.evaluation_sha256 !== recomputedEvaluation) {
    pushIssue(issues, 'KIMI_CODING_MANIFEST_HASH_MISMATCH', 'manifest_candidate.evaluation.evaluation_sha256', 'evaluation hash must be recomputed');
  }
  const manifest = candidate.certification_manifest;
  const recomputedManifest = canonicalSha256(omitManifestHash(manifest));
  if (manifest.manifest_sha256 !== recomputedManifest) {
    pushIssue(issues, 'KIMI_CODING_MANIFEST_HASH_MISMATCH', 'manifest_candidate.certification_manifest.manifest_sha256', 'manifest hash must be recomputed');
  }
}

function validateManifestCandidateBinding(candidate: KimiCodingManifestCandidate, issues: KimiCodingQualificationIssue[]): void {
  if (candidate.provider_id !== KIMI_CODING_PROVIDER_ID || candidate.recipe_id !== KIMI_CODING_RECIPE_ID || candidate.recipe_revision !== KIMI_CODING_RECIPE_REVISION) {
    pushIssue(issues, 'KIMI_CODING_MANIFEST_BINDING_MISMATCH', 'manifest_candidate.recipe_id', 'manifest candidate must bind to kimi-coding-plan@1');
  }
  if (candidate.route_policy_id !== KIMI_CODING_ROUTE_POLICY_ID || candidate.route_policy_revision !== KIMI_CODING_ROUTE_POLICY_REVISION) {
    pushIssue(issues, 'KIMI_CODING_MANIFEST_BINDING_MISMATCH', 'manifest_candidate.route_policy_id', 'manifest candidate must bind to kimi-coding-plan-v1@1');
  }
  const manifest = candidate.certification_manifest;
  if (
    manifest.subject_kind !== 'provider_recipe' ||
    manifest.subject_id !== KIMI_CODING_RECIPE_ID ||
    manifest.subject_sha256 !== KIMI_CODING_PROVIDER_RECIPE.recipe_sha256 ||
    manifest.package_version !== PHASE37_PACKAGE_VERSION ||
    manifest.pi_version !== PHASE37_PI_VERSION ||
    manifest.issued_at !== KIMI_CODING_ISSUED_AT ||
    manifest.expires_at !== KIMI_CODING_EXPIRES_AT
  ) {
    pushIssue(
      issues,
      'KIMI_CODING_MANIFEST_BINDING_MISMATCH',
      'manifest_candidate.certification_manifest',
      'manifest must bind exact subject/package 1.3.0/Pi 0.80.6/issued/expires W4 facts',
    );
  }
  if (!jsonEqual(manifest.required_evidence, KIMI_CODING_REQUIRED_EVIDENCE_REFS)) {
    pushIssue(issues, 'KIMI_CODING_REQUIRED_EVIDENCE_MISMATCH', 'manifest_candidate.certification_manifest.required_evidence', 'required evidence refs must be the exact Kimi Coding W3 proof set');
  }
  if (candidate.certification_ready !== true && manifest.live_evidence.length !== 0) {
    pushIssue(issues, 'KIMI_CODING_LIVE_W3_EVIDENCE_REQUIRED', 'manifest_candidate.certification_manifest.live_evidence', 'non-ready manifests must not claim live evidence');
  }
}

function omitReportHash(report: KimiCodingOfflineQualificationReport): Omit<KimiCodingOfflineQualificationReport, 'report_sha256'> {
  const { report_sha256: _reportSha256, ...withoutHash } = report;
  return withoutHash;
}

function omitManifestCandidateHash(candidate: KimiCodingManifestCandidate): Omit<KimiCodingManifestCandidate, 'manifest_candidate_sha256'> {
  const { manifest_candidate_sha256: _manifestCandidateSha256, ...withoutHash } = candidate;
  return withoutHash;
}

function omitEvaluationHash(evaluation: KimiCodingQualificationEvaluation): Omit<KimiCodingQualificationEvaluation, 'evaluation_sha256'> {
  const { evaluation_sha256: _evaluationSha256, ...withoutHash } = evaluation;
  return withoutHash;
}

function omitManifestHash(manifest: QualificationManifest): Omit<QualificationManifest, 'manifest_sha256'> {
  const { manifest_sha256: _manifestSha256, ...withoutHash } = manifest;
  return withoutHash;
}

function hashRequestProfile(requestProfile: RequestProfile): Digest {
  const withoutHash = {
    provider_id: requestProfile.provider_id,
    model_id: requestProfile.model_id,
    model: requestProfile.model,
    api: requestProfile.api,
    thinking: requestProfile.thinking,
    service_tier: requestProfile.service_tier,
    cache_policy: requestProfile.cache_policy,
    system_prompt_profile: requestProfile.system_prompt_profile,
    context_window: requestProfile.context_window,
    max_output_tokens: requestProfile.max_output_tokens,
    input_modalities: requestProfile.input_modalities,
    output_modalities: requestProfile.output_modalities,
    reasoning_capability: requestProfile.reasoning_capability,
    tool_capability: requestProfile.tool_capability,
    route_policy_id: requestProfile.route_policy_id,
    route_policy_revision: requestProfile.route_policy_revision,
  } satisfies Omit<RequestProfile, 'request_profile_sha256'>;
  return canonicalSha256(withoutHash);
}

function hashObservedProfile(observedProfile: ObservedProfile): Digest {
  const withoutHash = {
    provider_id: observedProfile.provider_id,
    requested_model_id: observedProfile.requested_model_id,
    executed_model_id: observedProfile.executed_model_id,
    api: observedProfile.api,
    thinking: observedProfile.thinking,
    service_tier: observedProfile.service_tier,
    cache_policy: observedProfile.cache_policy,
    system_prompt_profile: observedProfile.system_prompt_profile,
    system_prompt_sha256: observedProfile.system_prompt_sha256,
    route_policy_id: observedProfile.route_policy_id,
    route_policy_revision: observedProfile.route_policy_revision,
    request_profile_sha256: observedProfile.request_profile_sha256,
  } satisfies Omit<ObservedProfile, 'observed_profile_sha256'>;
  return canonicalSha256(withoutHash);
}

function routeKey(providerId: string, routePolicyId: string, routePolicyRevision: number, billingRouteClass: string): string {
  return `${providerId}\0${routePolicyId}\0${String(routePolicyRevision)}\0${billingRouteClass}`;
}

function pushIssue(
  issues: KimiCodingQualificationIssue[],
  code: KimiCodingQualificationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function sortIssues(issues: readonly KimiCodingQualificationIssue[]): readonly KimiCodingQualificationIssue[] {
  const byIdentity = new Map<string, KimiCodingQualificationIssue>();
  for (const issue of issues) {
    byIdentity.set(`${issue.code}\0${issue.path}`, issue);
  }
  return [...byIdentity.values()].sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path));
}

function uniqueSortedDiagnostics(diagnostics: readonly KimiCodingDiagnosticCode[]): readonly KimiCodingDiagnosticCode[] {
  return [...new Set(diagnostics)].sort((left, right) => left.localeCompare(right));
}

function arraysEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSha256Digest(value: unknown): value is Digest {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isOldDivergentRoute(route: KimiCodingRouteObservation): boolean {
  return route.api === 'anthropic-messages' || route.system_prompt_profile === 'anthropic-autopilot-sanitized.v1';
}

function isOldDivergentRequestProfile(profile: RequestProfile): boolean {
  return (
    profile.api === 'anthropic-messages' ||
    profile.system_prompt_profile === 'anthropic-autopilot-sanitized.v1' ||
    profile.context_window === 262144 ||
    !arraysEqual(profile.input_modalities, TEXT_MODALITIES) ||
    profile.model_id === legacyUppercaseKimiModelId()
  );
}

function isOldDivergentObservedProfile(profile: ObservedProfile): boolean {
  return (
    profile.api === 'anthropic-messages' ||
    profile.system_prompt_profile === 'anthropic-autopilot-sanitized.v1' ||
    profile.requested_model_id === legacyUppercaseKimiModelId() ||
    profile.executed_model_id === legacyUppercaseKimiModelId()
  );
}

function isForbiddenModelSubstitution(role: RosterRole, modelId: string): boolean {
  const expected = buildKimiCodingRequestProfile(role).model_id;
  if (modelId === expected) {
    return false;
  }
  return (role === 'extract' && modelId === 'kimi-for-coding') || modelId === legacyUppercaseKimiModelId();
}

function legacyUppercaseKimiModelId(): string {
  return ['K', '3'].join('');
}

export function assertKimiCodingRoleTemplateCompleteness(templates: readonly RoleTemplate[] = KIMI_CODING_ROLE_TEMPLATES): void {
  const roles = templates.map((roleTemplate) => roleTemplate.role);
  if (JSON.stringify(roles) !== JSON.stringify(ROSTER_ROLE_ORDER)) {
    throw new Error(`Kimi Coding role templates must cover ROLE_ORDER exactly; found ${roles.join(',')}`);
  }
  for (const roleTemplate of templates) {
    if (roleTemplate.api !== KIMI_CODING_API) {
      throw new Error(`Kimi Coding role ${roleTemplate.role} must use openai-completions`);
    }
    if (roleTemplate.cache_policy !== KIMI_CODING_CACHE_POLICY || roleTemplate.system_prompt_profile !== KIMI_CODING_SYSTEM_PROMPT_PROFILE) {
      throw new Error(`Kimi Coding role ${roleTemplate.role} request facts drifted`);
    }
    if (!arraysEqual(roleTemplate.input_modalities, TEXT_MODALITIES) || !arraysEqual(roleTemplate.output_modalities, TEXT_MODALITIES)) {
      throw new Error(`Kimi Coding role ${roleTemplate.role} must remain text-only`);
    }
  }
}

export type KimiCodingRequestCompatibilityProfile = Readonly<{
  provider_id: typeof KIMI_CODING_PROVIDER_ID;
  api: typeof KIMI_CODING_API;
  service_tier: ServiceTier;
  cache_policy: CachePolicy;
  system_prompt_profile: SystemPromptProfile;
  input_modalities: readonly Modality[];
  output_modalities: readonly Modality[];
  reasoning_capability: ReasoningCapability;
  tool_capability: ToolCapability;
}>;

export const KIMI_CODING_REQUEST_COMPATIBILITY_PROFILE = deepFreezeKimiCodingAuthority({
  provider_id: KIMI_CODING_PROVIDER_ID,
  api: KIMI_CODING_API,
  service_tier: null,
  cache_policy: KIMI_CODING_CACHE_POLICY,
  system_prompt_profile: KIMI_CODING_SYSTEM_PROMPT_PROFILE,
  input_modalities: TEXT_MODALITIES,
  output_modalities: TEXT_MODALITIES,
  reasoning_capability: 'reasoning-supported',
  tool_capability: 'tool-use-supported',
} as const satisfies KimiCodingRequestCompatibilityProfile);

export type KimiCodingFrozenApi = ApiId & typeof KIMI_CODING_API;
export type KimiCodingFrozenAuthClass = AuthClass & typeof KIMI_CODING_AUTH_CLASS;
export type KimiCodingFrozenBillingClass = BillingClass & typeof KIMI_CODING_BILLING_CLASS;
export type KimiCodingFrozenBillingRouteClass = BillingRouteClass & typeof KIMI_CODING_BILLING_ROUTE_CLASS;
export type KimiCodingFrozenSystemPromptProfile = SystemPromptProfile & typeof KIMI_CODING_SYSTEM_PROMPT_PROFILE;
export type KimiCodingFrozenCachePolicy = CachePolicy & typeof KIMI_CODING_CACHE_POLICY;
export type KimiCodingFrozenThinking = ThinkingValue;
export type KimiCodingFrozenReasoningCapability = ReasoningCapability;
export type KimiCodingFrozenToolCapability = ToolCapability;
