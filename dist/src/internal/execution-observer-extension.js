import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
export const AUTOPILOT_EXECUTION_OBSERVATION_ENV = 'AUTOPILOT_EXECUTION_OBSERVATION_PATH';
export const AUTOPILOT_EXECUTION_OBSERVATION_SCHEMA_VERSION = 'autopilot.execution_observation.v1';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export function parseAutopilotExecutionObservation(value) {
    const record = jsonRecord(value, 'execution observation');
    if (record['schema_version'] !== AUTOPILOT_EXECUTION_OBSERVATION_SCHEMA_VERSION) {
        throw new Error(`execution observation schema_version must be ${AUTOPILOT_EXECUTION_OBSERVATION_SCHEMA_VERSION}`);
    }
    const source = record['source'];
    if (source !== 'pi-extension-events.v1' && source !== 'fake-rpc-subprocess.v1') {
        throw new Error('execution observation source is unsupported');
    }
    const observedAt = stringField(record, 'observed_at', 'execution observation');
    if (!Number.isFinite(Date.parse(observedAt)))
        throw new Error('execution observation observed_at is invalid');
    const mode = nullableString(record['mode'], 'execution observation.mode');
    const activeModel = nullableModel(record['active_model'], 'execution observation.active_model');
    const finalAssistantMessage = nullableFinalAssistant(record['final_assistant_message'], 'execution observation.final_assistant_message');
    const executionProfile = parseExecutionProfile(record['execution_profile']);
    const diagnostics = arrayOfStrings(record['diagnostics'], 'execution observation.diagnostics');
    return Object.freeze({
        schema_version: AUTOPILOT_EXECUTION_OBSERVATION_SCHEMA_VERSION,
        source,
        observed_at: observedAt,
        mode,
        active_model: activeModel,
        final_assistant_message: finalAssistantMessage,
        execution_profile: executionProfile,
        diagnostics,
    });
}
export function deriveRoutePolicyFromObservedProviderApi(providerId, api) {
    if (providerId === 'openai-codex' && api === 'openai-codex-responses')
        return { route_policy_id: 'codex-subscription-v1', route_policy_revision: 1 };
    if (providerId === 'anthropic' && api === 'anthropic-messages')
        return { route_policy_id: 'anthropic-sanitized-v1', route_policy_revision: 1 };
    if (providerId === 'kimi-coding' && api === 'openai-completions')
        return { route_policy_id: 'kimi-coding-plan-v1', route_policy_revision: 1 };
    if (providerId === 'opencode-go' && api === 'openai-completions')
        return { route_policy_id: 'opencode-go-plan-v1', route_policy_revision: 1 };
    if (providerId === 'zai' && api === 'openai-completions')
        return { route_policy_id: 'zai-coding-plan-v1', route_policy_revision: 1 };
    return null;
}
export function inferProviderRequestCachePolicy(payload) {
    if (containsProviderCacheDirective(payload))
        return 'unsupported-explicit-cache';
    return 'provider-default';
}
export function inferProviderRequestServiceTier(payload) {
    const tier = findProviderServiceTier(payload);
    if (tier === undefined || tier === null)
        return null;
    if (tier === 'priority')
        return 'priority';
    return 'unsupported-service-tier';
}
export default function autopilotExecutionObserverExtension(pi) {
    const outputPath = process.env[AUTOPILOT_EXECUTION_OBSERVATION_ENV];
    if (outputPath === undefined || outputPath.trim().length === 0) {
        throw new Error(`${AUTOPILOT_EXECUTION_OBSERVATION_ENV} is required for Autopilot execution observation`);
    }
    if (!isAbsolute(outputPath)) {
        throw new Error(`${AUTOPILOT_EXECUTION_OBSERVATION_ENV} must be absolute`);
    }
    const state = {
        mode: null,
        activeModel: null,
        finalAssistantMessage: null,
        serviceTier: null,
        cachePolicy: 'provider-default',
        systemPromptProfile: null,
        systemPromptSha256: null,
        routePolicyId: null,
        routePolicyRevision: null,
        diagnostics: [],
    };
    const writeObservation = () => {
        const fallbackModel = state.finalAssistantMessage === null
            ? state.activeModel
            : { provider: state.finalAssistantMessage.provider, id: state.finalAssistantMessage.model, api: state.finalAssistantMessage.api };
        const route = state.routePolicyId !== null && state.routePolicyRevision !== null
            ? { route_policy_id: state.routePolicyId, route_policy_revision: state.routePolicyRevision }
            : fallbackModel?.provider !== null && fallbackModel?.provider !== undefined && fallbackModel?.api !== null && fallbackModel?.api !== undefined
                ? deriveRoutePolicyFromObservedProviderApi(fallbackModel.provider, fallbackModel.api)
                : null;
        const systemPromptSha256 = state.systemPromptSha256;
        const systemPromptProfile = state.systemPromptProfile;
        const diagnostics = [...state.diagnostics];
        if (systemPromptSha256 === null)
            diagnostics.push('system prompt was not observed before provider request');
        if (systemPromptProfile === null)
            diagnostics.push('system prompt profile could not be classified from Pi prompt inputs');
        if (route === null)
            diagnostics.push('route policy could not be derived from observed provider/api');
        const record = {
            schema_version: AUTOPILOT_EXECUTION_OBSERVATION_SCHEMA_VERSION,
            source: 'pi-extension-events.v1',
            observed_at: new Date().toISOString(),
            mode: state.mode,
            active_model: state.activeModel,
            final_assistant_message: state.finalAssistantMessage,
            execution_profile: {
                service_tier: state.serviceTier,
                cache_policy: state.cachePolicy,
                system_prompt_profile: systemPromptProfile ?? 'pi-default.v1',
                system_prompt_sha256: systemPromptSha256 ?? sha256String('autopilot.execution-observer.missing-system-prompt'),
                route_policy_id: route?.route_policy_id ?? 'unobserved-route-policy',
                route_policy_revision: route?.route_policy_revision ?? 0,
            },
            diagnostics,
        };
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
    };
    pi.on('session_start', (_event, ctx) => {
        state.mode = ctx.mode;
        state.activeModel = projectModel(ctx.model);
        writeObservation();
    });
    pi.on('model_select', (event, ctx) => {
        state.mode = ctx.mode;
        state.activeModel = projectModel(event.model);
        writeObservation();
    });
    pi.on('before_agent_start', (event, ctx) => {
        state.mode = ctx.mode;
        state.activeModel = projectModel(ctx.model);
        state.systemPromptSha256 = sha256String(event.systemPrompt);
        state.systemPromptProfile = classifySystemPromptProfile(event.systemPromptOptions);
        writeObservation();
    });
    pi.on('before_provider_request', (event, ctx) => {
        state.mode = ctx.mode;
        state.activeModel = projectModel(ctx.model);
        const serviceTier = inferProviderRequestServiceTier(event.payload);
        if (serviceTier === 'unsupported-service-tier')
            state.diagnostics.push('provider payload carried unsupported service tier');
        else
            state.serviceTier = serviceTier;
        const cachePolicy = inferProviderRequestCachePolicy(event.payload);
        if (cachePolicy === 'unsupported-explicit-cache')
            state.diagnostics.push('provider payload carried explicit cache controls unsupported by Autopilot W3 observer');
        else
            state.cachePolicy = cachePolicy;
        writeObservation();
    });
    pi.on('message_end', (event, ctx) => {
        if (event.message['role'] !== 'assistant')
            return;
        const message = event.message;
        const provider = stringValue(message['provider']);
        const model = stringValue(message['model']);
        const api = stringValue(message['api']);
        if (provider !== null && model !== null && api !== null) {
            state.finalAssistantMessage = {
                provider,
                model,
                api,
                stopReason: stringValue(message['stopReason']),
            };
            const route = deriveRoutePolicyFromObservedProviderApi(provider, api);
            state.routePolicyId = route?.route_policy_id ?? null;
            state.routePolicyRevision = route?.route_policy_revision ?? null;
        }
        else {
            state.diagnostics.push('assistant message ended without provider/model/api metadata');
        }
        state.mode = ctx.mode;
        writeObservation();
    });
    pi.on('agent_settled', (_event, ctx) => {
        state.mode = ctx.mode;
        writeObservation();
    });
    pi.on('session_shutdown', () => {
        writeObservation();
    });
}
function parseExecutionProfile(value) {
    const profile = jsonRecord(value, 'execution observation profile');
    const serviceTierValue = profile['service_tier'];
    const service_tier = serviceTierValue === null ? null : serviceTierValue === 'priority' ? 'priority' : fail('execution observation service_tier is invalid');
    const cache_policy = cachePolicy(profile['cache_policy']);
    const system_prompt_profile = systemPromptProfile(profile['system_prompt_profile']);
    const system_prompt_sha256 = shaField(profile, 'system_prompt_sha256');
    const route_policy_id = stringField(profile, 'route_policy_id', 'execution observation profile');
    const route_policy_revision = positiveInteger(profile['route_policy_revision'], 'execution observation profile.route_policy_revision');
    return Object.freeze({ service_tier, cache_policy, system_prompt_profile, system_prompt_sha256, route_policy_id, route_policy_revision });
}
function classifySystemPromptProfile(options) {
    if (!isRecord(options))
        return processArgvProvesPiDefaultPromptProfile() ? 'pi-default.v1' : null;
    const customPrompt = options['customPrompt'];
    const appendSystemPrompt = options['appendSystemPrompt'];
    const contextFiles = options['contextFiles'];
    const skills = options['skills'];
    const promptTemplates = options['promptTemplates'];
    const themes = options['themes'];
    const hasCustomPrompt = typeof customPrompt === 'string' && customPrompt.trim().length > 0;
    const hasAppend = Array.isArray(appendSystemPrompt) ? appendSystemPrompt.length > 0 : typeof appendSystemPrompt === 'string' && appendSystemPrompt.length > 0;
    const hasContextFiles = Array.isArray(contextFiles) && contextFiles.length > 0;
    const hasSkills = Array.isArray(skills) && skills.length > 0;
    const hasPromptTemplates = Array.isArray(promptTemplates) && promptTemplates.length > 0;
    const hasThemes = Array.isArray(themes) && themes.length > 0;
    if (!hasCustomPrompt && !hasAppend && !hasContextFiles && !hasSkills && !hasPromptTemplates && !hasThemes && processArgvProvesPiDefaultPromptProfile())
        return 'pi-default.v1';
    if (hasCustomPrompt && typeof customPrompt === 'string' && /anthropic-autopilot-sanitized\.v1/u.test(customPrompt))
        return 'anthropic-autopilot-sanitized.v1';
    return null;
}
function processArgvProvesPiDefaultPromptProfile(argv = process.argv) {
    const flags = new Set(argv);
    return flags.has('--no-context-files')
        && flags.has('--no-skills')
        && flags.has('--no-prompt-templates')
        && flags.has('--no-themes');
}
function projectModel(model) {
    if (!isRecord(model))
        return null;
    return Object.freeze({
        provider: stringValue(model['provider']),
        id: stringValue(model['id']),
        api: stringValue(model['api']),
    });
}
function nullableModel(value, label) {
    if (value === null)
        return null;
    const record = jsonRecord(value, label);
    return Object.freeze({
        provider: nullableString(record['provider'], `${label}.provider`),
        id: nullableString(record['id'], `${label}.id`),
        api: nullableString(record['api'], `${label}.api`),
    });
}
function nullableFinalAssistant(value, label) {
    if (value === null)
        return null;
    const record = jsonRecord(value, label);
    return Object.freeze({
        provider: stringField(record, 'provider', label),
        model: stringField(record, 'model', label),
        api: stringField(record, 'api', label),
        stopReason: nullableString(record['stopReason'], `${label}.stopReason`),
    });
}
function findProviderServiceTier(value) {
    if (!isRecord(value))
        return undefined;
    if (Object.prototype.hasOwnProperty.call(value, 'service_tier'))
        return value['service_tier'];
    if (Object.prototype.hasOwnProperty.call(value, 'serviceTier'))
        return value['serviceTier'];
    return undefined;
}
function containsProviderCacheDirective(value, depth = 0) {
    if (depth > 8)
        return false;
    if (Array.isArray(value))
        return value.some((item) => containsProviderCacheDirective(item, depth + 1));
    if (!isRecord(value))
        return false;
    for (const [key, entry] of Object.entries(value)) {
        if (key === 'cache_control' || key === 'prompt_cache_key' || key === 'prompt_cache_retention' || key === 'cachePolicy')
            return true;
        if (containsProviderCacheDirective(entry, depth + 1))
            return true;
    }
    return false;
}
function cachePolicy(value) {
    if (value === 'provider-default' || value === 'none' || value === 'short' || value === 'long')
        return value;
    return fail('execution observation cache_policy is invalid');
}
function systemPromptProfile(value) {
    if (value === 'pi-default.v1' || value === 'anthropic-autopilot-sanitized.v1')
        return value;
    return fail('execution observation system_prompt_profile is invalid');
}
function jsonRecord(value, label) {
    if (!isRecord(value))
        throw new Error(`${label} must be an object`);
    return value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringField(record, field, label) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0)
        throw new Error(`${label}.${field} must be a non-empty string`);
    return value;
}
function nullableString(value, label) {
    if (value === null)
        return null;
    if (typeof value === 'string')
        return value;
    throw new Error(`${label} must be string or null`);
}
function stringValue(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
function shaField(record, field) {
    const value = stringField(record, field, 'execution observation profile');
    if (!SHA256_PATTERN.test(value))
        throw new Error(`execution observation profile.${field} is not a sha256 digest`);
    return value;
}
function positiveInteger(value, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
        throw new Error(`${label} must be a positive integer`);
    return value;
}
function arrayOfStrings(value, label) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
        throw new Error(`${label} must be an array of strings`);
    return Object.freeze([...value]);
}
function sha256String(value) {
    return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
function fail(message) {
    throw new Error(message);
}
