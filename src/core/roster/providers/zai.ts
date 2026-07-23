import {
  PHASE37_FIXTURE_CLOCK,
  PHASE37_PACKAGE_VERSION,
  PHASE37_PI_VERSION,
  ROSTER_ROLE_ORDER,
  canonicalSha256,
  findRoutePolicy,
  type Digest,
  type QualificationState,
  type RosterRole,
} from '../route-policies.ts';
import {
  PROVIDER_RECIPES,
  SEED_CANDIDATES,
  SEED_ROSTERS,
  getProfileTemplate,
  getProviderRecipe,
  type EvidenceRef,
  type ProfileTemplate,
  type ProviderRecipe,
  type QualificationManifest,
  type RoleTemplate,
  type Roster,
  type RosterCandidate,
} from '../provider-recipes.ts';

function deepFreezeZaiAuthority<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return value;
  }
  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return value;
  }
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    deepFreezeZaiAuthority((objectValue as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(objectValue) as T;
}

export const ZAI_PROVIDER_ID = 'zai' as const;
export const ZAI_RECIPE_ID = 'zai-coding-plan' as const;
export const ZAI_RECIPE_REVISION = 1 as const;
export const ZAI_ROUTE_POLICY_ID = 'zai-coding-plan-v1' as const;
export const ZAI_ROUTE_POLICY_REVISION = 1 as const;
export const ZAI_MODEL_ID = 'glm-5.2' as const;
export const ZAI_MODEL = 'zai/glm-5.2' as const;
export const ZAI_API = 'openai-completions' as const;
export const ZAI_THINKING = 'high' as const;
export const ZAI_SERVICE_TIER = null;
export const ZAI_CACHE_POLICY = 'provider-default' as const;
export const ZAI_SYSTEM_PROMPT_PROFILE = 'pi-default.v1' as const;
export const ZAI_TEMPLATE_CONTEXT_WINDOW = 256000 as const;
export const ZAI_TEMPLATE_MAX_OUTPUT_TOKENS = 32768 as const;
export const ZAI_MODEL_CONTEXT_WINDOW = 1000000 as const;
export const ZAI_MODEL_MAX_TOKENS = 131072 as const;
export const ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4' as const;
export const ZAI_CHAT_COMPLETIONS_ENDPOINT = 'https://api.z.ai/api/coding/paas/v4/chat/completions' as const;
export const ZAI_AUTH_CLASS = 'api-key-plan-token' as const;
export const ZAI_TOKEN_AUTHORITY = 'zai-coding-plan-token' as const;
export const ZAI_BILLING_CLASS = 'plan-token' as const;
export const ZAI_BILLING_ROUTE_CLASS = 'plan-api-token' as const;
export const ZAI_ENV_KEY = 'ZAI_API_KEY' as const;

export const ZAI_OPENAI_COMPLETIONS_COMPATIBILITY = deepFreezeZaiAuthority({
  provider_id: ZAI_PROVIDER_ID,
  api: ZAI_API,
  base_url: ZAI_BASE_URL,
  chat_completions_endpoint: ZAI_CHAT_COMPLETIONS_ENDPOINT,
  request: {
    model_id: ZAI_MODEL_ID,
    stream: true,
    thinking_format: 'zai',
    thinking_parameter: { type: 'enabled', clear_thinking: false },
    reasoning_effort_parameter: ZAI_THINKING,
    supports_reasoning_effort: true,
    supports_developer_role: false,
    supports_store: false,
  },
  context: {
    template_context_window: ZAI_TEMPLATE_CONTEXT_WINDOW,
    template_max_output_tokens: ZAI_TEMPLATE_MAX_OUTPUT_TOKENS,
    model_context_window: ZAI_MODEL_CONTEXT_WINDOW,
    model_max_tokens: ZAI_MODEL_MAX_TOKENS,
    input_modalities: ['text'],
    output_modalities: ['text'],
  },
  cache: {
    cache_policy: ZAI_CACHE_POLICY,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    store: null,
  },
  tools: {
    tool_capability: 'tool-use-supported',
    zai_tool_stream: true,
  },
} as const);

const EXPECTED_ZAI_ROLE_TEMPLATE = deepFreezeZaiAuthority({
  model_id: ZAI_MODEL_ID,
  api: ZAI_API,
  thinking: ZAI_THINKING,
  service_tier: ZAI_SERVICE_TIER,
  cache_policy: ZAI_CACHE_POLICY,
  system_prompt_profile: ZAI_SYSTEM_PROMPT_PROFILE,
  context_window: ZAI_TEMPLATE_CONTEXT_WINDOW,
  max_output_tokens: ZAI_TEMPLATE_MAX_OUTPUT_TOKENS,
  input_modalities: ['text'],
  output_modalities: ['text'],
  reasoning_capability: 'reasoning-supported',
  tool_capability: 'tool-use-supported',
} satisfies Omit<RoleTemplate, 'role'>);

function mustProviderRecipe(): ProviderRecipe {
  const recipe = getProviderRecipe(ZAI_RECIPE_ID, ZAI_RECIPE_REVISION, PROVIDER_RECIPES);
  if (recipe === null) {
    throw new Error('Phase 37 ZAI provider pack requires the frozen zai-coding-plan recipe');
  }
  return recipe;
}

function mustProfileTemplate(recipe: ProviderRecipe): ProfileTemplate {
  const profile = getProfileTemplate(recipe, 'precision');
  if (profile === null) {
    throw new Error('Phase 37 ZAI provider pack requires the frozen precision profile template');
  }
  return profile;
}

function mustSeedCandidate(): RosterCandidate {
  const candidate = SEED_CANDIDATES.find(
    (entry) => entry.candidate_id === 'zai-precision-v1' && entry.recipe_id === ZAI_RECIPE_ID,
  );
  if (candidate === undefined) {
    throw new Error('Phase 37 ZAI provider pack requires the frozen zai-precision-v1 seed candidate');
  }
  return candidate;
}

function mustSeedRoster(candidate: RosterCandidate): Roster {
  const roster = SEED_ROSTERS.find(
    (entry) => entry.roster_id === candidate.roster_id && entry.roster_revision === candidate.roster_revision,
  );
  if (roster === undefined) {
    throw new Error('Phase 37 ZAI provider pack requires the frozen ZAI seed roster');
  }
  return roster;
}

function roleTemplateMatchesExpected(template: RoleTemplate): boolean {
  return (
    template.model_id === EXPECTED_ZAI_ROLE_TEMPLATE.model_id &&
    template.api === EXPECTED_ZAI_ROLE_TEMPLATE.api &&
    template.thinking === EXPECTED_ZAI_ROLE_TEMPLATE.thinking &&
    template.service_tier === EXPECTED_ZAI_ROLE_TEMPLATE.service_tier &&
    template.cache_policy === EXPECTED_ZAI_ROLE_TEMPLATE.cache_policy &&
    template.system_prompt_profile === EXPECTED_ZAI_ROLE_TEMPLATE.system_prompt_profile &&
    template.context_window === EXPECTED_ZAI_ROLE_TEMPLATE.context_window &&
    template.max_output_tokens === EXPECTED_ZAI_ROLE_TEMPLATE.max_output_tokens &&
    JSON.stringify(template.input_modalities) === JSON.stringify(EXPECTED_ZAI_ROLE_TEMPLATE.input_modalities) &&
    JSON.stringify(template.output_modalities) === JSON.stringify(EXPECTED_ZAI_ROLE_TEMPLATE.output_modalities) &&
    template.reasoning_capability === EXPECTED_ZAI_ROLE_TEMPLATE.reasoning_capability &&
    template.tool_capability === EXPECTED_ZAI_ROLE_TEMPLATE.tool_capability
  );
}

function assertFrozenZaiRecipeTemplate(recipe: ProviderRecipe, profile: ProfileTemplate): void {
  const routePolicy = findRoutePolicy(ZAI_ROUTE_POLICY_ID, ZAI_ROUTE_POLICY_REVISION);
  if (routePolicy === null) {
    throw new Error('Phase 37 ZAI provider pack requires the frozen zai-coding-plan route policy');
  }
  if (routePolicy.provider_id !== ZAI_PROVIDER_ID || routePolicy.billing_class !== ZAI_BILLING_CLASS) {
    throw new Error('Phase 37 ZAI route policy drifted from coding-plan token authority');
  }
  if (routePolicy.billing_route_class !== ZAI_BILLING_ROUTE_CLASS) {
    throw new Error('Phase 37 ZAI route policy drifted from plan-api-token route authority');
  }
  if (!routePolicy.allowed_auth_classes.includes(ZAI_AUTH_CLASS)) {
    throw new Error('Phase 37 ZAI route policy must require api-key-plan-token auth');
  }
  if (routePolicy.allowed_auth_classes.includes('api-key')) {
    throw new Error('Phase 37 ZAI route policy must not treat generic api-key auth as authority');
  }
  if (!routePolicy.forbidden_gateways.includes('openrouter') || !routePolicy.forbidden_gateways.includes('arbitrary-api-key')) {
    throw new Error('Phase 37 ZAI route policy must forbid OpenRouter and arbitrary API-key gateways');
  }
  if (
    recipe.provider_family !== ZAI_PROVIDER_ID ||
    recipe.route_policy_id !== ZAI_ROUTE_POLICY_ID ||
    recipe.route_policy_revision !== ZAI_ROUTE_POLICY_REVISION ||
    recipe.qualification_state !== 'unqualified-non-certifying-seed' ||
    recipe.non_certifying_seed !== true
  ) {
    throw new Error('Phase 37 ZAI recipe drifted from the W0 non-certifying coding-plan seed');
  }
  if (
    profile.profile_id !== 'precision' ||
    profile.selected_by_default !== false ||
    profile.route_policy_id !== ZAI_ROUTE_POLICY_ID ||
    profile.route_policy_revision !== ZAI_ROUTE_POLICY_REVISION
  ) {
    throw new Error('Phase 37 ZAI profile template drifted from the frozen precision template');
  }
  const actualRoles = profile.role_templates.map((template) => template.role);
  if (JSON.stringify(actualRoles) !== JSON.stringify(ROSTER_ROLE_ORDER)) {
    throw new Error('Phase 37 ZAI role templates must cover ROLE_ORDER exactly');
  }
  for (const template of profile.role_templates) {
    if (!roleTemplateMatchesExpected(template)) {
      throw new Error(`Phase 37 ZAI role ${template.role} drifted from glm-5.2/high all-role template`);
    }
  }
}

export const ZAI_PROVIDER_RECIPE: ProviderRecipe = mustProviderRecipe();
export const ZAI_PROFILE_TEMPLATE: ProfileTemplate = mustProfileTemplate(ZAI_PROVIDER_RECIPE);
assertFrozenZaiRecipeTemplate(ZAI_PROVIDER_RECIPE, ZAI_PROFILE_TEMPLATE);
export const ZAI_ROUTE_POLICY = findRoutePolicy(ZAI_ROUTE_POLICY_ID, ZAI_ROUTE_POLICY_REVISION);
if (ZAI_ROUTE_POLICY === null) {
  throw new Error('Phase 37 ZAI provider pack requires the frozen route policy');
}
export const ZAI_SEED_CANDIDATE: RosterCandidate = mustSeedCandidate();
export const ZAI_SEED_ROSTER: Roster = mustSeedRoster(ZAI_SEED_CANDIDATE);

export const ZAI_ALL_ROLE_TEMPLATES: readonly RoleTemplate[] = deepFreezeZaiAuthority(
  ROSTER_ROLE_ORDER.map((role) => ({ role, ...EXPECTED_ZAI_ROLE_TEMPLATE })),
);

export const ZAI_PROVIDER_PACK = deepFreezeZaiAuthority({
  schema_version: 'autopilot.roster_provider_pack.zai.v1',
  provider_id: ZAI_PROVIDER_ID,
  provider_name: 'Z.AI Coding Plan (Global)',
  recipe_id: ZAI_RECIPE_ID,
  recipe_revision: ZAI_RECIPE_REVISION,
  route_policy_id: ZAI_ROUTE_POLICY_ID,
  route_policy_revision: ZAI_ROUTE_POLICY_REVISION,
  model_id: ZAI_MODEL_ID,
  model: ZAI_MODEL,
  api: ZAI_API,
  thinking: ZAI_THINKING,
  auth_class: ZAI_AUTH_CLASS,
  auth_env_var: ZAI_ENV_KEY,
  plan_authority: ZAI_TOKEN_AUTHORITY,
  billing_class: ZAI_BILLING_CLASS,
  billing_route_class: ZAI_BILLING_ROUTE_CLASS,
  forbidden_gateways: ['arbitrary-api-key', 'metered-frontier', 'openrouter'],
  compatibility: ZAI_OPENAI_COMPLETIONS_COMPATIBILITY,
  role_templates: ZAI_ALL_ROLE_TEMPLATES,
  seed: {
    route_policy_sha256: ZAI_ROUTE_POLICY.route_policy_sha256,
    recipe_sha256: ZAI_PROVIDER_RECIPE.recipe_sha256,
    candidate_sha256: ZAI_SEED_CANDIDATE.candidate_sha256,
    roster_sha256: ZAI_SEED_ROSTER.roster_sha256,
    assignment_set_sha256: ZAI_SEED_ROSTER.assignment_set_sha256,
  },
  qualification_state: 'qualification-required',
  synthetic_fixtures_certify_provider: false,
  network_calls_permitted: false,
} as const);

export type ZaiQualificationEvidenceKind = 'synthetic-fixture' | 'live-observed';

export interface ZaiProcessIdentityEvidence {
  readonly session_id: string;
  readonly process_id: string;
  readonly run_id: string;
  readonly lease_id: string;
  readonly tool_call_id: string;
  readonly attempt_authority_id: string;
  readonly authenticated: boolean;
}

export interface ZaiRoleQualificationEvidence {
  readonly role: string;
  readonly child: ZaiProcessIdentityEvidence;
  readonly provider_id: string;
  readonly recipe_id: string;
  readonly recipe_revision: number;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly api: string;
  readonly base_url: string;
  readonly chat_completions_endpoint: string;
  readonly requested_model_id: string;
  readonly executed_model_id: string;
  readonly fallback_model_id: string | null;
  readonly thinking: string;
  readonly reasoning_effort: string;
  readonly thinking_format: string;
  readonly service_tier: string | null;
  readonly cache_policy: string;
  readonly prompt_cache_key: string | null;
  readonly prompt_cache_retention: string | null;
  readonly system_prompt_profile: string;
  readonly request_context_window: number;
  readonly request_max_output_tokens: number;
  readonly model_context_window: number;
  readonly model_max_tokens: number;
  readonly input_modalities: readonly string[];
  readonly output_modalities: readonly string[];
  readonly reasoning_capability: string;
  readonly tool_capability: string;
  readonly supports_store: boolean;
  readonly supports_developer_role: boolean;
  readonly supports_reasoning_effort: boolean;
  readonly zai_tool_stream: boolean;
  readonly tool_compatibility_observed: boolean;
  readonly auth_class: string;
  readonly auth_source: string;
  readonly plan_authority: string;
  readonly billing_class: string;
  readonly billing_route_class: string;
  readonly gateway_provider_id: string | null;
  readonly route_evidence_sha256: Digest | null;
  readonly billing_evidence_sha256: Digest | null;
  readonly prompt_evidence_sha256: Digest | null;
  readonly cache_evidence_sha256: Digest | null;
  readonly execution_evidence_sha256: Digest | null;
}

export interface ZaiQualificationEvidence {
  readonly schema_version: 'autopilot.zai_qualification_evidence.v1';
  readonly evidence_kind: ZaiQualificationEvidenceKind;
  readonly provider_id: string;
  readonly recipe_id: string;
  readonly recipe_revision: number;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly evaluator: ZaiProcessIdentityEvidence;
  readonly parent: ZaiProcessIdentityEvidence;
  readonly live_entitlement_observed: boolean;
  readonly live_billing_observed: boolean;
  readonly roles: readonly ZaiRoleQualificationEvidence[];
}

export type ZaiQualificationIssueCode =
  | 'ZAI_SYNTHETIC_NON_CERTIFYING'
  | 'ZAI_LIVE_ENTITLEMENT_REQUIRED'
  | 'ZAI_LIVE_BILLING_REQUIRED'
  | 'ZAI_MISSING_ROLE_EVIDENCE'
  | 'ZAI_DUPLICATE_ROLE_EVIDENCE'
  | 'ZAI_ROLE_ORDER_INVALID'
  | 'ZAI_SELF_CERTIFICATION_FORBIDDEN'
  | 'ZAI_INDEPENDENT_CHILD_REQUIRED'
  | 'ZAI_CHILD_AUTHENTICATION_REQUIRED'
  | 'ZAI_PROVIDER_ID_MISMATCH'
  | 'ZAI_RECIPE_MISMATCH'
  | 'ZAI_ROUTE_POLICY_MISMATCH'
  | 'ZAI_ENDPOINT_MISMATCH'
  | 'ZAI_REQUEST_COMPATIBILITY_MISMATCH'
  | 'ZAI_MODEL_MISMATCH'
  | 'ZAI_FALLBACK_FORBIDDEN'
  | 'ZAI_THINKING_MISMATCH'
  | 'ZAI_CONTEXT_MISMATCH'
  | 'ZAI_CACHE_POLICY_MISMATCH'
  | 'ZAI_TOOL_COMPATIBILITY_MISMATCH'
  | 'ZAI_AUTHORITY_MISMATCH'
  | 'ZAI_FORBIDDEN_GATEWAY'
  | 'ZAI_ROLE_SPECIFIC_EVIDENCE_REQUIRED';

export interface ZaiQualificationIssue {
  readonly code: ZaiQualificationIssueCode;
  readonly role: RosterRole | null;
  readonly detail: string;
}

export interface ZaiQualificationEvaluation {
  readonly provider_id: typeof ZAI_PROVIDER_ID;
  readonly recipe_id: typeof ZAI_RECIPE_ID;
  readonly ready: boolean;
  readonly qualification_state: Extract<QualificationState, 'qualification-required' | 'w4-certified-ready'>;
  readonly issues: readonly ZaiQualificationIssue[];
  readonly network_calls: 0;
}

const REQUIRED_ROLE_EVIDENCE_FIELDS = [
  'route_evidence_sha256',
  'billing_evidence_sha256',
  'prompt_evidence_sha256',
  'cache_evidence_sha256',
  'execution_evidence_sha256',
] as const;

function isRosterRole(value: string): value is RosterRole {
  return (ROSTER_ROLE_ORDER as readonly string[]).includes(value);
}

const ZAI_PROCESS_IDENTITY_FIELDS = [
  'session_id',
  'process_id',
  'run_id',
  'lease_id',
  'tool_call_id',
  'attempt_authority_id',
] as const satisfies readonly (keyof ZaiProcessIdentityEvidence)[];

function processIdentityFieldValue(
  identity: ZaiProcessIdentityEvidence,
  field: (typeof ZAI_PROCESS_IDENTITY_FIELDS)[number],
): string | null {
  const value = identity[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function reusedIdentityFields(left: ZaiProcessIdentityEvidence, right: ZaiProcessIdentityEvidence): readonly (typeof ZAI_PROCESS_IDENTITY_FIELDS)[number][] {
  return ZAI_PROCESS_IDENTITY_FIELDS.filter((field) => {
    const leftValue = processIdentityFieldValue(left, field);
    return leftValue !== null && leftValue === processIdentityFieldValue(right, field);
  });
}

function sameIdentity(left: ZaiProcessIdentityEvidence, right: ZaiProcessIdentityEvidence): boolean {
  return reusedIdentityFields(left, right).length > 0;
}

function missingIdentityFields(identity: ZaiProcessIdentityEvidence): readonly (typeof ZAI_PROCESS_IDENTITY_FIELDS)[number][] {
  return ZAI_PROCESS_IDENTITY_FIELDS.filter((field) => processIdentityFieldValue(identity, field) === null);
}

function isForbiddenGateway(value: string | null): boolean {
  return value === 'openrouter' || value === 'arbitrary-api-key' || value === 'metered-frontier';
}

function isSha256Digest(value: string | null): value is Digest {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function compareJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addIssue(
  issues: ZaiQualificationIssue[],
  code: ZaiQualificationIssueCode,
  role: RosterRole | null,
  detail: string,
): void {
  const key = `${code}:${role ?? '*'}:${detail}`;
  if (issues.some((issue) => `${issue.code}:${issue.role ?? '*'}:${issue.detail}` === key)) {
    return;
  }
  issues.push({ code, role, detail });
}

function validateTopLevelEvidence(input: ZaiQualificationEvidence, issues: ZaiQualificationIssue[]): void {
  if (input.evidence_kind !== 'live-observed') {
    addIssue(issues, 'ZAI_SYNTHETIC_NON_CERTIFYING', null, 'offline or synthetic evidence cannot certify ZAI readiness');
  }
  if (input.provider_id !== ZAI_PROVIDER_ID) {
    addIssue(issues, 'ZAI_PROVIDER_ID_MISMATCH', null, `provider_id must be ${ZAI_PROVIDER_ID}`);
  }
  if (input.recipe_id !== ZAI_RECIPE_ID || input.recipe_revision !== ZAI_RECIPE_REVISION) {
    addIssue(issues, 'ZAI_RECIPE_MISMATCH', null, `recipe must be ${ZAI_RECIPE_ID}@${ZAI_RECIPE_REVISION}`);
  }
  if (input.route_policy_id !== ZAI_ROUTE_POLICY_ID || input.route_policy_revision !== ZAI_ROUTE_POLICY_REVISION) {
    addIssue(issues, 'ZAI_ROUTE_POLICY_MISMATCH', null, `route must be ${ZAI_ROUTE_POLICY_ID}@${ZAI_ROUTE_POLICY_REVISION}`);
  }
  if (!input.live_entitlement_observed) {
    addIssue(issues, 'ZAI_LIVE_ENTITLEMENT_REQUIRED', null, 'live coding-plan entitlement was not observed');
  }
  if (!input.live_billing_observed) {
    addIssue(issues, 'ZAI_LIVE_BILLING_REQUIRED', null, 'live coding-plan billing route was not observed');
  }
}

function validateRoleIdentity(
  input: ZaiQualificationEvidence,
  roleEvidence: ZaiRoleQualificationEvidence,
  role: RosterRole,
  issues: ZaiQualificationIssue[],
): void {
  if (sameIdentity(roleEvidence.child, input.evaluator)) {
    addIssue(issues, 'ZAI_SELF_CERTIFICATION_FORBIDDEN', role, 'role evidence was produced by the evaluator process/session/lease/tool-call/run authority');
  }
  if (sameIdentity(roleEvidence.child, input.parent)) {
    addIssue(issues, 'ZAI_INDEPENDENT_CHILD_REQUIRED', role, 'role evidence must come from a child identity independent of the parent');
  }
  if (roleEvidence.child.authenticated !== true) {
    addIssue(issues, 'ZAI_CHILD_AUTHENTICATION_REQUIRED', role, 'role witness child identity must be authenticated by live child evidence');
  }
  const missingFields = missingIdentityFields(roleEvidence.child);
  if (missingFields.length > 0) {
    addIssue(issues, 'ZAI_INDEPENDENT_CHILD_REQUIRED', role, `role evidence is missing child identity fields: ${missingFields.join(', ')}`);
  }
}

function validateRoleIndependenceAcrossRoles(
  roles: readonly ZaiRoleQualificationEvidence[],
  issues: ZaiQualificationIssue[],
): void {
  const seen = new Map<string, RosterRole>();
  for (const roleEvidence of roles) {
    if (!isRosterRole(roleEvidence.role)) continue;
    for (const field of ZAI_PROCESS_IDENTITY_FIELDS) {
      const value = processIdentityFieldValue(roleEvidence.child, field);
      if (value === null) continue;
      const key = `${field}\0${value}`;
      const firstRole = seen.get(key);
      if (firstRole !== undefined) {
        addIssue(
          issues,
          'ZAI_INDEPENDENT_CHILD_REQUIRED',
          roleEvidence.role,
          `role witness child ${field} reuses ${firstRole} authority`,
        );
      } else {
        seen.set(key, roleEvidence.role);
      }
    }
  }
}

function validateRoleRoute(roleEvidence: ZaiRoleQualificationEvidence, role: RosterRole, issues: ZaiQualificationIssue[]): void {
  if (roleEvidence.provider_id !== ZAI_PROVIDER_ID) {
    addIssue(issues, 'ZAI_PROVIDER_ID_MISMATCH', role, `provider_id must be ${ZAI_PROVIDER_ID}`);
  }
  if (roleEvidence.recipe_id !== ZAI_RECIPE_ID || roleEvidence.recipe_revision !== ZAI_RECIPE_REVISION) {
    addIssue(issues, 'ZAI_RECIPE_MISMATCH', role, `recipe must be ${ZAI_RECIPE_ID}@${ZAI_RECIPE_REVISION}`);
  }
  if (roleEvidence.route_policy_id !== ZAI_ROUTE_POLICY_ID || roleEvidence.route_policy_revision !== ZAI_ROUTE_POLICY_REVISION) {
    addIssue(issues, 'ZAI_ROUTE_POLICY_MISMATCH', role, `route must be ${ZAI_ROUTE_POLICY_ID}@${ZAI_ROUTE_POLICY_REVISION}`);
  }
  if (roleEvidence.api !== ZAI_API) {
    addIssue(issues, 'ZAI_REQUEST_COMPATIBILITY_MISMATCH', role, `api must be ${ZAI_API}`);
  }
  if (roleEvidence.base_url !== ZAI_BASE_URL || roleEvidence.chat_completions_endpoint !== ZAI_CHAT_COMPLETIONS_ENDPOINT) {
    addIssue(issues, 'ZAI_ENDPOINT_MISMATCH', role, 'ZAI coding-plan traffic must use the frozen Z.AI OpenAI-completions endpoint');
  }
  if (isForbiddenGateway(roleEvidence.gateway_provider_id)) {
    addIssue(issues, 'ZAI_FORBIDDEN_GATEWAY', role, 'OpenRouter, arbitrary API-key, and metered-frontier gateways are forbidden');
  }
}

function validateRoleRequest(roleEvidence: ZaiRoleQualificationEvidence, role: RosterRole, issues: ZaiQualificationIssue[]): void {
  if (roleEvidence.requested_model_id !== ZAI_MODEL_ID || roleEvidence.executed_model_id !== ZAI_MODEL_ID) {
    addIssue(issues, 'ZAI_MODEL_MISMATCH', role, `requested and executed model must both be ${ZAI_MODEL_ID}`);
  }
  if (roleEvidence.requested_model_id !== roleEvidence.executed_model_id || roleEvidence.fallback_model_id !== null) {
    addIssue(issues, 'ZAI_FALLBACK_FORBIDDEN', role, 'fallback or executed-model substitution is forbidden');
  }
  if (
    roleEvidence.thinking !== ZAI_THINKING ||
    roleEvidence.reasoning_effort !== ZAI_THINKING ||
    roleEvidence.thinking_format !== 'zai' ||
    roleEvidence.supports_reasoning_effort !== true
  ) {
    addIssue(issues, 'ZAI_THINKING_MISMATCH', role, 'ZAI GLM-5.2 must run high thinking through the ZAI reasoning format');
  }
  if (roleEvidence.service_tier !== ZAI_SERVICE_TIER || roleEvidence.system_prompt_profile !== ZAI_SYSTEM_PROMPT_PROFILE) {
    addIssue(issues, 'ZAI_REQUEST_COMPATIBILITY_MISMATCH', role, 'service tier and prompt profile must match the frozen request template');
  }
  if (roleEvidence.supports_developer_role !== false || roleEvidence.supports_store !== false) {
    addIssue(issues, 'ZAI_REQUEST_COMPATIBILITY_MISMATCH', role, 'ZAI OpenAI-completions compatibility must not claim store or developer-role support');
  }
}

function validateRoleContext(roleEvidence: ZaiRoleQualificationEvidence, role: RosterRole, issues: ZaiQualificationIssue[]): void {
  if (
    roleEvidence.request_context_window !== ZAI_TEMPLATE_CONTEXT_WINDOW ||
    roleEvidence.request_max_output_tokens !== ZAI_TEMPLATE_MAX_OUTPUT_TOKENS ||
    roleEvidence.model_context_window !== ZAI_MODEL_CONTEXT_WINDOW ||
    roleEvidence.model_max_tokens !== ZAI_MODEL_MAX_TOKENS ||
    !compareJson(roleEvidence.input_modalities, ['text']) ||
    !compareJson(roleEvidence.output_modalities, ['text']) ||
    roleEvidence.reasoning_capability !== 'reasoning-supported'
  ) {
    addIssue(issues, 'ZAI_CONTEXT_MISMATCH', role, 'context, token, modality, and reasoning facts must match the ZAI pack');
  }
}

function validateRoleCacheAndTools(roleEvidence: ZaiRoleQualificationEvidence, role: RosterRole, issues: ZaiQualificationIssue[]): void {
  if (
    roleEvidence.cache_policy !== ZAI_CACHE_POLICY ||
    roleEvidence.prompt_cache_key !== null ||
    roleEvidence.prompt_cache_retention !== null
  ) {
    addIssue(issues, 'ZAI_CACHE_POLICY_MISMATCH', role, 'cache authority must remain provider-default with no OpenAI prompt-cache fallback');
  }
  if (
    roleEvidence.tool_capability !== 'tool-use-supported' ||
    roleEvidence.zai_tool_stream !== true ||
    roleEvidence.tool_compatibility_observed !== true
  ) {
    addIssue(issues, 'ZAI_TOOL_COMPATIBILITY_MISMATCH', role, 'tool support must prove ZAI tool_stream compatibility');
  }
}

function validateRoleAuth(roleEvidence: ZaiRoleQualificationEvidence, role: RosterRole, issues: ZaiQualificationIssue[]): void {
  if (
    roleEvidence.auth_class !== ZAI_AUTH_CLASS ||
    (roleEvidence.auth_source !== 'stored' && roleEvidence.auth_source !== 'runtime') ||
    roleEvidence.plan_authority !== ZAI_TOKEN_AUTHORITY ||
    roleEvidence.billing_class !== ZAI_BILLING_CLASS ||
    roleEvidence.billing_route_class !== ZAI_BILLING_ROUTE_CLASS
  ) {
    addIssue(issues, 'ZAI_AUTHORITY_MISMATCH', role, 'ZAI token shape is coding-plan authority, not generic API-key or environment authority');
  }
}

function validateRoleSpecificEvidence(roleEvidence: ZaiRoleQualificationEvidence, role: RosterRole, issues: ZaiQualificationIssue[]): void {
  for (const field of REQUIRED_ROLE_EVIDENCE_FIELDS) {
    if (!isSha256Digest(roleEvidence[field])) {
      addIssue(issues, 'ZAI_ROLE_SPECIFIC_EVIDENCE_REQUIRED', role, `missing ${field}`);
    }
  }
}

function validateRoleEvidence(
  input: ZaiQualificationEvidence,
  roleEvidence: ZaiRoleQualificationEvidence,
  role: RosterRole,
  issues: ZaiQualificationIssue[],
): void {
  validateRoleIdentity(input, roleEvidence, role, issues);
  validateRoleRoute(roleEvidence, role, issues);
  validateRoleRequest(roleEvidence, role, issues);
  validateRoleContext(roleEvidence, role, issues);
  validateRoleCacheAndTools(roleEvidence, role, issues);
  validateRoleAuth(roleEvidence, role, issues);
  validateRoleSpecificEvidence(roleEvidence, role, issues);
}

export function evaluateZaiQualificationEvidence(input: ZaiQualificationEvidence): ZaiQualificationEvaluation {
  const issues: ZaiQualificationIssue[] = [];
  validateTopLevelEvidence(input, issues);

  const byRole = new Map<RosterRole, ZaiRoleQualificationEvidence>();
  for (const roleEvidence of input.roles) {
    if (!isRosterRole(roleEvidence.role)) {
      addIssue(issues, 'ZAI_ROLE_ORDER_INVALID', null, `unknown role ${roleEvidence.role}`);
      continue;
    }
    if (byRole.has(roleEvidence.role)) {
      addIssue(issues, 'ZAI_DUPLICATE_ROLE_EVIDENCE', roleEvidence.role, 'duplicate role evidence is forbidden');
      continue;
    }
    byRole.set(roleEvidence.role, roleEvidence);
  }

  const observedRoles = input.roles.map((roleEvidence) => roleEvidence.role);
  if (JSON.stringify(observedRoles) !== JSON.stringify(ROSTER_ROLE_ORDER)) {
    addIssue(issues, 'ZAI_ROLE_ORDER_INVALID', null, 'role evidence must be exactly ROLE_ORDER with no fallback role ordering');
  }

  validateRoleIndependenceAcrossRoles([...byRole.values()], issues);

  for (const role of ROSTER_ROLE_ORDER) {
    const roleEvidence = byRole.get(role);
    if (roleEvidence === undefined) {
      addIssue(issues, 'ZAI_MISSING_ROLE_EVIDENCE', role, 'complete role-specific evidence is required');
      continue;
    }
    validateRoleEvidence(input, roleEvidence, role, issues);
  }

  const ready = issues.length === 0 && input.evidence_kind === 'live-observed';
  return deepFreezeZaiAuthority({
    provider_id: ZAI_PROVIDER_ID,
    recipe_id: ZAI_RECIPE_ID,
    ready,
    qualification_state: ready ? 'w4-certified-ready' : 'qualification-required',
    issues,
    network_calls: 0 as const,
  });
}

function evidenceKindForId(evidenceId: string): EvidenceRef['kind'] {
  if (evidenceId.endsWith('-billing-proof')) return 'billing-proof';
  if (evidenceId.endsWith('-cache-proof')) return 'cache-proof';
  if (evidenceId.endsWith('-prompt-proof')) return 'prompt-proof';
  if (evidenceId.endsWith('-route-proof')) return 'route-proof';
  return 'execution-proof';
}

function requiredEvidenceRef(role: RosterRole, suffix: string): EvidenceRef {
  const evidence_id = `zai-${role}-${suffix}`;
  return {
    evidence_id,
    kind: evidenceKindForId(evidence_id),
    uri: `qualification-required://phase37/zai/${role}/${suffix}`,
    sha256: null,
    byte_count: null,
    secret_free: true,
  };
}

export function requiredZaiEvidenceRefsForRole(role: RosterRole): readonly EvidenceRef[] {
  return deepFreezeZaiAuthority([
    requiredEvidenceRef(role, 'billing-proof'),
    requiredEvidenceRef(role, 'cache-proof'),
    requiredEvidenceRef(role, 'execution-proof'),
    requiredEvidenceRef(role, 'prompt-proof'),
    requiredEvidenceRef(role, 'route-proof'),
  ].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)));
}

export const ZAI_REQUIRED_EVIDENCE_REFS: readonly EvidenceRef[] = deepFreezeZaiAuthority(
  ROSTER_ROLE_ORDER.flatMap((role) => [...requiredZaiEvidenceRefsForRole(role)])
    .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
);

function roleEvidenceByRole(input: ZaiQualificationEvidence, role: RosterRole): ZaiRoleQualificationEvidence | null {
  return input.roles.find((entry) => entry.role === role) ?? null;
}

function liveEvidenceRefsForRole(input: ZaiQualificationEvidence, role: RosterRole): readonly EvidenceRef[] {
  const roleEvidence = roleEvidenceByRole(input, role);
  if (roleEvidence === null) return requiredZaiEvidenceRefsForRole(role);
  const refs: EvidenceRef[] = [
    {
      evidence_id: `zai-${role}-billing-proof`,
      kind: 'billing-proof',
      uri: `evidence://phase37/zai/${role}/billing`,
      sha256: roleEvidence.billing_evidence_sha256,
      byte_count: null,
      secret_free: true,
    },
    {
      evidence_id: `zai-${role}-cache-proof`,
      kind: 'cache-proof',
      uri: `evidence://phase37/zai/${role}/cache`,
      sha256: roleEvidence.cache_evidence_sha256,
      byte_count: null,
      secret_free: true,
    },
    {
      evidence_id: `zai-${role}-execution-proof`,
      kind: 'execution-proof',
      uri: `evidence://phase37/zai/${role}/execution`,
      sha256: roleEvidence.execution_evidence_sha256,
      byte_count: null,
      secret_free: true,
    },
    {
      evidence_id: `zai-${role}-prompt-proof`,
      kind: 'prompt-proof',
      uri: `evidence://phase37/zai/${role}/prompt`,
      sha256: roleEvidence.prompt_evidence_sha256,
      byte_count: null,
      secret_free: true,
    },
    {
      evidence_id: `zai-${role}-route-proof`,
      kind: 'route-proof',
      uri: `evidence://phase37/zai/${role}/route`,
      sha256: roleEvidence.route_evidence_sha256,
      byte_count: null,
      secret_free: true,
    },
  ];
  return deepFreezeZaiAuthority(refs.sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)));
}

export function buildZaiQualificationManifestCandidate(
  input: ZaiQualificationEvidence,
  options: {
    readonly issued_at?: string;
    readonly expires_at?: string;
  } = {},
): QualificationManifest {
  const evaluation = evaluateZaiQualificationEvidence(input);
  const live_evidence = evaluation.ready
    ? ROSTER_ROLE_ORDER.flatMap((role) => [...liveEvidenceRefsForRole(input, role)])
      .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id))
    : [];
  const withoutHash = {
    schema_version: 'autopilot.certification_manifest.v1' as const,
    manifest_id: 'zai-coding-plan-w4-qualification',
    manifest_revision: 1,
    subject_kind: 'provider_recipe' as const,
    subject_id: ZAI_RECIPE_ID,
    subject_sha256: ZAI_PROVIDER_RECIPE.recipe_sha256,
    package_version: PHASE37_PACKAGE_VERSION,
    pi_version: PHASE37_PI_VERSION,
    qualification_state: evaluation.qualification_state,
    role_results: ROSTER_ROLE_ORDER.map((role) => {
      const roleHasIssue = evaluation.issues.some((issue) => issue.role === role || issue.role === null);
      return {
        role,
        state: evaluation.ready && !roleHasIssue ? 'pass' as const : 'fail' as const,
        evidence_refs: evaluation.ready && !roleHasIssue ? liveEvidenceRefsForRole(input, role) : requiredZaiEvidenceRefsForRole(role),
      };
    }),
    required_evidence: ZAI_REQUIRED_EVIDENCE_REFS,
    live_evidence,
    issued_at: options.issued_at ?? PHASE37_FIXTURE_CLOCK,
    expires_at: options.expires_at ?? '2026-07-23T12:00:00.000Z',
  } satisfies Omit<QualificationManifest, 'manifest_sha256'>;
  return deepFreezeZaiAuthority({ ...withoutHash, manifest_sha256: canonicalSha256(withoutHash) });
}
