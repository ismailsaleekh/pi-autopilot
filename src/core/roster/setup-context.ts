import {
  PHASE37_FIXTURE_CLOCK,
  ROUTE_POLICIES,
  type ApiId,
  type AuthStatus,
  type BillingRouteClass,
  type CachePolicy,
  type InventoryAuthClass,
  type InventoryAuthSource,
  type InventoryModel,
  type InventoryProvider,
  type Modality,
  type ReasoningCapability,
  type RosterInventory,
  type RosterScope,
  type RoutePolicy,
  type ServiceTier,
  type SystemPromptProfile,
  type ThinkingValue,
  type ToolCapability,
  findRoutePolicyForProviderApi,
  isForbiddenGatewayProvider,
  normalizeRosterInventory,
} from './route-policies.ts';

interface PiAuthStatusLike {
  readonly configured: boolean;
  readonly source?: string | undefined;
}

interface PiModelLike {
  readonly provider?: unknown;
  readonly id?: unknown;
  readonly api?: unknown;
  readonly reasoning?: unknown;
  readonly thinkingLevelMap?: unknown;
  readonly input?: unknown;
  readonly contextWindow?: unknown;
  readonly maxTokens?: unknown;
}

interface PiModelRegistryLike {
  getAll(): readonly PiModelLike[];
  getError?(): string | undefined;
  getProviderAuthStatus?(provider: string): PiAuthStatusLike;
}

interface RosterSetupContextLike {
  readonly modelRegistry?: PiModelRegistryLike | undefined;
  isProjectTrusted?(): boolean | Promise<boolean>;
}

interface ResolveRosterSetupInventoryOptions {
  readonly ctx?: RosterSetupContextLike | undefined;
  readonly scope: RosterScope;
  readonly inventoryId?: string | undefined;
  readonly createdAt?: string | undefined;
}

const SUPPORTED_APIS = new Set<string>([
  'openai-codex-responses',
  'anthropic-messages',
  'openai-completions',
]);

const SUPPORTED_INPUT_MODALITIES = new Set<string>(['text', 'image', 'audio', 'file', 'patch']);
const MAX_CONTEXT_WINDOW = 10_000_000;
const MAX_OUTPUT_TOKENS = 1_000_000;
const MAX_PROVIDER_COUNT = 64;
const MAX_MODEL_COUNT_PER_PROVIDER = 256;

export async function resolveRosterSetupInventoryFromContext(
  options: ResolveRosterSetupInventoryOptions,
): Promise<RosterInventory> {
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
  const providers = new Map<string, InventoryProvider>();

  for (const model of models) {
    const providerId = boundedIdentifier(model.provider, 'provider');
    const modelId = boundedModelId(model.id);
    const api = apiId(model.api);
    if (providerId === null || modelId === null || api === null) continue;
    if (providers.size >= MAX_PROVIDER_COUNT && !providers.has(providerId)) continue;

    const routePolicy = findRoutePolicyForProviderApi(providerId, api, ROUTE_POLICIES);
    const authStatus = providerAuthStatus(registry, providerId);
    const authClass = inventoryAuthClass(providerId, api, authStatus, routePolicy);
    const authSource = inventoryAuthSource(authStatus);
    const inventoryModel = inventoryModelFromPiModel(model, modelId, api, routePolicy);
    if (inventoryModel === null) continue;

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
    if (existing.models.length >= MAX_MODEL_COUNT_PER_PROVIDER) continue;
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

export async function isProjectTrusted(ctx: RosterSetupContextLike | undefined): Promise<boolean> {
  if (ctx?.isProjectTrusted === undefined) return false;
  return await ctx.isProjectTrusted();
}

function providerAuthStatus(registry: PiModelRegistryLike, providerId: string): PiAuthStatusLike {
  if (typeof registry.getProviderAuthStatus !== 'function') return { configured: false };
  const status = registry.getProviderAuthStatus(providerId);
  if (typeof status !== 'object' || status === null || typeof status.configured !== 'boolean') {
    return { configured: false };
  }
  return status;
}

function boundedIdentifier(value: unknown, _label: string): string | null {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) return null;
  return value;
}

function boundedModelId(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u.test(value)) return null;
  return value;
}

function apiId(value: unknown): ApiId | null {
  if (typeof value !== 'string' || !SUPPORTED_APIS.has(value)) return null;
  return value as ApiId;
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function inventoryAuthSource(status: PiAuthStatusLike): InventoryAuthSource {
  if (!status.configured) return null;
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

function inventoryAuthClass(
  providerId: string,
  api: ApiId,
  status: PiAuthStatusLike,
  routePolicy: RoutePolicy | null,
): InventoryAuthClass {
  if (!status.configured) return null;
  const policy = routePolicy ?? findRoutePolicyForProviderApi(providerId, api, ROUTE_POLICIES);
  const concreteAllowed = policy?.allowed_auth_classes.filter((entry) => entry !== 'none' && entry !== 'unknown') ?? [];
  if (concreteAllowed.length === 1) return concreteAllowed[0] as InventoryAuthClass;
  return 'api-key';
}

function authStatusToInventory(status: PiAuthStatusLike): AuthStatus {
  if (!status.configured) return 'missing';
  if (status.source === 'environment' || status.source === 'fallback') return 'forbidden';
  return 'configured';
}

function billingRouteClass(providerId: string, routePolicy: RoutePolicy | null): BillingRouteClass {
  if (isForbiddenGatewayProvider(providerId)) return 'gateway-forbidden';
  return routePolicy?.billing_route_class ?? 'unknown';
}

function inventoryModelFromPiModel(
  model: PiModelLike,
  modelId: string,
  api: ApiId,
  routePolicy: RoutePolicy | null,
): InventoryModel | null {
  const inputModalities = inputModalitiesFromModel(model.input);
  if (inputModalities.length === 0) return null;
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

function inputModalitiesFromModel(value: unknown): readonly Modality[] {
  if (!Array.isArray(value)) return ['text'];
  const modalities = [...new Set(value.filter((entry): entry is Modality => typeof entry === 'string' && SUPPORTED_INPUT_MODALITIES.has(entry)))];
  return modalities.sort((left, right) => left.localeCompare(right));
}

function thinkingValuesFromModel(model: PiModelLike): readonly ThinkingValue[] {
  if (model.reasoning !== true) return ['high'];
  const output = new Set<ThinkingValue>();
  const map = model.thinkingLevelMap;
  if (typeof map === 'object' && map !== null && !Array.isArray(map)) {
    const record = map as Readonly<Record<string, unknown>>;
    if (record['high'] !== null) output.add('high');
    if (typeof record['xhigh'] === 'string') output.add('xhigh');
  } else {
    output.add('high');
  }
  return [...output].sort((left, right) => left.localeCompare(right));
}

function serviceTiers(routePolicy: RoutePolicy | null): readonly ServiceTier[] {
  const tiers = routePolicy?.allowed_service_tiers ?? [null];
  return [...new Set(tiers)].sort((left, right) => {
    if (left === right) return 0;
    if (left === null) return -1;
    if (right === null) return 1;
    return left.localeCompare(right);
  });
}

function cachePolicies(routePolicy: RoutePolicy | null): readonly CachePolicy[] {
  const values: readonly CachePolicy[] = routePolicy?.allowed_cache_policies ?? ['provider-default'];
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function systemPromptProfiles(routePolicy: RoutePolicy | null): readonly SystemPromptProfile[] {
  const values: readonly SystemPromptProfile[] = routePolicy?.allowed_system_prompt_profiles ?? ['pi-default.v1'];
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function mergeAuthClass(left: InventoryAuthClass, right: InventoryAuthClass): InventoryAuthClass {
  if (left === right) return left;
  if (left === 'oauth' || right === 'oauth') return 'oauth';
  return left ?? right;
}

function mergeAuthSource(left: InventoryAuthSource, right: InventoryAuthSource): InventoryAuthSource {
  if (left === right) return left;
  if (left === 'environment' || right === 'environment') return 'environment';
  return left ?? right;
}

function mergeAuthStatus(left: AuthStatus, right: AuthStatus): AuthStatus {
  if (left === 'forbidden' || right === 'forbidden') return 'forbidden';
  if (left === 'configured' || right === 'configured') return 'configured';
  if (left === 'unknown' || right === 'unknown') return 'unknown';
  return 'missing';
}

function mergeBillingRouteClass(left: BillingRouteClass, right: BillingRouteClass): BillingRouteClass {
  if (left === right) return left;
  if (left === 'gateway-forbidden' || right === 'gateway-forbidden') return 'gateway-forbidden';
  if (left === 'third-party-metered-blocked' || right === 'third-party-metered-blocked') return 'third-party-metered-blocked';
  return left === 'unknown' ? right : left;
}
