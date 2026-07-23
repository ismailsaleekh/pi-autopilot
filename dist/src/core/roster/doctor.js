import { ROUTE_POLICIES, authClassForRoute, authSourceForRoute, canonicalSha256, dedupeDiagnostics, findInventoryModel, findInventoryProvider, normalizeRosterInventory, resolveRoute, } from "./route-policies.js";
import { PROVIDER_RECIPES, getProfileTemplate, proposeRosterCandidates, resolveRecipe, } from "./provider-recipes.js";
function uniqueByHashSorted(results) {
    const byHash = new Map();
    for (const result of results) {
        byHash.set(result.result_sha256, result);
    }
    return [...byHash.values()].sort((left, right) => left.result_sha256.localeCompare(right.result_sha256));
}
function routeResultsForInventory(inventory, routePolicies) {
    const results = [];
    for (const provider of inventory.providers) {
        const apis = provider.models.length > 0
            ? [...new Set(provider.models.map((model) => model.api))].sort((left, right) => left.localeCompare(right))
            : [...new Set(routePolicies.filter((policy) => policy.provider_id === provider.provider_id).flatMap((policy) => policy.allowed_apis))].sort((left, right) => left.localeCompare(right));
        for (const api of apis) {
            results.push(resolveRoute({
                schema_version: 'autopilot.route_resolution_request.v1',
                provider_id: provider.provider_id,
                api,
                auth_class: authClassForRoute(provider),
                auth_source: authSourceForRoute(provider),
                project_trusted: inventory.project_trusted,
            }, routePolicies));
        }
    }
    return uniqueByHashSorted(results);
}
function recipeResultsForInventory(inventory, recipes, routePolicies, qualificationManifests) {
    const results = [];
    for (const recipe of [...recipes].sort((left, right) => left.recipe_id.localeCompare(right.recipe_id) || left.recipe_revision - right.recipe_revision)) {
        for (const profile of recipe.profile_templates) {
            results.push(resolveRecipe({
                schema_version: 'autopilot.recipe_resolution_request.v1',
                profile_id: profile.profile_id,
                recipe_id: recipe.recipe_id,
                recipe_revision: recipe.recipe_revision,
                inventory_sha256: inventory.inventory_sha256,
                qualification_manifest: qualificationManifests.find((manifest) => manifest.subject_id === recipe.recipe_id) ?? null,
            }, inventory, { recipes, routePolicies }));
        }
    }
    return uniqueByHashSorted(results);
}
function doctorStatus(diagnostics) {
    if (diagnostics.some((diagnostic) => diagnostic.severity === 'fatal')) {
        return 'failed';
    }
    if (diagnostics.some((diagnostic) => diagnostic.code === 'ROSTER_AUTH_REQUIRED' ||
        diagnostic.code === 'ROSTER_AUTH_CHANNEL_FORBIDDEN' ||
        diagnostic.code === 'ROSTER_ROUTE_FORBIDDEN' ||
        diagnostic.code === 'ROSTER_PROJECT_UNTRUSTED' ||
        diagnostic.code === 'ROSTER_STORAGE_TRUST_REQUIRED' ||
        diagnostic.code === 'ROSTER_RECOMMENDED_PROFILE_BLOCKED' ||
        diagnostic.code === 'ROSTER_EXPLICIT_CHOICE_REQUIRED')) {
        return 'blocked';
    }
    if (diagnostics.some((diagnostic) => diagnostic.severity === 'warning' || diagnostic.severity === 'error')) {
        return 'warn';
    }
    return 'pass';
}
export function doctorRosterInventory(request) {
    const recipes = request.recipes ?? PROVIDER_RECIPES;
    const concretePolicies = request.routePolicies ?? ROUTE_POLICIES;
    const normalizedInventory = normalizeRosterInventory(request.inventory);
    const route_results = routeResultsForInventory(normalizedInventory, concretePolicies);
    const recipe_results = recipeResultsForInventory(normalizedInventory, recipes, concretePolicies, request.qualification_manifests ?? []);
    const proposal = proposeRosterCandidates({
        inventory: normalizedInventory,
        recipes,
        routePolicies: concretePolicies,
        ...(request.qualification_manifests === undefined ? {} : { qualification_manifests: request.qualification_manifests }),
    });
    const diagnostics = dedupeDiagnostics([
        ...route_results.flatMap((result) => result.diagnostics),
        ...recipe_results.flatMap((result) => result.diagnostics),
        ...proposal.diagnostics,
    ]);
    const preimage = {
        schema_version: 'autopilot.roster_doctor_result.v1',
        status: doctorStatus(diagnostics),
        inventory_sha256: normalizedInventory.inventory_sha256,
        route_results,
        recipe_results,
        diagnostics,
    };
    return { ...preimage, result_sha256: canonicalSha256(preimage) };
}
function roleTemplateDiagnostics(provider, roleTemplate) {
    const codes = [];
    if (provider === null) {
        codes.push('ROSTER_ROUTE_FORBIDDEN');
    }
    else if (!provider.auth_configured) {
        codes.push('ROSTER_AUTH_REQUIRED');
    }
    else if (provider.auth_source === 'environment') {
        codes.push('ROSTER_AUTH_CHANNEL_FORBIDDEN');
    }
    const model = provider === null ? null : findInventoryModel(provider, roleTemplate.model_id, roleTemplate.api);
    if (model === null) {
        codes.push('ROSTER_ROUTE_FORBIDDEN');
    }
    else if (model.context_window < roleTemplate.context_window ||
        model.max_output_tokens < roleTemplate.max_output_tokens ||
        !roleTemplate.input_modalities.every((modality) => model.input_modalities.includes(modality)) ||
        !roleTemplate.output_modalities.every((modality) => model.output_modalities.includes(modality)) ||
        model.reasoning_capability !== roleTemplate.reasoning_capability ||
        model.tool_capability !== roleTemplate.tool_capability ||
        !model.thinking_values.includes(roleTemplate.thinking) ||
        !model.service_tiers.some((tier) => tier === roleTemplate.service_tier) ||
        !model.cache_policies.includes(roleTemplate.cache_policy) ||
        !model.system_prompt_profiles.includes(roleTemplate.system_prompt_profile)) {
        codes.push('ROSTER_ROUTE_FORBIDDEN');
    }
    return dedupeDiagnostics(codes);
}
export function doctorRoleResults(request) {
    const recipes = request.recipes ?? PROVIDER_RECIPES;
    const routePolicies = request.routePolicies ?? ROUTE_POLICIES;
    const normalizedInventory = normalizeRosterInventory(request.inventory);
    const results = [];
    for (const recipe of recipes) {
        const routePolicy = routePolicies.find((policy) => policy.route_policy_id === recipe.route_policy_id && policy.revision === recipe.route_policy_revision);
        const provider = routePolicy === undefined ? null : findInventoryProvider(normalizedInventory, routePolicy.provider_id);
        for (const profile of recipe.profile_templates) {
            const materializedProfile = getProfileTemplate(recipe, profile.profile_id);
            if (materializedProfile === null) {
                continue;
            }
            for (const roleTemplate of materializedProfile.role_templates) {
                const diagnostics = roleTemplateDiagnostics(provider, roleTemplate);
                const preimage = {
                    schema_version: 'autopilot.roster_doctor_role_result.v1',
                    recipe_id: recipe.recipe_id,
                    recipe_revision: recipe.recipe_revision,
                    profile_id: profile.profile_id,
                    role: roleTemplate.role,
                    ok: diagnostics.length === 0,
                    diagnostics,
                };
                results.push({ ...preimage, result_sha256: canonicalSha256(preimage) });
            }
        }
    }
    return uniqueByHashSorted(results);
}
