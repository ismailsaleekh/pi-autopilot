import { PHASE37_FIXTURE_CLOCK, ROUTE_POLICIES, findRoutePolicyForProviderApi, isForbiddenGatewayProvider, normalizeRosterInventory, } from "./route-policies.js";
const SUPPORTED_APIS = new Set([
    'openai-codex-responses',
    'anthropic-messages',
    'openai-completions',
]);
const SUPPORTED_INPUT_MODALITIES = new Set(['text', 'image', 'audio', 'file', 'patch']);
const MAX_CONTEXT_WINDOW = 10_000_000;
const MAX_OUTPUT_TOKENS = 1_000_000;
const MAX_PROVIDER_COUNT = 64;
const MAX_MODEL_COUNT_PER_PROVIDER = 256;
export async function resolveRosterSetupInventoryFromContext(options) {
    const registry = options.ctx?.modelRegistry;
    if (registry === undefined || typeof registry.getAll !== 'function') {
        throw new Error('roster setup model inventory is unavailable');
    }
    if (typeof registry.getError === 'function' && registry.getError() !== undefined) {
        throw new Error('roster setup model inventory is corrupt');
    }
    const projectTrusted = options.scope === 'trusted-project'
        ? await isProjectTrusted(options.ctx)
        : true;
    const models = registry.getAll();
    const providers = new Map();
    for (const model of models) {
        const providerId = boundedIdentifier(model.provider, 'provider');
        const modelId = boundedModelId(model.id);
        const api = apiId(model.api);
        if (providerId === null || modelId === null || api === null)
            continue;
        if (providers.size >= MAX_PROVIDER_COUNT && !providers.has(providerId))
            continue;
        const authStatus = providerAuthStatus(registry, providerId);
        const authSource = inventoryAuthSource(authStatus);
        const isUsingOAuth = providerIsUsingOAuth(registry, model, authStatus);
        const routeAuthClass = authStatus.configured ? (isUsingOAuth ? 'oauth' : 'api-key') : undefined;
        const routePolicy = findRoutePolicyForProviderApi(providerId, api, ROUTE_POLICIES, routeAuthClass, authSource ?? undefined);
        const authClass = inventoryAuthClass(providerId, api, authStatus, routePolicy, isUsingOAuth);
        const inventoryModel = inventoryModelFromPiModel(model, modelId, api, routePolicy);
        if (inventoryModel === null)
            continue;
        const existing = providers.get(providerId);
        if (existing === undefined) {
            providers.set(providerId, {
                provider_id: providerId,
                auth_configured: authStatus.configured,
                auth_class: authClass,
                auth_source: authSource,
                auth_status: authStatusToInventory(authStatus),
                is_using_oauth: authClass === 'oauth',
                billing_route_class: billingRouteClass(providerId, routePolicy),
                models: [inventoryModel],
            });
            continue;
        }
        if (existing.models.length >= MAX_MODEL_COUNT_PER_PROVIDER)
            continue;
        providers.set(providerId, {
            ...existing,
            auth_configured: existing.auth_configured || authStatus.configured,
            auth_class: mergeAuthClass(existing.auth_class, authClass),
            auth_source: mergeAuthSource(existing.auth_source, authSource),
            auth_status: mergeAuthStatus(existing.auth_status, authStatusToInventory(authStatus)),
            is_using_oauth: existing.is_using_oauth || authClass === 'oauth',
            billing_route_class: mergeBillingRouteClass(existing.billing_route_class, billingRouteClass(providerId, routePolicy)),
            models: [...existing.models, inventoryModel],
        });
    }
    return normalizeRosterInventory({
        schema_version: 'autopilot.roster_inventory.v1',
        inventory_id: options.inventoryId ?? 'ctx-model-registry',
        created_at: options.createdAt ?? PHASE37_FIXTURE_CLOCK,
        source: 'ctx.modelRegistry',
        project_trusted: projectTrusted,
        providers: [...providers.values()],
    });
}
export async function isProjectTrusted(ctx) {
    if (ctx?.isProjectTrusted === undefined)
        return false;
    return await ctx.isProjectTrusted();
}
function providerAuthStatus(registry, providerId) {
    if (typeof registry.getProviderAuthStatus !== 'function')
        return { configured: false };
    const status = registry.getProviderAuthStatus(providerId);
    if (typeof status !== 'object' || status === null || typeof status.configured !== 'boolean') {
        return { configured: false };
    }
    return status;
}
function providerIsUsingOAuth(registry, model, status) {
    return status.configured && typeof registry.isUsingOAuth === 'function' && registry.isUsingOAuth(model) === true;
}
function boundedIdentifier(value, _label) {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(value))
        return null;
    return value;
}
function boundedModelId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u.test(value))
        return null;
    return value;
}
function apiId(value) {
    if (typeof value !== 'string' || !SUPPORTED_APIS.has(value))
        return null;
    return value;
}
function positiveInteger(value, fallback, maximum) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? Math.min(value, maximum)
        : fallback;
}
function inventoryAuthSource(status) {
    if (!status.configured)
        return null;
    switch (status.source) {
        case 'stored':
        case 'runtime':
        case 'environment':
            return status.source;
        case 'models_json_key':
            return 'stored';
        case 'models_json_command':
            return 'runtime';
        case 'fallback':
            return 'environment';
        default:
            return null;
    }
}
function inventoryAuthClass(providerId, api, status, routePolicy, isUsingOAuth) {
    if (!status.configured)
        return null;
    if (isUsingOAuth)
        return 'oauth';
    const policy = routePolicy ?? findRoutePolicyForProviderApi(providerId, api, ROUTE_POLICIES);
    const concreteAllowed = policy?.allowed_auth_classes.filter((entry) => entry !== 'none' && entry !== 'unknown' && entry !== 'oauth') ?? [];
    if (concreteAllowed.length === 1)
        return concreteAllowed[0];
    return 'api-key';
}
function authStatusToInventory(status) {
    if (!status.configured)
        return 'missing';
    if (status.source === 'environment' || status.source === 'fallback')
        return 'forbidden';
    return 'configured';
}
function billingRouteClass(providerId, routePolicy) {
    if (isForbiddenGatewayProvider(providerId))
        return 'gateway-forbidden';
    return routePolicy?.billing_route_class ?? 'unknown';
}
function inventoryModelFromPiModel(model, modelId, api, routePolicy) {
    const inputModalities = inputModalitiesFromModel(model.input);
    if (inputModalities.length === 0)
        return null;
    const thinkingValues = thinkingValuesFromModel(model);
    return {
        model_id: modelId,
        api,
        context_window: positiveInteger(model.contextWindow, 128_000, MAX_CONTEXT_WINDOW),
        max_output_tokens: positiveInteger(model.maxTokens, 16_384, MAX_OUTPUT_TOKENS),
        input_modalities: inputModalities,
        output_modalities: ['text'],
        reasoning_capability: model.reasoning === true ? 'reasoning-supported' : 'reasoning-unsupported',
        tool_capability: 'tool-use-supported',
        thinking_values: thinkingValues,
        service_tiers: serviceTiers(routePolicy),
        cache_policies: cachePolicies(routePolicy),
        system_prompt_profiles: systemPromptProfiles(routePolicy),
    };
}
function inputModalitiesFromModel(value) {
    if (!Array.isArray(value))
        return ['text'];
    const modalities = [...new Set(value.filter((entry) => typeof entry === 'string' && SUPPORTED_INPUT_MODALITIES.has(entry)))];
    return modalities.sort((left, right) => left.localeCompare(right));
}
function thinkingValuesFromModel(model) {
    if (model.reasoning !== true)
        return ['high'];
    const output = new Set();
    const map = model.thinkingLevelMap;
    if (typeof map === 'object' && map !== null && !Array.isArray(map)) {
        const record = map;
        if (record['high'] !== null)
            output.add('high');
        if (typeof record['xhigh'] === 'string')
            output.add('xhigh');
    }
    else {
        output.add('high');
    }
    return [...output].sort((left, right) => left.localeCompare(right));
}
function serviceTiers(routePolicy) {
    const tiers = routePolicy?.allowed_service_tiers ?? [null];
    return [...new Set(tiers)].sort((left, right) => {
        if (left === right)
            return 0;
        if (left === null)
            return -1;
        if (right === null)
            return 1;
        return left.localeCompare(right);
    });
}
function cachePolicies(routePolicy) {
    const values = routePolicy?.allowed_cache_policies ?? ['provider-default'];
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function systemPromptProfiles(routePolicy) {
    const values = routePolicy?.allowed_system_prompt_profiles ?? ['pi-default.v1'];
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function mergeAuthClass(left, right) {
    if (left === right)
        return left;
    if (left === 'oauth' || right === 'oauth')
        return 'oauth';
    return left ?? right;
}
function mergeAuthSource(left, right) {
    if (left === right)
        return left;
    if (left === 'environment' || right === 'environment')
        return 'environment';
    return left ?? right;
}
function mergeAuthStatus(left, right) {
    if (left === 'forbidden' || right === 'forbidden')
        return 'forbidden';
    if (left === 'configured' || right === 'configured')
        return 'configured';
    if (left === 'unknown' || right === 'unknown')
        return 'unknown';
    return 'missing';
}
function mergeBillingRouteClass(left, right) {
    if (left === right)
        return left;
    if (left === 'gateway-forbidden' || right === 'gateway-forbidden')
        return 'gateway-forbidden';
    if (left === 'third-party-metered-blocked' || right === 'third-party-metered-blocked')
        return 'third-party-metered-blocked';
    return left === 'unknown' ? right : left;
}
