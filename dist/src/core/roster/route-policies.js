import { createHash } from 'node:crypto';
function deepFreezeRouteAuthority(value, seen = new WeakSet()) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        return value;
    }
    const objectValue = value;
    if (seen.has(objectValue)) {
        return value;
    }
    seen.add(objectValue);
    for (const key of Reflect.ownKeys(objectValue)) {
        deepFreezeRouteAuthority(objectValue[key], seen);
    }
    return Object.freeze(objectValue);
}
export const PHASE37_FREEZE_ID = 'phase37-roster-w0-2026-07-22';
export const PHASE37_PACKAGE_VERSION = '1.3.0';
export const PHASE37_PI_VERSION = '0.80.6';
export const PHASE37_W0_SEED_CREATED_AT = '2026-07-22T00:00:00.000Z';
export const PHASE37_FIXTURE_CLOCK = '2026-07-22T12:00:00.000Z';
export const ROSTER_ROLE_ORDER = deepFreezeRouteAuthority([
    'parent',
    'strategy',
    'implement',
    'validate',
    'fix',
    'adjudicate',
    'bughunt',
    'extract',
]);
export const ROSTER_CHILD_ROLE_ORDER = deepFreezeRouteAuthority([
    'strategy',
    'implement',
    'validate',
    'fix',
    'adjudicate',
    'bughunt',
    'extract',
]);
export const ROSTER_PROFILES = deepFreezeRouteAuthority([
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
]);
export const ROSTER_RECOMMENDED_PROFILE_ID = 'cruise';
export const ROSTER_DIAGNOSTIC_CODES = deepFreezeRouteAuthority([
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
]);
function severityForDiagnosticCode(code) {
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
export const ROSTER_DIAGNOSTICS = deepFreezeRouteAuthority(Object.fromEntries(ROSTER_DIAGNOSTIC_CODES.map((code) => [
    code,
    Object.freeze({
        code,
        severity: severityForDiagnosticCode(code),
        message: `${code} fixture diagnostic`,
        remediation: 'Follow the Phase 37 W0 roster contract freeze.',
        secret_free: true,
    }),
])));
export function rosterDiagnostic(code) {
    const diagnostic = ROSTER_DIAGNOSTICS[code];
    return { ...diagnostic };
}
export function sortDiagnostics(diagnostics) {
    return [...diagnostics].sort((left, right) => left.code.localeCompare(right.code));
}
export function dedupeDiagnostics(diagnostics) {
    const byCode = new Map();
    for (const diagnostic of diagnostics) {
        const materialized = typeof diagnostic === 'string' ? rosterDiagnostic(diagnostic) : diagnostic;
        byCode.set(materialized.code, { ...materialized, secret_free: true });
    }
    return sortDiagnostics([...byCode.values()]);
}
export function roleSortIndex(role) {
    return ROSTER_ROLE_ORDER.indexOf(role);
}
export function isRosterRole(value) {
    return ROSTER_ROLE_ORDER.includes(value);
}
export function isRosterProfileId(value) {
    return ROSTER_PROFILES.some((profile) => profile.profile_id === value);
}
export function canonicalJson(value) {
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
                const array = value;
                const encoded = [];
                for (let index = 0; index < array.length; index += 1) {
                    if (!(index in array)) {
                        throw new Error('canonical JSON rejects sparse arrays');
                    }
                    encoded.push(canonicalJson(array[index]));
                }
                return `[${encoded.join(',')}]`;
            }
            return canonicalJsonObject(value);
        case 'undefined':
            throw new Error('canonical JSON rejects undefined values');
        default:
            throw new Error(`canonical JSON rejects ${typeof value} values`);
    }
}
function canonicalJsonObject(value) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('canonical JSON accepts only plain objects');
    }
    const members = [];
    for (const key of Object.keys(value).sort()) {
        const member = value[key];
        if (member === undefined) {
            throw new Error(`canonical JSON rejects undefined object member ${key}`);
        }
        members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
    }
    return `{${members.join(',')}}`;
}
export function canonicalJsonWithLf(value) {
    return `${canonicalJson(value)}\n`;
}
export function sha256Digest(bytes) {
    return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}
export function canonicalSha256(value) {
    return sha256Digest(canonicalJsonWithLf(value));
}
function ownStringKeys(value) {
    return Object.keys(value);
}
export function hashObjectOmitting(value, hashField) {
    const withoutHash = {};
    for (const key of ownStringKeys(value)) {
        if (key !== hashField) {
            withoutHash[key] = value[key];
        }
    }
    return canonicalSha256(withoutHash);
}
export function assertNoSecretFields(value, path = '$') {
    if (value === null || typeof value !== 'object') {
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertNoSecretFields(entry, `${path}[${index}]`));
        return;
    }
    for (const [key, nested] of Object.entries(value)) {
        if (/secret|credential|token|api[_-]?key|password/i.test(key) && key !== 'secret_free' && key !== 'secret_fields_present') {
            throw new Error(`secret-bearing field ${path}.${key} is forbidden`);
        }
        assertNoSecretFields(nested, `${path}.${key}`);
    }
}
const ROUTE_POLICIES_JSON = '[{"schema_version":"autopilot.route_policy.v1","route_policy_id":"anthropic-sanitized-v1","revision":1,"provider_id":"anthropic","allowed_auth_classes":["api-key"],"allowed_auth_sources":["runtime","stored"],"billing_class":"metered-third-party-blocked","billing_route_class":"third-party-metered-blocked","allowed_apis":["anthropic-messages"],"allowed_service_tiers":[null],"allowed_cache_policies":["provider-default"],"allowed_system_prompt_profiles":["anthropic-autopilot-sanitized.v1"],"forbidden_gateways":["arbitrary-api-key","metered-frontier","openrouter"],"requires_live_billing_proof":true,"policy_state":"blocked-live-certification","qualification_state":"blocked-live-certification","non_certifying_seed":true,"route_policy_sha256":"sha256:dfe744bad274907e700d18357e70ec15a239c26e6b115a450aead641d195860b"},{"schema_version":"autopilot.route_policy.v1","route_policy_id":"codex-subscription-v1","revision":1,"provider_id":"openai-codex","allowed_auth_classes":["oauth"],"allowed_auth_sources":["runtime","stored"],"billing_class":"plan-backed-subscription","billing_route_class":"subscription-oauth","allowed_apis":["openai-codex-responses"],"allowed_service_tiers":[null,"priority"],"allowed_cache_policies":["provider-default"],"allowed_system_prompt_profiles":["pi-default.v1"],"forbidden_gateways":["arbitrary-api-key","metered-frontier","openrouter"],"requires_live_billing_proof":true,"policy_state":"unqualified-seed","qualification_state":"unqualified-non-certifying-seed","non_certifying_seed":true,"route_policy_sha256":"sha256:1a23f607a9fce47701ee5e7576205d29c7cb8451bc9186190ea4e9e550e60ccc"},{"schema_version":"autopilot.route_policy.v1","route_policy_id":"kimi-coding-plan-v1","revision":1,"provider_id":"kimi-coding","allowed_auth_classes":["api-key-plan-token"],"allowed_auth_sources":["runtime","stored"],"billing_class":"plan-token","billing_route_class":"plan-api-token","allowed_apis":["openai-completions"],"allowed_service_tiers":[null],"allowed_cache_policies":["provider-default"],"allowed_system_prompt_profiles":["pi-default.v1"],"forbidden_gateways":["arbitrary-api-key","metered-frontier","openrouter"],"requires_live_billing_proof":true,"policy_state":"unqualified-seed","qualification_state":"unqualified-non-certifying-seed","non_certifying_seed":true,"route_policy_sha256":"sha256:0925d0371e2f7f5ffae54e02ee9cf5c6d106dd5b47d7ec4698b68f754272d688"},{"schema_version":"autopilot.route_policy.v1","route_policy_id":"opencode-go-plan-v1","revision":1,"provider_id":"opencode-go","allowed_auth_classes":["api-key-plan-token"],"allowed_auth_sources":["runtime","stored"],"billing_class":"plan-token","billing_route_class":"plan-api-token","allowed_apis":["openai-completions"],"allowed_service_tiers":[null],"allowed_cache_policies":["provider-default"],"allowed_system_prompt_profiles":["pi-default.v1"],"forbidden_gateways":["arbitrary-api-key","metered-frontier","openrouter"],"requires_live_billing_proof":true,"policy_state":"unqualified-seed","qualification_state":"unqualified-non-certifying-seed","non_certifying_seed":true,"route_policy_sha256":"sha256:1fb2706f2e6c7192134f788a829fc199b3f5905cf45b77c7dbd511457d9350f5"},{"schema_version":"autopilot.route_policy.v1","route_policy_id":"zai-coding-plan-v1","revision":1,"provider_id":"zai","allowed_auth_classes":["api-key-plan-token"],"allowed_auth_sources":["runtime","stored"],"billing_class":"plan-token","billing_route_class":"plan-api-token","allowed_apis":["openai-completions"],"allowed_service_tiers":[null],"allowed_cache_policies":["provider-default"],"allowed_system_prompt_profiles":["pi-default.v1"],"forbidden_gateways":["arbitrary-api-key","metered-frontier","openrouter"],"requires_live_billing_proof":true,"policy_state":"unqualified-seed","qualification_state":"unqualified-non-certifying-seed","non_certifying_seed":true,"route_policy_sha256":"sha256:f59565fcef0baadf95010064cb8a4fde9423f2089a88076fe615859d15c6df54"}]';
const ANTHROPIC_OPUS5_SONNET5_SUBSCRIPTION_ROUTE_POLICY_PREIMAGE = {
    schema_version: 'autopilot.route_policy.v1',
    route_policy_id: 'anthropic-opus5-sonnet5-subscription-v1',
    revision: 1,
    provider_id: 'anthropic',
    allowed_auth_classes: ['oauth'],
    allowed_auth_sources: ['runtime', 'stored'],
    billing_class: 'plan-backed-subscription',
    billing_route_class: 'subscription-oauth',
    allowed_apis: ['anthropic-messages'],
    allowed_service_tiers: [null],
    allowed_cache_policies: ['provider-default'],
    allowed_system_prompt_profiles: ['anthropic-autopilot-sanitized.v1'],
    forbidden_gateways: ['arbitrary-api-key', 'metered-frontier', 'openrouter'],
    requires_live_billing_proof: true,
    policy_state: 'unqualified-seed',
    qualification_state: 'unqualified-non-certifying-seed',
    non_certifying_seed: true,
};
export const ANTHROPIC_OPUS5_SONNET5_SUBSCRIPTION_ROUTE_POLICY = deepFreezeRouteAuthority({
    ...ANTHROPIC_OPUS5_SONNET5_SUBSCRIPTION_ROUTE_POLICY_PREIMAGE,
    route_policy_sha256: canonicalSha256(ANTHROPIC_OPUS5_SONNET5_SUBSCRIPTION_ROUTE_POLICY_PREIMAGE),
});
export const ROUTE_POLICIES = deepFreezeRouteAuthority(sortRoutePolicies([
    ...JSON.parse(ROUTE_POLICIES_JSON),
    ANTHROPIC_OPUS5_SONNET5_SUBSCRIPTION_ROUTE_POLICY,
]));
export function routePolicySortKey(policy) {
    return `${policy.route_policy_id}:${String(policy.revision).padStart(10, '0')}`;
}
export function sortRoutePolicies(policies) {
    return [...policies].sort((left, right) => routePolicySortKey(left).localeCompare(routePolicySortKey(right)));
}
export function computeRoutePolicyRegistry(policies = ROUTE_POLICIES) {
    const route_policies = sortRoutePolicies(policies).map((policy) => ({
        route_policy_id: policy.route_policy_id,
        revision: policy.revision,
        route_policy_sha256: policy.route_policy_sha256,
    }));
    const preimage = {
        schema_version: 'autopilot.route_policy_registry.v1',
        freeze_id: PHASE37_FREEZE_ID,
        route_policies,
    };
    return {
        ...preimage,
        route_policy_registry_sha256: canonicalSha256(preimage),
    };
}
export const ROUTE_POLICY_REGISTRY = deepFreezeRouteAuthority(computeRoutePolicyRegistry());
export const ROUTE_POLICY_REGISTRY_SHA256 = ROUTE_POLICY_REGISTRY.route_policy_registry_sha256;
export function findRoutePolicy(routePolicyId, revision, policies = ROUTE_POLICIES) {
    return policies.find((policy) => policy.route_policy_id === routePolicyId && policy.revision === revision) ?? null;
}
export function findRoutePolicyForProviderApi(providerId, api, policies = ROUTE_POLICIES, authClass, authSource) {
    const matches = policies.filter((policy) => policy.provider_id === providerId && policy.allowed_apis.includes(api));
    if (matches.length === 0) {
        return null;
    }
    const authMatches = authClass === undefined
        ? matches
        : matches.filter((policy) => policy.allowed_auth_classes.includes(authClass) &&
            (authSource === undefined || policy.allowed_auth_sources.includes(authSource)));
    const eligible = authMatches.length > 0 ? authMatches : matches;
    const current = eligible.filter((policy) => policy.policy_state !== 'blocked-live-certification');
    return sortRoutePolicies(current.length > 0 ? current : eligible)[0] ?? null;
}
export function verifyRoutePolicySeeds(policies = ROUTE_POLICIES) {
    const issues = [];
    const seen = new Set();
    for (const policy of sortRoutePolicies(policies)) {
        const identity = `${policy.route_policy_id}@${policy.revision}`;
        if (seen.has(identity)) {
            issues.push(`duplicate route policy ${identity}`);
        }
        seen.add(identity);
        const expected = hashObjectOmitting(policy, 'route_policy_sha256');
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
export function authClassForRoute(provider) {
    if (!provider.auth_configured) {
        return 'none';
    }
    return provider.auth_class ?? 'unknown';
}
export function authSourceForRoute(provider) {
    if (!provider.auth_configured) {
        return 'not-configured';
    }
    return provider.auth_source ?? 'unknown';
}
export function isForbiddenGatewayProvider(providerId) {
    return providerId === 'openrouter' || providerId === 'metered-frontier' || providerId === 'arbitrary-api-key';
}
function isAuthRequired(authClass, authSource) {
    return authClass === 'none' || authClass === 'unknown' || authSource === 'not-configured' || authSource === 'unknown';
}
export function resolveRoute(request, policies = ROUTE_POLICIES) {
    const diagnostics = [];
    let matchedPolicy = null;
    if (!request.project_trusted) {
        diagnostics.push('ROSTER_PROJECT_UNTRUSTED');
    }
    if (isForbiddenGatewayProvider(request.provider_id)) {
        diagnostics.push('ROSTER_AUTH_CHANNEL_FORBIDDEN', 'ROSTER_ROUTE_FORBIDDEN');
    }
    else {
        matchedPolicy = findRoutePolicyForProviderApi(request.provider_id, request.api, policies, request.auth_class, request.auth_source);
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
            }
            else {
                diagnostics.push('ROSTER_AUTH_REQUIRED');
            }
        }
        if (!matchedPolicy.allowed_auth_sources.includes(request.auth_source) &&
            request.auth_source !== 'not-configured' &&
            request.auth_source !== 'unknown') {
            diagnostics.push('ROSTER_AUTH_CHANNEL_FORBIDDEN');
        }
        if (matchedPolicy.policy_state === 'blocked-live-certification') {
            diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
        }
        if (matchedPolicy.billing_class === 'metered-third-party-blocked' ||
            matchedPolicy.billing_class === 'forbidden-metered-gateway' ||
            matchedPolicy.billing_route_class === 'third-party-metered-blocked' ||
            matchedPolicy.billing_route_class === 'gateway-forbidden') {
            diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
        }
    }
    const uniqueDiagnostics = dedupeDiagnostics(diagnostics);
    const matched = matchedPolicy !== null && uniqueDiagnostics.length === 0;
    const preimage = {
        schema_version: 'autopilot.route_resolution_result.v1',
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
export function validateRouteConformance(request, policies) {
    const policy = findRoutePolicy(request.route_policy_id, request.route_policy_revision, policies);
    const diagnostics = [];
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
    if (!policy.allowed_auth_sources.includes(request.auth_source) &&
        request.auth_source !== 'not-configured' &&
        request.auth_source !== 'unknown') {
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
function compareNullableStrings(left, right) {
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
function uniqueSorted(values, compare) {
    const sorted = [...values].sort(compare);
    for (let index = 1; index < sorted.length; index += 1) {
        if (compare(sorted[index - 1], sorted[index]) === 0) {
            throw new Error('duplicate unique inventory value');
        }
    }
    return sorted;
}
function sortLexicographic(values) {
    return uniqueSorted(values, (left, right) => left.localeCompare(right));
}
function sortServiceTiers(values) {
    return uniqueSorted(values, compareNullableStrings);
}
export function normalizeRosterInventory(input) {
    const providers = uniqueSorted(input.providers, (left, right) => left.provider_id.localeCompare(right.provider_id)).map((provider) => ({
        ...provider,
        models: uniqueSorted(provider.models, (left, right) => left.model_id.localeCompare(right.model_id) || left.api.localeCompare(right.api)).map((model) => ({
            ...model,
            input_modalities: sortLexicographic(model.input_modalities),
            output_modalities: sortLexicographic(model.output_modalities),
            thinking_values: sortLexicographic(model.thinking_values),
            service_tiers: sortServiceTiers(model.service_tiers),
            cache_policies: sortLexicographic(model.cache_policies),
            system_prompt_profiles: sortLexicographic(model.system_prompt_profiles),
        })),
    }));
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
export function hashRosterInventory(input) {
    return normalizeRosterInventory(input).inventory_sha256;
}
export function verifyRosterInventoryHash(inventory) {
    return normalizeRosterInventory(inventory).inventory_sha256 === inventory.inventory_sha256;
}
export function findInventoryProvider(inventory, providerId) {
    return inventory.providers.find((provider) => provider.provider_id === providerId) ?? null;
}
export function findInventoryModel(provider, modelId, api) {
    return provider.models.find((model) => model.model_id === modelId && model.api === api) ?? null;
}
