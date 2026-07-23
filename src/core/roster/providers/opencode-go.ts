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
  type ProviderRecipe,
  type QualificationManifest,
  type RequestProfile,
  type RoleTemplate,
} from '../provider-recipes.ts';

function deepFreezeOpenCodeGo<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return value;
  }
  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return value;
  }
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    deepFreezeOpenCodeGo((objectValue as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(objectValue) as T;
}

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go' as const;
export const OPENCODE_GO_RECIPE_ID = 'opencode-go-plan' as const;
export const OPENCODE_GO_RECIPE_REVISION = 1 as const;
export const OPENCODE_GO_ROUTE_POLICY_ID = 'opencode-go-plan-v1' as const;
export const OPENCODE_GO_ROUTE_POLICY_REVISION = 1 as const;
export const OPENCODE_GO_PROFILE_ID = 'precision' as const;
export const OPENCODE_GO_API = 'openai-completions' as const;
export const OPENCODE_GO_AUTH_CLASS = 'api-key-plan-token' as const;
export const OPENCODE_GO_BILLING_CLASS = 'plan-token' as const;
export const OPENCODE_GO_BILLING_ROUTE_CLASS = 'plan-api-token' as const;
export const OPENCODE_GO_AUTH_MATERIAL_SHAPE = 'api-key-shaped-plan-token' as const;
export const OPENCODE_GO_EVALUATION_SCHEMA_VERSION = 'autopilot.opencode_go_qualification_evaluation.v1' as const;
export const OPENCODE_GO_MANIFEST_CANDIDATE_SCHEMA_VERSION = 'autopilot.opencode_go_qualification_manifest_candidate.v1' as const;
export const OPENCODE_GO_OFFLINE_REPORT_SCHEMA_VERSION = 'autopilot.opencode_go_w4_offline_qualification_report.v1' as const;
export const OPENCODE_GO_SYNTHETIC_FIXTURE_SCHEMA_VERSION = 'autopilot.opencode_go_provider_fixture.v1' as const;

const TEXT_MODALITIES = ['text'] as const satisfies readonly Modality[];
const FORBIDDEN_GATEWAYS = ['arbitrary-api-key', 'metered-frontier', 'openrouter'] as const;
const ALLOWED_AUTH_SOURCES = ['runtime', 'stored'] as const satisfies readonly AuthSource[];

export const OPENCODE_GO_FORBIDDEN_GATEWAYS = deepFreezeOpenCodeGo(FORBIDDEN_GATEWAYS);
export const OPENCODE_GO_ALLOWED_AUTH_SOURCES = deepFreezeOpenCodeGo(ALLOWED_AUTH_SOURCES);

function roleTemplate(
  role: RosterRole,
  modelId: 'kimi-k3' | 'kimi-k2.7-code' | 'deepseek-v4-flash',
  thinking: ThinkingValue,
  contextWindow: 128000 | 256000,
  maxOutputTokens: 16384 | 32768,
): RoleTemplate {
  return {
    role,
    model_id: modelId,
    api: OPENCODE_GO_API,
    thinking,
    service_tier: null,
    cache_policy: 'provider-default',
    system_prompt_profile: 'pi-default.v1',
    context_window: contextWindow,
    max_output_tokens: maxOutputTokens,
    input_modalities: TEXT_MODALITIES,
    output_modalities: TEXT_MODALITIES,
    reasoning_capability: 'reasoning-supported',
    tool_capability: 'tool-use-supported',
  };
}

export const OPENCODE_GO_ROLE_TEMPLATES = deepFreezeOpenCodeGo([
  roleTemplate('parent', 'kimi-k3', 'xhigh', 256000, 32768),
  roleTemplate('strategy', 'kimi-k3', 'xhigh', 256000, 32768),
  roleTemplate('implement', 'kimi-k2.7-code', 'high', 256000, 32768),
  roleTemplate('validate', 'kimi-k3', 'xhigh', 256000, 32768),
  roleTemplate('fix', 'kimi-k2.7-code', 'high', 256000, 32768),
  roleTemplate('adjudicate', 'kimi-k3', 'xhigh', 256000, 32768),
  roleTemplate('bughunt', 'kimi-k3', 'xhigh', 256000, 32768),
  roleTemplate('extract', 'deepseek-v4-flash', 'high', 128000, 16384),
] as const satisfies readonly RoleTemplate[]);

const OPENCODE_GO_ROLE_TEMPLATE_MAP: ReadonlyMap<RosterRole, RoleTemplate> = new Map(
  OPENCODE_GO_ROLE_TEMPLATES.map((template) => [template.role, template]),
);

export const OPENCODE_GO_PROVIDER_RECIPE: ProviderRecipe = (() => {
  const recipe = PROVIDER_RECIPES.find(
    (candidate) => candidate.recipe_id === OPENCODE_GO_RECIPE_ID && candidate.recipe_revision === OPENCODE_GO_RECIPE_REVISION,
  );
  if (recipe === undefined) {
    throw new Error('OpenCode Go W0 recipe authority is missing');
  }
  return recipe;
})();

export const OPENCODE_GO_MODEL_LABEL_POLICY = deepFreezeOpenCodeGo({
  labels_are_display_only: true,
  labels_do_not_imply_ranking: true,
  labels_do_not_imply_provider: true,
  provider_authority: OPENCODE_GO_PROVIDER_ID,
  route_policy_authority: OPENCODE_GO_ROUTE_POLICY_ID,
  forbidden_inference: 'model labels are never used to derive provider, route, entitlement, billing, ranking, or fallback authority',
} as const);

export const OPENCODE_GO_PENDING_LIVE_POST_W3_WITNESSES = deepFreezeOpenCodeGo([
  'non-secret plan entitlement proof for opencode-go under opencode-go-plan-v1',
  'non-secret billing-route proof for plan-api-token proving it is not OpenRouter or an arbitrary metered key',
  'authenticated observed execution for parent with exact request_profile and observed_profile',
  'authenticated observed execution for strategy with exact request_profile and observed_profile',
  'authenticated observed execution for implement with exact request_profile and observed_profile',
  'authenticated observed execution for validate with exact request_profile and observed_profile',
  'authenticated observed execution for fix with exact request_profile and observed_profile',
  'authenticated observed execution for adjudicate with exact request_profile and observed_profile',
  'authenticated observed execution for bughunt with exact request_profile and observed_profile',
  'authenticated observed execution for extract with exact request_profile and observed_profile',
  'post-W3 receipt.v2 observed execution identity for every role with no fallback',
] as const);

export type OpenCodeGoEvidenceSource = 'synthetic-fixture' | 'live-post-w3-witness';
export type OpenCodeGoAuthMaterialShape =
  | typeof OPENCODE_GO_AUTH_MATERIAL_SHAPE
  | 'generic-api-key'
  | 'oauth-token'
  | 'unknown';
export type OpenCodeGoProofKind = 'entitlement' | 'billing-route';

export interface OpenCodeGoQualificationProof {
  readonly proof_id: string;
  readonly proof_kind: OpenCodeGoProofKind;
  readonly provider_id: string;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly auth_class: AuthClass;
  readonly auth_source: AuthSource;
  readonly auth_material_shape: OpenCodeGoAuthMaterialShape;
  readonly billing_class: BillingClass;
  readonly billing_route_class: BillingRouteClass;
  readonly entitlement_state: 'plan-entitled' | 'missing' | 'unknown';
  readonly secret_free: boolean;
  readonly secret_fields_present: boolean;
  readonly no_fallback: boolean;
  readonly observed_at: string;
  readonly evidence_ref: EvidenceRef;
}

export interface OpenCodeGoRoleExecutionWitness {
  readonly witness_id: string;
  readonly role: RosterRole;
  readonly provider_id: string;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly authenticated: boolean;
  readonly auth_class: AuthClass;
  readonly auth_source: AuthSource;
  readonly billing_route_class: BillingRouteClass;
  readonly request_profile: RequestProfile;
  readonly observed_profile: ObservedProfile;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly no_fallback: boolean;
}

export interface OpenCodeGoQualificationInput {
  readonly schema_version: 'autopilot.opencode_go_qualification_input.v1';
  readonly evidence_source: OpenCodeGoEvidenceSource;
  readonly provider_id: string;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly auth_class: AuthClass;
  readonly auth_source: AuthSource;
  readonly auth_material_shape: OpenCodeGoAuthMaterialShape;
  readonly billing_class: BillingClass;
  readonly billing_route_class: BillingRouteClass;
  readonly gateway_id: string | null;
  readonly entitlement_proof: OpenCodeGoQualificationProof | null;
  readonly billing_route_proof: OpenCodeGoQualificationProof | null;
  readonly role_witnesses: readonly OpenCodeGoRoleExecutionWitness[];
  readonly no_fallback: boolean;
}

export type OpenCodeGoQualificationIssueCode =
  | 'OPENCODE_GO_AUTH_SOURCE_FORBIDDEN'
  | 'OPENCODE_GO_AUTHENTICATED_EXECUTION_REQUIRED'
  | 'OPENCODE_GO_BILLING_ROUTE_PROOF_REQUIRED'
  | 'OPENCODE_GO_ENTITLEMENT_PROOF_REQUIRED'
  | 'OPENCODE_GO_EVIDENCE_REF_SECRET_FORBIDDEN'
  | 'OPENCODE_GO_EXECUTION_EVIDENCE_REQUIRED'
  | 'OPENCODE_GO_FORBIDDEN_GATEWAY'
  | 'OPENCODE_GO_GENERIC_API_KEY_FORBIDDEN'
  | 'OPENCODE_GO_LIVE_WITNESS_SOURCE_REQUIRED'
  | 'OPENCODE_GO_MIXED_ROUTE_FORBIDDEN'
  | 'OPENCODE_GO_NETWORK_EVIDENCE_FORBIDDEN'
  | 'OPENCODE_GO_NO_FALLBACK_REQUIRED'
  | 'OPENCODE_GO_OBSERVED_PROFILE_MISMATCH'
  | 'OPENCODE_GO_PLAN_TOKEN_PROOF_REQUIRED'
  | 'OPENCODE_GO_PROVIDER_ID_MISMATCH'
  | 'OPENCODE_GO_REQUEST_PROFILE_MISMATCH'
  | 'OPENCODE_GO_ROLE_WITNESS_REQUIRED'
  | 'OPENCODE_GO_ROUTE_POLICY_MISMATCH'
  | 'OPENCODE_GO_ROUTE_TOKEN_SHAPE_IS_NOT_API_KEY_PERMISSION'
  | 'OPENCODE_GO_SECRET_PROOF_FORBIDDEN';

export interface OpenCodeGoQualificationIssue {
  readonly code: OpenCodeGoQualificationIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface OpenCodeGoQualificationEvaluation {
  readonly schema_version: typeof OPENCODE_GO_EVALUATION_SCHEMA_VERSION;
  readonly provider_id: typeof OPENCODE_GO_PROVIDER_ID;
  readonly route_policy_id: typeof OPENCODE_GO_ROUTE_POLICY_ID;
  readonly route_policy_revision: typeof OPENCODE_GO_ROUTE_POLICY_REVISION;
  readonly evidence_source: OpenCodeGoEvidenceSource;
  readonly structural_pass: boolean;
  readonly certification_ready: boolean;
  readonly qualification_state: QualificationState;
  readonly non_certifying: boolean;
  readonly synthetic_fixture_non_certifying: boolean;
  readonly no_network: true;
  readonly pending_live_post_w3_witnesses: readonly string[];
  readonly issues: readonly OpenCodeGoQualificationIssue[];
  readonly evaluation_sha256: Digest;
}

export interface OpenCodeGoManifestCandidate {
  readonly schema_version: typeof OPENCODE_GO_MANIFEST_CANDIDATE_SCHEMA_VERSION;
  readonly provider_id: typeof OPENCODE_GO_PROVIDER_ID;
  readonly recipe_id: typeof OPENCODE_GO_RECIPE_ID;
  readonly recipe_revision: typeof OPENCODE_GO_RECIPE_REVISION;
  readonly route_policy_id: typeof OPENCODE_GO_ROUTE_POLICY_ID;
  readonly route_policy_revision: typeof OPENCODE_GO_ROUTE_POLICY_REVISION;
  readonly qualification_state: QualificationState;
  readonly certification_ready: boolean;
  readonly non_certifying: boolean;
  readonly synthetic_fixture_non_certifying: boolean;
  readonly no_network: true;
  readonly pending_live_post_w3_witnesses: readonly string[];
  readonly evaluation: OpenCodeGoQualificationEvaluation;
  readonly certification_manifest: QualificationManifest;
  readonly manifest_candidate_sha256: Digest;
}

export interface OpenCodeGoOfflineQualificationReport {
  readonly schema_version: typeof OPENCODE_GO_OFFLINE_REPORT_SCHEMA_VERSION;
  readonly phase: 'phase37-w4';
  readonly provider_id: typeof OPENCODE_GO_PROVIDER_ID;
  readonly recipe_id: typeof OPENCODE_GO_RECIPE_ID;
  readonly route_policy_id: typeof OPENCODE_GO_ROUTE_POLICY_ID;
  readonly offline: true;
  readonly network_calls: 0;
  readonly qualification_state: QualificationState;
  readonly live_provider_certification_asserted: false;
  readonly synthetic_fixtures_certifying: false;
  readonly openrouter_or_arbitrary_keys_allowed: false;
  readonly generic_api_key_permission_allowed: false;
  readonly pending_live_post_w3_witnesses: readonly string[];
  readonly manifest_candidate: OpenCodeGoManifestCandidate;
  readonly report_sha256: Digest;
}

export function isOpenCodeGoRole(value: string): value is RosterRole {
  return (ROSTER_ROLE_ORDER as readonly string[]).includes(value);
}

export function openCodeGoRoleTemplate(role: RosterRole): RoleTemplate {
  const template = OPENCODE_GO_ROLE_TEMPLATE_MAP.get(role);
  if (template === undefined) {
    throw new Error(`OpenCode Go role template missing for ${role}`);
  }
  return template;
}

export function buildOpenCodeGoRequestProfile(role: RosterRole): RequestProfile {
  const template = openCodeGoRoleTemplate(role);
  const withoutHash = {
    provider_id: OPENCODE_GO_PROVIDER_ID,
    model_id: template.model_id,
    model: `${OPENCODE_GO_PROVIDER_ID}/${template.model_id}`,
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
    route_policy_id: OPENCODE_GO_ROUTE_POLICY_ID,
    route_policy_revision: OPENCODE_GO_ROUTE_POLICY_REVISION,
  } satisfies Omit<RequestProfile, 'request_profile_sha256'>;
  return { ...withoutHash, request_profile_sha256: canonicalSha256(withoutHash) };
}

export function buildOpenCodeGoObservedProfile(role: RosterRole, systemPromptSha256: Digest): ObservedProfile {
  const requestProfile = buildOpenCodeGoRequestProfile(role);
  const withoutHash = {
    provider_id: OPENCODE_GO_PROVIDER_ID,
    requested_model_id: requestProfile.model_id,
    executed_model_id: requestProfile.model_id,
    api: requestProfile.api,
    thinking: requestProfile.thinking,
    service_tier: requestProfile.service_tier,
    cache_policy: requestProfile.cache_policy,
    system_prompt_profile: requestProfile.system_prompt_profile,
    system_prompt_sha256: systemPromptSha256,
    route_policy_id: OPENCODE_GO_ROUTE_POLICY_ID,
    route_policy_revision: OPENCODE_GO_ROUTE_POLICY_REVISION,
    request_profile_sha256: requestProfile.request_profile_sha256,
  } satisfies Omit<ObservedProfile, 'observed_profile_sha256'>;
  return { ...withoutHash, observed_profile_sha256: canonicalSha256(withoutHash) };
}

export function evaluateOpenCodeGoQualification(input: OpenCodeGoQualificationInput): OpenCodeGoQualificationEvaluation {
  const issues: OpenCodeGoQualificationIssue[] = [];
  const routeKeys: string[] = [];

  validateTopLevelRoute(input, issues, routeKeys);
  validateQualificationProof(input.entitlement_proof, 'entitlement', 'entitlement_proof', input.evidence_source, issues, routeKeys);
  validateQualificationProof(input.billing_route_proof, 'billing-route', 'billing_route_proof', input.evidence_source, issues, routeKeys);
  validateRoleWitnesses(input.role_witnesses, input.evidence_source, issues, routeKeys);
  validateMixedRoute(routeKeys, issues);

  const uniqueIssues = sortIssues(issues);
  const structuralPass = uniqueIssues.length === 0;
  const certificationReady = structuralPass && input.evidence_source === 'live-post-w3-witness';
  const pendingLiveWitnesses = certificationReady ? [] : OPENCODE_GO_PENDING_LIVE_POST_W3_WITNESSES;
  const qualificationState: QualificationState = certificationReady ? 'w4-certified-ready' : 'qualification-required';
  const withoutHash = {
    schema_version: OPENCODE_GO_EVALUATION_SCHEMA_VERSION,
    provider_id: OPENCODE_GO_PROVIDER_ID,
    route_policy_id: OPENCODE_GO_ROUTE_POLICY_ID,
    route_policy_revision: OPENCODE_GO_ROUTE_POLICY_REVISION,
    evidence_source: input.evidence_source,
    structural_pass: structuralPass,
    certification_ready: certificationReady,
    qualification_state: qualificationState,
    non_certifying: !certificationReady,
    synthetic_fixture_non_certifying: input.evidence_source === 'synthetic-fixture',
    no_network: true as const,
    pending_live_post_w3_witnesses: pendingLiveWitnesses,
    issues: uniqueIssues,
  } satisfies Omit<OpenCodeGoQualificationEvaluation, 'evaluation_sha256'>;
  return { ...withoutHash, evaluation_sha256: canonicalSha256(withoutHash) };
}

export function buildOpenCodeGoQualificationManifestCandidate(input: OpenCodeGoQualificationInput): OpenCodeGoManifestCandidate {
  const evaluation = evaluateOpenCodeGoQualification(input);
  const certificationManifest = buildQualificationManifest(input, evaluation);
  const withoutHash = {
    schema_version: OPENCODE_GO_MANIFEST_CANDIDATE_SCHEMA_VERSION,
    provider_id: OPENCODE_GO_PROVIDER_ID,
    recipe_id: OPENCODE_GO_RECIPE_ID,
    recipe_revision: OPENCODE_GO_RECIPE_REVISION,
    route_policy_id: OPENCODE_GO_ROUTE_POLICY_ID,
    route_policy_revision: OPENCODE_GO_ROUTE_POLICY_REVISION,
    qualification_state: evaluation.qualification_state,
    certification_ready: evaluation.certification_ready,
    non_certifying: evaluation.non_certifying,
    synthetic_fixture_non_certifying: evaluation.synthetic_fixture_non_certifying,
    no_network: true as const,
    pending_live_post_w3_witnesses: evaluation.pending_live_post_w3_witnesses,
    evaluation,
    certification_manifest: certificationManifest,
  } satisfies Omit<OpenCodeGoManifestCandidate, 'manifest_candidate_sha256'>;
  return { ...withoutHash, manifest_candidate_sha256: canonicalSha256(withoutHash) };
}

export function buildOpenCodeGoOfflineQualificationReport(input: OpenCodeGoQualificationInput): OpenCodeGoOfflineQualificationReport {
  const manifestCandidate = buildOpenCodeGoQualificationManifestCandidate(input);
  const withoutHash = {
    schema_version: OPENCODE_GO_OFFLINE_REPORT_SCHEMA_VERSION,
    phase: 'phase37-w4' as const,
    provider_id: OPENCODE_GO_PROVIDER_ID,
    recipe_id: OPENCODE_GO_RECIPE_ID,
    route_policy_id: OPENCODE_GO_ROUTE_POLICY_ID,
    offline: true as const,
    network_calls: 0 as const,
    qualification_state: manifestCandidate.qualification_state,
    live_provider_certification_asserted: false as const,
    synthetic_fixtures_certifying: false as const,
    openrouter_or_arbitrary_keys_allowed: false as const,
    generic_api_key_permission_allowed: false as const,
    pending_live_post_w3_witnesses: manifestCandidate.pending_live_post_w3_witnesses,
    manifest_candidate: manifestCandidate,
  } satisfies Omit<OpenCodeGoOfflineQualificationReport, 'report_sha256'>;
  return { ...withoutHash, report_sha256: canonicalSha256(withoutHash) };
}

export function makeOpenCodeGoSyntheticQualificationInput(): OpenCodeGoQualificationInput {
  const observedAt = '2026-07-23T00:00:00.000Z';
  const entitlementEvidence = evidenceRef(
    'fixture-opencode-go-plan-entitlement-proof',
    'route-proof',
    'fixture://phase37/opencode-go/entitlement-route-proof',
  );
  const billingEvidence = evidenceRef(
    'fixture-opencode-go-billing-route-proof',
    'billing-proof',
    'fixture://phase37/opencode-go/billing-route-proof',
  );
  return {
    schema_version: 'autopilot.opencode_go_qualification_input.v1',
    evidence_source: 'synthetic-fixture',
    provider_id: OPENCODE_GO_PROVIDER_ID,
    route_policy_id: OPENCODE_GO_ROUTE_POLICY_ID,
    route_policy_revision: OPENCODE_GO_ROUTE_POLICY_REVISION,
    auth_class: OPENCODE_GO_AUTH_CLASS,
    auth_source: 'stored',
    auth_material_shape: OPENCODE_GO_AUTH_MATERIAL_SHAPE,
    billing_class: OPENCODE_GO_BILLING_CLASS,
    billing_route_class: OPENCODE_GO_BILLING_ROUTE_CLASS,
    gateway_id: OPENCODE_GO_PROVIDER_ID,
    entitlement_proof: proof('fixture-opencode-go-plan-entitlement-proof', 'entitlement', entitlementEvidence, observedAt),
    billing_route_proof: proof('fixture-opencode-go-billing-route-proof', 'billing-route', billingEvidence, observedAt),
    role_witnesses: ROSTER_ROLE_ORDER.map((role) => makeSyntheticRoleWitness(role)),
    no_fallback: true,
  };
}

export function openCodeGoFixtureDigest(label: string): Digest {
  return canonicalSha256({ provider_id: OPENCODE_GO_PROVIDER_ID, fixture_label: label });
}

function makeSyntheticRoleWitness(role: RosterRole): OpenCodeGoRoleExecutionWitness {
  const systemPromptSha256 = openCodeGoFixtureDigest(`system-prompt-${role}`);
  const evidence = evidenceRef(
    `fixture-opencode-go-exec-${role}-proof`,
    'execution-proof',
    `fixture://phase37/opencode-go/execution/${role}`,
  );
  return {
    witness_id: `fixture-opencode-go-${role}-execution`,
    role,
    provider_id: OPENCODE_GO_PROVIDER_ID,
    route_policy_id: OPENCODE_GO_ROUTE_POLICY_ID,
    route_policy_revision: OPENCODE_GO_ROUTE_POLICY_REVISION,
    authenticated: true,
    auth_class: OPENCODE_GO_AUTH_CLASS,
    auth_source: 'stored',
    billing_route_class: OPENCODE_GO_BILLING_ROUTE_CLASS,
    request_profile: buildOpenCodeGoRequestProfile(role),
    observed_profile: buildOpenCodeGoObservedProfile(role, systemPromptSha256),
    evidence_refs: [evidence],
    no_fallback: true,
  };
}

function proof(
  proofId: string,
  proofKind: OpenCodeGoProofKind,
  evidence: EvidenceRef,
  observedAt: string,
): OpenCodeGoQualificationProof {
  return {
    proof_id: proofId,
    proof_kind: proofKind,
    provider_id: OPENCODE_GO_PROVIDER_ID,
    route_policy_id: OPENCODE_GO_ROUTE_POLICY_ID,
    route_policy_revision: OPENCODE_GO_ROUTE_POLICY_REVISION,
    auth_class: OPENCODE_GO_AUTH_CLASS,
    auth_source: 'stored',
    auth_material_shape: OPENCODE_GO_AUTH_MATERIAL_SHAPE,
    billing_class: OPENCODE_GO_BILLING_CLASS,
    billing_route_class: OPENCODE_GO_BILLING_ROUTE_CLASS,
    entitlement_state: 'plan-entitled',
    secret_free: true,
    secret_fields_present: false,
    no_fallback: true,
    observed_at: observedAt,
    evidence_ref: evidence,
  };
}

function evidenceRef(evidenceId: string, kind: EvidenceRef['kind'], uri: string): EvidenceRef {
  return {
    evidence_id: evidenceId,
    kind,
    uri,
    sha256: null,
    byte_count: null,
    secret_free: true,
  };
}

function validateTopLevelRoute(
  input: OpenCodeGoQualificationInput,
  issues: OpenCodeGoQualificationIssue[],
  routeKeys: string[],
): void {
  routeKeys.push(routeKey(input.provider_id, input.route_policy_id, input.route_policy_revision, input.billing_route_class));
  if (input.schema_version !== 'autopilot.opencode_go_qualification_input.v1') {
    pushIssue(issues, 'OPENCODE_GO_ROUTE_POLICY_MISMATCH', 'schema_version', 'OpenCode Go qualification input schema is exact');
  }
  if (input.provider_id !== OPENCODE_GO_PROVIDER_ID) {
    pushIssue(issues, 'OPENCODE_GO_PROVIDER_ID_MISMATCH', 'provider_id', 'provider_id must be exactly opencode-go');
  }
  validateRoutePolicyCarrier(
    {
      provider_id: input.provider_id,
      route_policy_id: input.route_policy_id,
      route_policy_revision: input.route_policy_revision,
      auth_class: input.auth_class,
      auth_source: input.auth_source,
      auth_material_shape: input.auth_material_shape,
      billing_class: input.billing_class,
      billing_route_class: input.billing_route_class,
      no_fallback: input.no_fallback,
    },
    '',
    issues,
  );
  if (input.gateway_id !== null && FORBIDDEN_GATEWAYS.includes(input.gateway_id as (typeof FORBIDDEN_GATEWAYS)[number])) {
    pushIssue(issues, 'OPENCODE_GO_FORBIDDEN_GATEWAY', 'gateway_id', 'OpenRouter, arbitrary keys, and metered gateways are forbidden');
  } else if (input.gateway_id !== null && input.gateway_id !== OPENCODE_GO_PROVIDER_ID) {
    pushIssue(issues, 'OPENCODE_GO_MIXED_ROUTE_FORBIDDEN', 'gateway_id', 'gateway/provider must remain the exact OpenCode Go plan route');
  }
  if (input.evidence_source !== 'synthetic-fixture' && input.evidence_source !== 'live-post-w3-witness') {
    pushIssue(issues, 'OPENCODE_GO_LIVE_WITNESS_SOURCE_REQUIRED', 'evidence_source', 'evidence source must be synthetic-fixture or live-post-W3 witness');
  }
}

function validateQualificationProof(
  proofValue: OpenCodeGoQualificationProof | null,
  expectedKind: OpenCodeGoProofKind,
  path: string,
  evidenceSource: OpenCodeGoEvidenceSource,
  issues: OpenCodeGoQualificationIssue[],
  routeKeys: string[],
): void {
  if (proofValue === null) {
    pushIssue(
      issues,
      expectedKind === 'entitlement' ? 'OPENCODE_GO_ENTITLEMENT_PROOF_REQUIRED' : 'OPENCODE_GO_BILLING_ROUTE_PROOF_REQUIRED',
      path,
      expectedKind === 'entitlement'
        ? 'non-secret plan entitlement proof is required'
        : 'non-secret billing-route proof is required',
    );
    return;
  }
  routeKeys.push(routeKey(proofValue.provider_id, proofValue.route_policy_id, proofValue.route_policy_revision, proofValue.billing_route_class));
  if (proofValue.proof_kind !== expectedKind) {
    pushIssue(
      issues,
      expectedKind === 'entitlement' ? 'OPENCODE_GO_ENTITLEMENT_PROOF_REQUIRED' : 'OPENCODE_GO_BILLING_ROUTE_PROOF_REQUIRED',
      `${path}.proof_kind`,
      `proof kind must be ${expectedKind}`,
    );
  }
  const expectedEvidenceKind: EvidenceRef['kind'] = expectedKind === 'entitlement' ? 'route-proof' : 'billing-proof';
  if (proofValue.evidence_ref.kind !== expectedEvidenceKind) {
    pushIssue(
      issues,
      expectedKind === 'entitlement' ? 'OPENCODE_GO_ENTITLEMENT_PROOF_REQUIRED' : 'OPENCODE_GO_BILLING_ROUTE_PROOF_REQUIRED',
      `${path}.evidence_ref.kind`,
      `proof evidence kind must be ${expectedEvidenceKind}`,
    );
  }
  validateRoutePolicyCarrier(proofValue, path, issues);
  if (proofValue.entitlement_state !== 'plan-entitled') {
    pushIssue(issues, 'OPENCODE_GO_ENTITLEMENT_PROOF_REQUIRED', `${path}.entitlement_state`, 'plan entitlement must be observed');
  }
  if (proofValue.secret_free !== true || proofValue.secret_fields_present !== false) {
    pushIssue(issues, 'OPENCODE_GO_SECRET_PROOF_FORBIDDEN', path, 'qualification proof must be non-secret');
  }
  validateEvidenceRefs([proofValue.evidence_ref], `${path}.evidence_ref`, evidenceSource, issues, expectedEvidenceKind);
}

interface RoutePolicyCarrier {
  readonly provider_id: string;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly auth_class: AuthClass;
  readonly auth_source: AuthSource;
  readonly auth_material_shape: OpenCodeGoAuthMaterialShape;
  readonly billing_class: BillingClass;
  readonly billing_route_class: BillingRouteClass;
  readonly no_fallback: boolean;
}

function validateRoutePolicyCarrier(carrier: RoutePolicyCarrier, pathPrefix: string, issues: OpenCodeGoQualificationIssue[]): void {
  const path = (field: string): string => pathPrefix.length === 0 ? field : `${pathPrefix}.${field}`;
  if (carrier.provider_id !== OPENCODE_GO_PROVIDER_ID) {
    pushIssue(issues, 'OPENCODE_GO_PROVIDER_ID_MISMATCH', path('provider_id'), 'provider_id must be exactly opencode-go');
  }
  if (carrier.route_policy_id !== OPENCODE_GO_ROUTE_POLICY_ID || carrier.route_policy_revision !== OPENCODE_GO_ROUTE_POLICY_REVISION) {
    pushIssue(issues, 'OPENCODE_GO_ROUTE_POLICY_MISMATCH', path('route_policy_id'), 'route policy must be exactly opencode-go-plan-v1@1');
  }
  if (carrier.auth_class === 'api-key') {
    pushIssue(issues, 'OPENCODE_GO_GENERIC_API_KEY_FORBIDDEN', path('auth_class'), 'API-key-shaped plan token is not generic API-key permission');
  }
  if (carrier.auth_class !== OPENCODE_GO_AUTH_CLASS) {
    pushIssue(issues, 'OPENCODE_GO_PLAN_TOKEN_PROOF_REQUIRED', path('auth_class'), 'auth_class must be api-key-plan-token');
  }
  if (carrier.auth_material_shape === OPENCODE_GO_AUTH_MATERIAL_SHAPE && carrier.auth_class !== OPENCODE_GO_AUTH_CLASS) {
    pushIssue(
      issues,
      'OPENCODE_GO_ROUTE_TOKEN_SHAPE_IS_NOT_API_KEY_PERMISSION',
      path('auth_material_shape'),
      'API-key-shaped token shape proves only the plan-token route when auth_class is api-key-plan-token',
    );
  }
  if (carrier.auth_material_shape !== OPENCODE_GO_AUTH_MATERIAL_SHAPE) {
    pushIssue(issues, 'OPENCODE_GO_PLAN_TOKEN_PROOF_REQUIRED', path('auth_material_shape'), 'auth material shape must be the plan-token shape');
  }
  if (!(ALLOWED_AUTH_SOURCES as readonly string[]).includes(carrier.auth_source)) {
    pushIssue(issues, 'OPENCODE_GO_AUTH_SOURCE_FORBIDDEN', path('auth_source'), 'auth_source must be runtime or stored, never environment fallback');
  }
  if (carrier.billing_class !== OPENCODE_GO_BILLING_CLASS || carrier.billing_route_class !== OPENCODE_GO_BILLING_ROUTE_CLASS) {
    pushIssue(issues, 'OPENCODE_GO_BILLING_ROUTE_PROOF_REQUIRED', path('billing_route_class'), 'billing route must be plan-api-token');
  }
  if (carrier.no_fallback !== true) {
    pushIssue(issues, 'OPENCODE_GO_NO_FALLBACK_REQUIRED', path('no_fallback'), 'fallback is forbidden');
  }
}

function validateRoleWitnesses(
  roleWitnesses: readonly OpenCodeGoRoleExecutionWitness[],
  evidenceSource: OpenCodeGoEvidenceSource,
  issues: OpenCodeGoQualificationIssue[],
  routeKeys: string[],
): void {
  for (const role of ROSTER_ROLE_ORDER) {
    const matching = roleWitnesses.filter((witness) => witness.role === role);
    if (matching.length !== 1) {
      pushIssue(issues, 'OPENCODE_GO_ROLE_WITNESS_REQUIRED', `role_witnesses.${role}`, 'exactly one authenticated observed execution witness is required for every role');
    }
  }

  roleWitnesses.forEach((witness, index) => {
    const path = `role_witnesses[${String(index)}]`;
    routeKeys.push(routeKey(witness.provider_id, witness.route_policy_id, witness.route_policy_revision, witness.billing_route_class));
    if (!isOpenCodeGoRole(String(witness.role))) {
      pushIssue(issues, 'OPENCODE_GO_ROLE_WITNESS_REQUIRED', `${path}.role`, 'role must be one of the frozen roster roles');
      return;
    }
    validateWitnessRoute(witness, path, issues);
    validateRequestProfileExact(witness.role, witness.request_profile, `${path}.request_profile`, issues, routeKeys);
    validateObservedProfileExact(witness.role, witness.observed_profile, `${path}.observed_profile`, issues, routeKeys);
    validateEvidenceRefs(witness.evidence_refs, `${path}.evidence_refs`, evidenceSource, issues, 'execution-proof');
  });
}

function validateWitnessRoute(witness: OpenCodeGoRoleExecutionWitness, path: string, issues: OpenCodeGoQualificationIssue[]): void {
  if (witness.provider_id !== OPENCODE_GO_PROVIDER_ID) {
    pushIssue(issues, 'OPENCODE_GO_PROVIDER_ID_MISMATCH', `${path}.provider_id`, 'role witness provider must be opencode-go');
  }
  if (witness.route_policy_id !== OPENCODE_GO_ROUTE_POLICY_ID || witness.route_policy_revision !== OPENCODE_GO_ROUTE_POLICY_REVISION) {
    pushIssue(issues, 'OPENCODE_GO_ROUTE_POLICY_MISMATCH', `${path}.route_policy_id`, 'role witness route must be opencode-go-plan-v1@1');
  }
  if (witness.authenticated !== true) {
    pushIssue(issues, 'OPENCODE_GO_AUTHENTICATED_EXECUTION_REQUIRED', `${path}.authenticated`, 'role execution must be authenticated');
  }
  if (witness.auth_class === 'api-key') {
    pushIssue(issues, 'OPENCODE_GO_GENERIC_API_KEY_FORBIDDEN', `${path}.auth_class`, 'generic API key is forbidden for OpenCode Go qualification');
  }
  if (witness.auth_class !== OPENCODE_GO_AUTH_CLASS) {
    pushIssue(issues, 'OPENCODE_GO_PLAN_TOKEN_PROOF_REQUIRED', `${path}.auth_class`, 'role execution auth_class must be api-key-plan-token');
  }
  if (!(ALLOWED_AUTH_SOURCES as readonly string[]).includes(witness.auth_source)) {
    pushIssue(issues, 'OPENCODE_GO_AUTH_SOURCE_FORBIDDEN', `${path}.auth_source`, 'role execution auth_source must be runtime or stored');
  }
  if (witness.billing_route_class !== OPENCODE_GO_BILLING_ROUTE_CLASS) {
    pushIssue(issues, 'OPENCODE_GO_BILLING_ROUTE_PROOF_REQUIRED', `${path}.billing_route_class`, 'role execution billing route must be plan-api-token');
  }
  if (witness.no_fallback !== true) {
    pushIssue(issues, 'OPENCODE_GO_NO_FALLBACK_REQUIRED', `${path}.no_fallback`, 'role execution fallback is forbidden');
  }
}

function validateRequestProfileExact(
  role: RosterRole,
  requestProfile: RequestProfile,
  path: string,
  issues: OpenCodeGoQualificationIssue[],
  routeKeys: string[],
): void {
  const expected = buildOpenCodeGoRequestProfile(role);
  routeKeys.push(routeKey(requestProfile.provider_id, requestProfile.route_policy_id, requestProfile.route_policy_revision, OPENCODE_GO_BILLING_ROUTE_CLASS));
  for (const key of Object.keys(expected) as readonly (keyof RequestProfile)[]) {
    if (!jsonEqual(requestProfile[key], expected[key])) {
      pushIssue(issues, 'OPENCODE_GO_REQUEST_PROFILE_MISMATCH', `${path}.${String(key)}`, `request profile for ${role} must match the frozen OpenCode Go role template`);
    }
  }
  const recomputed = hashRequestProfile(requestProfile);
  if (requestProfile.request_profile_sha256 !== recomputed) {
    pushIssue(issues, 'OPENCODE_GO_REQUEST_PROFILE_MISMATCH', `${path}.request_profile_sha256`, 'request_profile_sha256 must hash the exact request profile');
  }
}

function validateObservedProfileExact(
  role: RosterRole,
  observedProfile: ObservedProfile,
  path: string,
  issues: OpenCodeGoQualificationIssue[],
  routeKeys: string[],
): void {
  const expectedRequest = buildOpenCodeGoRequestProfile(role);
  routeKeys.push(routeKey(observedProfile.provider_id, observedProfile.route_policy_id, observedProfile.route_policy_revision, OPENCODE_GO_BILLING_ROUTE_CLASS));
  const expectedPairs: readonly [keyof ObservedProfile, unknown][] = [
    ['provider_id', OPENCODE_GO_PROVIDER_ID],
    ['requested_model_id', expectedRequest.model_id],
    ['executed_model_id', expectedRequest.model_id],
    ['api', expectedRequest.api],
    ['thinking', expectedRequest.thinking],
    ['service_tier', expectedRequest.service_tier],
    ['cache_policy', expectedRequest.cache_policy],
    ['system_prompt_profile', expectedRequest.system_prompt_profile],
    ['route_policy_id', OPENCODE_GO_ROUTE_POLICY_ID],
    ['route_policy_revision', OPENCODE_GO_ROUTE_POLICY_REVISION],
    ['request_profile_sha256', expectedRequest.request_profile_sha256],
  ];
  for (const [key, expectedValue] of expectedPairs) {
    if (!jsonEqual(observedProfile[key], expectedValue)) {
      pushIssue(issues, 'OPENCODE_GO_OBSERVED_PROFILE_MISMATCH', `${path}.${String(key)}`, `observed profile for ${role} must match authenticated final execution identity`);
    }
  }
  if (!isSha256Digest(observedProfile.system_prompt_sha256)) {
    pushIssue(issues, 'OPENCODE_GO_OBSERVED_PROFILE_MISMATCH', `${path}.system_prompt_sha256`, 'observed profile must include a non-secret system prompt hash');
  }
  const recomputed = hashObservedProfile(observedProfile);
  if (observedProfile.observed_profile_sha256 !== recomputed) {
    pushIssue(issues, 'OPENCODE_GO_OBSERVED_PROFILE_MISMATCH', `${path}.observed_profile_sha256`, 'observed_profile_sha256 must hash the exact observed profile');
  }
}

function validateEvidenceRefs(
  evidenceRefs: readonly EvidenceRef[],
  path: string,
  evidenceSource: OpenCodeGoEvidenceSource,
  issues: OpenCodeGoQualificationIssue[],
  requiredKind: EvidenceRef['kind'],
): void {
  if (evidenceRefs.length === 0) {
    pushIssue(issues, 'OPENCODE_GO_EXECUTION_EVIDENCE_REQUIRED', path, 'evidence reference is required');
    return;
  }
  let hasRequiredKind = false;
  evidenceRefs.forEach((ref, index) => {
    const refPath = `${path}[${String(index)}]`;
    if (ref.kind === requiredKind) {
      hasRequiredKind = true;
    }
    if (ref.secret_free !== true) {
      pushIssue(issues, 'OPENCODE_GO_EVIDENCE_REF_SECRET_FORBIDDEN', `${refPath}.secret_free`, 'evidence refs must be secret-free');
    }
    if (/^https?:\/\//u.test(ref.uri)) {
      pushIssue(issues, 'OPENCODE_GO_NETWORK_EVIDENCE_FORBIDDEN', `${refPath}.uri`, 'offline provider pack evidence must not require network access');
    }
    if (
      evidenceSource === 'live-post-w3-witness' &&
      (ref.uri.startsWith('fixture://') || ref.evidence_id.startsWith('fixture-') || ref.kind === 'synthetic-fixture')
    ) {
      pushIssue(issues, 'OPENCODE_GO_LIVE_WITNESS_SOURCE_REQUIRED', refPath, 'live W4 certification requires non-fixture post-W3 witness evidence');
    }
  });
  if (!hasRequiredKind) {
    pushIssue(issues, 'OPENCODE_GO_EXECUTION_EVIDENCE_REQUIRED', path, `at least one ${requiredKind} evidence ref is required`);
  }
}

function validateMixedRoute(routeKeys: readonly string[], issues: OpenCodeGoQualificationIssue[]): void {
  const unique = new Set(routeKeys);
  if (unique.size > 1) {
    pushIssue(issues, 'OPENCODE_GO_MIXED_ROUTE_FORBIDDEN', 'route', 'all proofs, request profiles, and observed profiles must use one exact OpenCode Go route');
  }
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

function buildQualificationManifest(
  input: OpenCodeGoQualificationInput,
  evaluation: OpenCodeGoQualificationEvaluation,
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
      ? 'opencode-go-plan-w4-qualified-v1'
      : 'opencode-go-plan-qualification-required-v1',
    manifest_revision: 1,
    subject_kind: 'provider_recipe' as const,
    subject_id: OPENCODE_GO_RECIPE_ID,
    subject_sha256: OPENCODE_GO_PROVIDER_RECIPE.recipe_sha256,
    package_version: PHASE37_PACKAGE_VERSION,
    pi_version: PHASE37_PI_VERSION,
    qualification_state: evaluation.qualification_state,
    role_results: roleResults,
    required_evidence: OPENCODE_GO_REQUIRED_EVIDENCE_REFS,
    live_evidence: evaluation.certification_ready ? liveEvidenceRefs(input) : [] as readonly EvidenceRef[],
    issued_at: '2026-07-23T00:00:00.000Z',
    expires_at: '2026-08-22T00:00:00.000Z',
  } satisfies Omit<QualificationManifest, 'manifest_sha256'>;
  return { ...withoutHash, manifest_sha256: canonicalSha256(withoutHash) };
}

function requiredExecutionEvidenceRef(role: RosterRole): EvidenceRef {
  const ref = OPENCODE_GO_REQUIRED_EVIDENCE_REFS.find((candidate) => candidate.evidence_id === `opencode-go-exec-${role}-proof`);
  if (ref === undefined) {
    throw new Error(`missing required execution evidence ref for ${role}`);
  }
  return ref;
}

function liveEvidenceRefs(input: OpenCodeGoQualificationInput): readonly EvidenceRef[] {
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

export const OPENCODE_GO_REQUIRED_EVIDENCE_REFS = deepFreezeOpenCodeGo(sortEvidenceRefs([
  evidenceRef('opencode-go-plan-entitlement-proof', 'route-proof', 'witness-required://phase37/opencode-go/plan-entitlement'),
  evidenceRef('opencode-go-billing-route-proof', 'billing-proof', 'witness-required://phase37/opencode-go/billing-route'),
  ...ROSTER_ROLE_ORDER.map((role) => evidenceRef(
    `opencode-go-exec-${role}-proof`,
    'execution-proof',
    `witness-required://phase37/opencode-go/execution/${role}`,
  )),
]));

function routeKey(providerId: string, routePolicyId: string, routePolicyRevision: number, billingRouteClass: BillingRouteClass): string {
  return `${providerId}\0${routePolicyId}\0${String(routePolicyRevision)}\0${billingRouteClass}`;
}

function pushIssue(
  issues: OpenCodeGoQualificationIssue[],
  code: OpenCodeGoQualificationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function sortIssues(issues: readonly OpenCodeGoQualificationIssue[]): readonly OpenCodeGoQualificationIssue[] {
  const byIdentity = new Map<string, OpenCodeGoQualificationIssue>();
  for (const issue of issues) {
    byIdentity.set(`${issue.code}\0${issue.path}`, issue);
  }
  return [...byIdentity.values()].sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path));
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSha256Digest(value: string): value is Digest {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

export type OpenCodeGoRequestCompatibilityProfile = Readonly<{
  provider_id: typeof OPENCODE_GO_PROVIDER_ID;
  api: typeof OPENCODE_GO_API;
  service_tier: ServiceTier;
  cache_policy: CachePolicy;
  system_prompt_profile: SystemPromptProfile;
  input_modalities: readonly Modality[];
  output_modalities: readonly Modality[];
  reasoning_capability: ReasoningCapability;
  tool_capability: ToolCapability;
}>;

export const OPENCODE_GO_REQUEST_COMPATIBILITY_PROFILE = deepFreezeOpenCodeGo({
  provider_id: OPENCODE_GO_PROVIDER_ID,
  api: OPENCODE_GO_API,
  service_tier: null,
  cache_policy: 'provider-default',
  system_prompt_profile: 'pi-default.v1',
  input_modalities: TEXT_MODALITIES,
  output_modalities: TEXT_MODALITIES,
  reasoning_capability: 'reasoning-supported',
  tool_capability: 'tool-use-supported',
} as const satisfies OpenCodeGoRequestCompatibilityProfile);

export type OpenCodeGoFrozenModelId = (typeof OPENCODE_GO_ROLE_TEMPLATES)[number]['model_id'];
export type OpenCodeGoFrozenApi = ApiId & typeof OPENCODE_GO_API;
export type OpenCodeGoFrozenAuthClass = AuthClass & typeof OPENCODE_GO_AUTH_CLASS;
export type OpenCodeGoFrozenBillingClass = BillingClass & typeof OPENCODE_GO_BILLING_CLASS;
