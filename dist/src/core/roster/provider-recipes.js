import { parseAutopilotRosterContract, } from "./contracts.js";
import { PHASE37_FIXTURE_CLOCK, PHASE37_FREEZE_ID, PHASE37_PACKAGE_VERSION, PHASE37_PI_VERSION, PHASE37_W0_SEED_CREATED_AT, ROSTER_DIAGNOSTIC_CODES, ROSTER_RECOMMENDED_PROFILE_ID, ROSTER_ROLE_ORDER, ROUTE_POLICIES, authClassForRoute, authSourceForRoute, canonicalSha256, dedupeDiagnostics, findInventoryModel, findInventoryProvider, findRoutePolicy, hashObjectOmitting, hashRosterInventory, isForbiddenGatewayProvider, isRosterProfileId, isRosterRole, normalizeRosterInventory, resolveRoute, roleSortIndex, rosterDiagnostic, validateRouteConformance, verifyRosterInventoryHash, } from "./route-policies.js";
const PROVIDER_RECIPE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
function deepFreezeRecipeAuthority(value, seen = new WeakSet()) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        return value;
    }
    const objectValue = value;
    if (seen.has(objectValue)) {
        return value;
    }
    seen.add(objectValue);
    for (const key of Reflect.ownKeys(objectValue)) {
        deepFreezeRecipeAuthority(objectValue[key], seen);
    }
    return Object.freeze(objectValue);
}
export function parseProviderRoster(value) {
    return providerRosterFromContract(parseAutopilotRosterContract('autopilot.roster.v1', value));
}
export function parseProviderQualificationManifest(value) {
    return providerQualificationManifestFromContract(parseAutopilotRosterContract('autopilot.certification_manifest.v1', value));
}
export function parseProviderRosterCandidateSet(value) {
    return providerRosterCandidateSetFromContract(parseAutopilotRosterContract('autopilot.roster_candidate_set.v1', value));
}
function providerRosterFromContract(contract) {
    return Object.freeze({
        schema_version: contract.schema_version,
        roster_id: contract.roster_id,
        roster_revision: contract.roster_revision,
        display_name: contract.display_name,
        scope: contract.scope,
        selected_scope: contract.selected_scope,
        profile_id: requireRosterProfileId(contract.profile_id, 'roster.profile_id'),
        recipe_id: contract.recipe_id,
        recipe_revision: contract.recipe_revision,
        generation_source: contract.generation_source,
        package_version: contract.package_version,
        pi_version: contract.pi_version,
        route_policy_ids: Object.freeze([...contract.route_policy_ids]),
        assignment_set_sha256: requireDigest(contract.assignment_set_sha256, 'roster.assignment_set_sha256'),
        assignments: Object.freeze(contract.assignments.map(providerAssignmentFromContract)),
        capability_summary: providerCapabilitySummaryFromContract(contract.capability_summary),
        billing_summary: providerBillingSummaryFromContract(contract.billing_summary),
        auth_summary: providerAuthSummaryFromContract(contract.auth_summary),
        certification_manifest_id: contract.certification_manifest_id,
        certification_manifest_sha256: nullableDigestFromContract(contract.certification_manifest_sha256, 'roster.certification_manifest_sha256'),
        created_at: contract.created_at,
        roster_sha256: requireDigest(contract.roster_sha256, 'roster.roster_sha256'),
    });
}
function providerAssignmentFromContract(contract) {
    return Object.freeze({
        role: contract.role,
        provider_id: contract.provider_id,
        model_id: contract.model_id,
        model: contract.model,
        api: contract.api,
        thinking: contract.thinking,
        service_tier: contract.service_tier,
        cache_policy: contract.cache_policy,
        system_prompt_profile: contract.system_prompt_profile,
        context_window: contract.context_window,
        max_output_tokens: contract.max_output_tokens,
        input_modalities: Object.freeze([...contract.input_modalities]),
        output_modalities: Object.freeze([...contract.output_modalities]),
        reasoning_capability: contract.reasoning_capability,
        tool_capability: contract.tool_capability,
        route_policy_id: contract.route_policy_id,
        route_policy_revision: contract.route_policy_revision,
        billing_class: contract.billing_class,
        billing_route_class: contract.billing_route_class,
        auth_class: contract.auth_class,
        auth_source: contract.auth_source,
        qualification_state: contract.qualification_state,
        assignment_sha256: requireDigest(contract.assignment_sha256, 'assignment.assignment_sha256'),
    });
}
function providerCapabilitySummaryFromContract(contract) {
    return Object.freeze({
        min_context_window: contract.min_context_window,
        min_max_output_tokens: contract.min_max_output_tokens,
        input_modalities: Object.freeze([...contract.input_modalities]),
        output_modalities: Object.freeze([...contract.output_modalities]),
        reasoning_capability: contract.reasoning_capability,
        tool_capability: contract.tool_capability,
    });
}
function providerBillingSummaryFromContract(contract) {
    return Object.freeze({
        billing_class: contract.billing_class,
        billing_route_class: contract.billing_route_class,
        route_policy_ids: Object.freeze([...contract.route_policy_ids]),
        service_tiers: Object.freeze([...contract.service_tiers]),
    });
}
function providerAuthSummaryFromContract(contract) {
    if (contract.secret_fields_present !== false)
        throw new Error('auth_summary.secret_fields_present must be false');
    return Object.freeze({
        auth_classes: Object.freeze([...contract.auth_classes]),
        auth_sources: Object.freeze([...contract.auth_sources]),
        secret_fields_present: false,
    });
}
function providerQualificationManifestFromContract(contract) {
    return Object.freeze({
        schema_version: contract.schema_version,
        manifest_id: contract.manifest_id,
        manifest_revision: contract.manifest_revision,
        subject_kind: contract.subject_kind,
        subject_id: contract.subject_id,
        subject_sha256: requireDigest(contract.subject_sha256, 'manifest.subject_sha256'),
        package_version: contract.package_version,
        pi_version: contract.pi_version,
        qualification_state: contract.qualification_state,
        role_results: Object.freeze(contract.role_results.map(providerCertificationRoleResultFromContract)),
        required_evidence: Object.freeze(contract.required_evidence.map(providerEvidenceRefFromContract)),
        live_evidence: Object.freeze(contract.live_evidence.map(providerEvidenceRefFromContract)),
        issued_at: contract.issued_at,
        expires_at: contract.expires_at,
        manifest_sha256: requireDigest(contract.manifest_sha256, 'manifest.manifest_sha256'),
    });
}
function providerCertificationRoleResultFromContract(contract) {
    return Object.freeze({
        role: contract.role,
        state: contract.state,
        evidence_refs: Object.freeze(contract.evidence_refs.map(providerEvidenceRefFromContract)),
    });
}
function providerEvidenceRefFromContract(contract) {
    return Object.freeze({
        evidence_id: contract.evidence_id,
        kind: contract.kind,
        uri: contract.uri,
        sha256: nullableDigestFromContract(contract.sha256, 'evidence_ref.sha256'),
        byte_count: contract.byte_count,
        secret_free: contract.secret_free,
    });
}
function providerRosterCandidateSetFromContract(contract) {
    return Object.freeze({
        schema_version: contract.schema_version,
        candidate_set_id: contract.candidate_set_id,
        scope: contract.scope,
        inventory_sha256: requireDigest(contract.inventory_sha256, 'candidate_set.inventory_sha256'),
        recipe_registry_sha256: requireDigest(contract.recipe_registry_sha256, 'candidate_set.recipe_registry_sha256'),
        candidates: Object.freeze(contract.candidates.map(providerRosterCandidateFromContract)),
        recommended_profile_id: requireRosterProfileId(contract.recommended_profile_id, 'candidate_set.recommended_profile_id'),
        created_at: contract.created_at,
        candidate_set_sha256: requireDigest(contract.candidate_set_sha256, 'candidate_set.candidate_set_sha256'),
    });
}
function providerRosterCandidateFromContract(contract) {
    const withoutHash = {
        schema_version: contract.schema_version,
        candidate_id: contract.candidate_id,
        candidate_sort_key: contract.candidate_sort_key,
        scope: contract.scope,
        profile_id: requireRosterProfileId(contract.profile_id, 'candidate.profile_id'),
        recipe_id: contract.recipe_id,
        recipe_revision: contract.recipe_revision,
        route_policy_id: contract.route_policy_id,
        route_policy_revision: contract.route_policy_revision,
        roster_id: contract.roster_id,
        roster_revision: contract.roster_revision,
        assignment_set_sha256: requireDigest(contract.assignment_set_sha256, 'candidate.assignment_set_sha256'),
        roster_sha256: requireDigest(contract.roster_sha256, 'candidate.roster_sha256'),
        candidate_state: contract.candidate_state,
        launch_readiness: contract.launch_readiness,
        qualification_state: contract.qualification_state,
        non_certifying_seed: contract.non_certifying_seed,
        synthetic_fixture_ready_only: contract.synthetic_fixture_ready_only,
        converges_with: contract.converges_with,
        diagnostic_codes: Object.freeze(contract.diagnostic_codes.map(requireRosterDiagnosticCode)),
        ...(contract.readiness_authority === undefined ? {} : { readiness_authority: contract.readiness_authority }),
        ...(contract.provider_pack_id === undefined ? {} : { provider_pack_id: contract.provider_pack_id }),
        ...(contract.certification_manifest_id === undefined ? {} : { certification_manifest_id: contract.certification_manifest_id }),
        ...(contract.certification_manifest_sha256 === undefined ? {} : { certification_manifest_sha256: nullableDigestFromContract(contract.certification_manifest_sha256, 'candidate.certification_manifest_sha256') }),
        ...(contract.recipe_sha256 === undefined ? {} : { recipe_sha256: nullableDigestFromContract(contract.recipe_sha256, 'candidate.recipe_sha256') }),
        ...(contract.route_policy_sha256 === undefined ? {} : { route_policy_sha256: nullableDigestFromContract(contract.route_policy_sha256, 'candidate.route_policy_sha256') }),
    };
    return Object.freeze({ ...withoutHash, candidate_sha256: requireDigest(contract.candidate_sha256, 'candidate.candidate_sha256') });
}
function requireDigest(value, label) {
    if (!PROVIDER_RECIPE_DIGEST_PATTERN.test(value))
        throw new Error(`${label} must be a sha256 digest`);
    return value;
}
function nullableDigestFromContract(value, label) {
    return value === null ? null : requireDigest(value, label);
}
function requireRosterProfileId(value, label) {
    if (!isRosterProfileId(value))
        throw new Error(`${label} must be a known roster profile`);
    return value;
}
function isKnownRosterDiagnosticCode(value) {
    return ROSTER_DIAGNOSTIC_CODES.some((code) => code === value);
}
function requireRosterDiagnosticCode(value) {
    if (!isKnownRosterDiagnosticCode(value))
        throw new Error(`candidate diagnostic code ${value} is not sealed`);
    return value;
}
const PROVIDER_RECIPES_JSON = "[{\"schema_version\": \"autopilot.provider_recipe.v1\", \"recipe_id\": \"anthropic-sanitized\", \"recipe_revision\": 1, \"provider_family\": \"anthropic\", \"route_policy_id\": \"anthropic-sanitized-v1\", \"route_policy_revision\": 1, \"profile_templates\": [{\"profile_id\": \"precision\", \"selected_by_default\": false, \"route_policy_id\": \"anthropic-sanitized-v1\", \"route_policy_revision\": 1, \"role_templates\": [{\"role\": \"parent\", \"model_id\": \"opus-4.8\", \"api\": \"anthropic-messages\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"strategy\", \"model_id\": \"opus-4.8\", \"api\": \"anthropic-messages\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"implement\", \"model_id\": \"sonnet-5\", \"api\": \"anthropic-messages\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"validate\", \"model_id\": \"opus-4.8\", \"api\": \"anthropic-messages\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"fix\", \"model_id\": \"sonnet-5\", \"api\": \"anthropic-messages\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"adjudicate\", \"model_id\": \"opus-4.8\", \"api\": \"anthropic-messages\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"bughunt\", \"model_id\": \"opus-4.8\", \"api\": \"anthropic-messages\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"extract\", \"model_id\": \"haiku-4.5\", \"api\": \"anthropic-messages\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 100000, \"max_output_tokens\": 16384, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}]}], \"minimum_pi_version\": \"0.80.6\", \"certification_manifest_id\": null, \"certification_manifest_sha256\": null, \"qualification_state\": \"blocked-live-certification\", \"recipe_state\": \"blocked-live-certification\", \"non_certifying_seed\": true, \"recipe_sha256\": \"sha256:7ca7a609d89b241fafee3de74cf19e604291483c6af11fc7f4b871df4e612c48\"}, {\"schema_version\": \"autopilot.provider_recipe.v1\", \"recipe_id\": \"codex-subscription\", \"recipe_revision\": 1, \"provider_family\": \"openai-codex\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"profile_templates\": [{\"profile_id\": \"afterburner\", \"selected_by_default\": false, \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"role_templates\": [{\"role\": \"parent\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"strategy\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"implement\", \"model_id\": \"gpt-5.5\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": \"priority\", \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"validate\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"fix\", \"model_id\": \"gpt-5.5\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": \"priority\", \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"adjudicate\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"bughunt\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"extract\", \"model_id\": \"gpt-5.6-luna\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}]}, {\"profile_id\": \"cruise\", \"selected_by_default\": true, \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"role_templates\": [{\"role\": \"parent\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"strategy\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"implement\", \"model_id\": \"gpt-5.6-terra\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"validate\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"fix\", \"model_id\": \"gpt-5.6-terra\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"adjudicate\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"bughunt\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"extract\", \"model_id\": \"gpt-5.6-luna\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}]}, {\"profile_id\": \"precision\", \"selected_by_default\": false, \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"role_templates\": [{\"role\": \"parent\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"strategy\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"implement\", \"model_id\": \"gpt-5.6-terra\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"validate\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"fix\", \"model_id\": \"gpt-5.6-terra\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"adjudicate\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"bughunt\", \"model_id\": \"gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"extract\", \"model_id\": \"gpt-5.6-luna\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}]}], \"minimum_pi_version\": \"0.80.6\", \"certification_manifest_id\": null, \"certification_manifest_sha256\": null, \"qualification_state\": \"unqualified-non-certifying-seed\", \"recipe_state\": \"unqualified-seed\", \"non_certifying_seed\": true, \"recipe_sha256\": \"sha256:483908a22ea31543b402666f16cb507d6af19d601f35e6d3c6155d6dd4c3d23c\"}, {\"schema_version\": \"autopilot.provider_recipe.v1\", \"recipe_id\": \"kimi-coding-plan\", \"recipe_revision\": 1, \"provider_family\": \"kimi-coding\", \"route_policy_id\": \"kimi-coding-plan-v1\", \"route_policy_revision\": 1, \"profile_templates\": [{\"profile_id\": \"precision\", \"selected_by_default\": false, \"route_policy_id\": \"kimi-coding-plan-v1\", \"route_policy_revision\": 1, \"role_templates\": [{\"role\": \"parent\", \"model_id\": \"kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"strategy\", \"model_id\": \"kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"implement\", \"model_id\": \"kimi-for-coding\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"validate\", \"model_id\": \"kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"fix\", \"model_id\": \"kimi-for-coding\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"adjudicate\", \"model_id\": \"kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"bughunt\", \"model_id\": \"kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"extract\", \"model_id\": \"kimi-for-coding-highspeed\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 128000, \"max_output_tokens\": 16384, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}]}], \"minimum_pi_version\": \"0.80.6\", \"certification_manifest_id\": null, \"certification_manifest_sha256\": null, \"qualification_state\": \"unqualified-non-certifying-seed\", \"recipe_state\": \"unqualified-seed\", \"non_certifying_seed\": true, \"recipe_sha256\": \"sha256:62085f3f818c03630adcec17c7d7adcdd33e42bfeaea7abed14eb022989a115e\"}, {\"schema_version\": \"autopilot.provider_recipe.v1\", \"recipe_id\": \"opencode-go-plan\", \"recipe_revision\": 1, \"provider_family\": \"opencode-go\", \"route_policy_id\": \"opencode-go-plan-v1\", \"route_policy_revision\": 1, \"profile_templates\": [{\"profile_id\": \"precision\", \"selected_by_default\": false, \"route_policy_id\": \"opencode-go-plan-v1\", \"route_policy_revision\": 1, \"role_templates\": [{\"role\": \"parent\", \"model_id\": \"kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"strategy\", \"model_id\": \"kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"implement\", \"model_id\": \"kimi-k2.7-code\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"validate\", \"model_id\": \"kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"fix\", \"model_id\": \"kimi-k2.7-code\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"adjudicate\", \"model_id\": \"kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"bughunt\", \"model_id\": \"kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"extract\", \"model_id\": \"deepseek-v4-flash\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 128000, \"max_output_tokens\": 16384, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}]}], \"minimum_pi_version\": \"0.80.6\", \"certification_manifest_id\": null, \"certification_manifest_sha256\": null, \"qualification_state\": \"unqualified-non-certifying-seed\", \"recipe_state\": \"unqualified-seed\", \"non_certifying_seed\": true, \"recipe_sha256\": \"sha256:40c8e2f8eef678f37ac6f2fd797cd4c823d809628571eba62ca5a115d330ecc1\"}, {\"schema_version\": \"autopilot.provider_recipe.v1\", \"recipe_id\": \"zai-coding-plan\", \"recipe_revision\": 1, \"provider_family\": \"zai\", \"route_policy_id\": \"zai-coding-plan-v1\", \"route_policy_revision\": 1, \"profile_templates\": [{\"profile_id\": \"precision\", \"selected_by_default\": false, \"route_policy_id\": \"zai-coding-plan-v1\", \"route_policy_revision\": 1, \"role_templates\": [{\"role\": \"parent\", \"model_id\": \"glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"strategy\", \"model_id\": \"glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"implement\", \"model_id\": \"glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"validate\", \"model_id\": \"glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"fix\", \"model_id\": \"glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"adjudicate\", \"model_id\": \"glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"bughunt\", \"model_id\": \"glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, {\"role\": \"extract\", \"model_id\": \"glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}]}], \"minimum_pi_version\": \"0.80.6\", \"certification_manifest_id\": null, \"certification_manifest_sha256\": null, \"qualification_state\": \"unqualified-non-certifying-seed\", \"recipe_state\": \"unqualified-seed\", \"non_certifying_seed\": true, \"recipe_sha256\": \"sha256:65fcf2b93d11ddf57472aba636183a6a5ab13f5b4ab47b1e4a88215fd47f3f7a\"}]";
const SEED_ROSTERS_JSON = "[{\"schema_version\": \"autopilot.roster.v1\", \"roster_id\": \"afterburner-codex-subscription-7814ccd19c58\", \"roster_revision\": 1, \"display_name\": \"Afterburner seed \\u2014 codex-subscription\", \"scope\": \"user\", \"selected_scope\": \"user\", \"profile_id\": \"afterburner\", \"recipe_id\": \"codex-subscription\", \"recipe_revision\": 1, \"generation_source\": \"w0-non-certifying-seed\", \"package_version\": \"1.3.0\", \"pi_version\": \"0.80.6\", \"route_policy_ids\": [\"codex-subscription-v1\"], \"assignment_set_sha256\": \"sha256:7814ccd19c5807b001764c9a6a40f6d1e7e669c6fda29220c1f4e0e96c309e5d\", \"assignments\": [{\"role\": \"parent\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:84f17adbb0637e61c3ba9e57e897aacccd819e9bd9528d92e14a3b8036f9e7cc\"}, {\"role\": \"strategy\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:60e16ca3a610903c20a488f69b46d9bb1c84247f3021f1e914de08d74067f3d7\"}, {\"role\": \"implement\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.5\", \"model\": \"openai-codex/gpt-5.5\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": \"priority\", \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:09c864c7cce49b4a96a38028f38bc18bccdddbec33d19fab6318392df2ed4221\"}, {\"role\": \"validate\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:b4269a5a9acb9879d6797385f9b5bd8955ff5125d522578b787242979af45b9f\"}, {\"role\": \"fix\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.5\", \"model\": \"openai-codex/gpt-5.5\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": \"priority\", \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:530a42a38a766654c3a7e8e639c7e25eeab4875ed37030a9b12c68ec386a4fec\"}, {\"role\": \"adjudicate\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:ecca8ceb0fc080f88ddff78fa0660da5e22bd8f9dca6b75fbe52be13797c01f6\"}, {\"role\": \"bughunt\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:418e5a6f3c72a90dd5fb6734348375f659aed62ef52cc9063dbd4f43342d4a27\"}, {\"role\": \"extract\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-luna\", \"model\": \"openai-codex/gpt-5.6-luna\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:8631fe6d02ca00c77a653348528449dcacb16b0b35b5f0c2d57492bf9ab209a1\"}], \"capability_summary\": {\"min_context_window\": 256000, \"min_max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, \"billing_summary\": {\"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"route_policy_ids\": [\"codex-subscription-v1\"], \"service_tiers\": [null, \"priority\"]}, \"auth_summary\": {\"auth_classes\": [\"oauth\"], \"auth_sources\": [\"stored\"], \"secret_fields_present\": false}, \"certification_manifest_id\": null, \"certification_manifest_sha256\": null, \"created_at\": \"2026-07-22T00:00:00.000Z\", \"roster_sha256\": \"sha256:ba7d0cdd955589f24fb9afbb403057c8b5461fe9d62c8265b347ec7827578a85\"}, {\"schema_version\": \"autopilot.roster.v1\", \"roster_id\": \"cruise-codex-subscription-bdb4f15f0ff9\", \"roster_revision\": 1, \"display_name\": \"Cruise seed \\u2014 codex-subscription\", \"scope\": \"user\", \"selected_scope\": \"user\", \"profile_id\": \"cruise\", \"recipe_id\": \"codex-subscription\", \"recipe_revision\": 1, \"generation_source\": \"w0-non-certifying-seed\", \"package_version\": \"1.3.0\", \"pi_version\": \"0.80.6\", \"route_policy_ids\": [\"codex-subscription-v1\"], \"assignment_set_sha256\": \"sha256:bdb4f15f0ff90aff9d1e46a3a56bfdfddabafcf3c7f5c293a7b558ff2f22a3c4\", \"assignments\": [{\"role\": \"parent\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:84f17adbb0637e61c3ba9e57e897aacccd819e9bd9528d92e14a3b8036f9e7cc\"}, {\"role\": \"strategy\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:60e16ca3a610903c20a488f69b46d9bb1c84247f3021f1e914de08d74067f3d7\"}, {\"role\": \"implement\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-terra\", \"model\": \"openai-codex/gpt-5.6-terra\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:00e29e2942321f72e2ca7a0af5425bd125880a8c591bac119ebab35d3c326e33\"}, {\"role\": \"validate\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:b4269a5a9acb9879d6797385f9b5bd8955ff5125d522578b787242979af45b9f\"}, {\"role\": \"fix\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-terra\", \"model\": \"openai-codex/gpt-5.6-terra\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:27a4fe4e430c9135fda0a2800d42b336b72a58f789719dc93ba0f92fbaf510e8\"}, {\"role\": \"adjudicate\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:ecca8ceb0fc080f88ddff78fa0660da5e22bd8f9dca6b75fbe52be13797c01f6\"}, {\"role\": \"bughunt\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:418e5a6f3c72a90dd5fb6734348375f659aed62ef52cc9063dbd4f43342d4a27\"}, {\"role\": \"extract\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-luna\", \"model\": \"openai-codex/gpt-5.6-luna\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:8631fe6d02ca00c77a653348528449dcacb16b0b35b5f0c2d57492bf9ab209a1\"}], \"capability_summary\": {\"min_context_window\": 256000, \"min_max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, \"billing_summary\": {\"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"route_policy_ids\": [\"codex-subscription-v1\"], \"service_tiers\": [null]}, \"auth_summary\": {\"auth_classes\": [\"oauth\"], \"auth_sources\": [\"stored\"], \"secret_fields_present\": false}, \"certification_manifest_id\": null, \"certification_manifest_sha256\": null, \"created_at\": \"2026-07-22T00:00:00.000Z\", \"roster_sha256\": \"sha256:f3ac0895d9abedfbe3616a79af0c1c3691962d24d5f17d195a78e6ab24d2b4a0\"}, {\"schema_version\": \"autopilot.roster.v1\", \"roster_id\": \"precision-anthropic-sanitized-b7321cad3237\", \"roster_revision\": 1, \"display_name\": \"Precision seed \\u2014 anthropic-sanitized\", \"scope\": \"user\", \"selected_scope\": \"user\", \"profile_id\": \"precision\", \"recipe_id\": \"anthropic-sanitized\", \"recipe_revision\": 1, \"generation_source\": \"w0-non-certifying-seed\", \"package_version\": \"1.3.0\", \"pi_version\": \"0.80.6\", \"route_policy_ids\": [\"anthropic-sanitized-v1\"], \"assignment_set_sha256\": \"sha256:b7321cad32374c9299499d1edbb6f0f2038f4bc5fdee82b9af892cea47bdc724\", \"assignments\": [{\"role\": \"parent\", \"provider_id\": \"anthropic\", \"model_id\": \"opus-4.8\", \"model\": \"anthropic/opus-4.8\", \"api\": \"anthropic-messages\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"anthropic-sanitized-v1\", \"route_policy_revision\": 1, \"billing_class\": \"metered-third-party-blocked\", \"billing_route_class\": \"third-party-metered-blocked\", \"auth_class\": \"api-key\", \"auth_source\": \"stored\", \"qualification_state\": \"blocked-live-certification\", \"assignment_sha256\": \"sha256:644edbf5176a56ce6aa3e13fefc249012cc76534767a280ba62caca83ed1c000\"}, {\"role\": \"strategy\", \"provider_id\": \"anthropic\", \"model_id\": \"opus-4.8\", \"model\": \"anthropic/opus-4.8\", \"api\": \"anthropic-messages\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"anthropic-sanitized-v1\", \"route_policy_revision\": 1, \"billing_class\": \"metered-third-party-blocked\", \"billing_route_class\": \"third-party-metered-blocked\", \"auth_class\": \"api-key\", \"auth_source\": \"stored\", \"qualification_state\": \"blocked-live-certification\", \"assignment_sha256\": \"sha256:7fd571d57e6cdd05025ffe9166af5e2bcd1742b874e4f910cf67268bdc5dd8a1\"}, {\"role\": \"implement\", \"provider_id\": \"anthropic\", \"model_id\": \"sonnet-5\", \"model\": \"anthropic/sonnet-5\", \"api\": \"anthropic-messages\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"anthropic-sanitized-v1\", \"route_policy_revision\": 1, \"billing_class\": \"metered-third-party-blocked\", \"billing_route_class\": \"third-party-metered-blocked\", \"auth_class\": \"api-key\", \"auth_source\": \"stored\", \"qualification_state\": \"blocked-live-certification\", \"assignment_sha256\": \"sha256:211c56de53da97af1e4e5de449be1e260a9e130266fdb4562c711eba090e7465\"}, {\"role\": \"validate\", \"provider_id\": \"anthropic\", \"model_id\": \"opus-4.8\", \"model\": \"anthropic/opus-4.8\", \"api\": \"anthropic-messages\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"anthropic-sanitized-v1\", \"route_policy_revision\": 1, \"billing_class\": \"metered-third-party-blocked\", \"billing_route_class\": \"third-party-metered-blocked\", \"auth_class\": \"api-key\", \"auth_source\": \"stored\", \"qualification_state\": \"blocked-live-certification\", \"assignment_sha256\": \"sha256:a5888cb8c2f23b272057eff68fbcdffd370bf4cab80af7dd5924a675af99fa19\"}, {\"role\": \"fix\", \"provider_id\": \"anthropic\", \"model_id\": \"sonnet-5\", \"model\": \"anthropic/sonnet-5\", \"api\": \"anthropic-messages\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"anthropic-sanitized-v1\", \"route_policy_revision\": 1, \"billing_class\": \"metered-third-party-blocked\", \"billing_route_class\": \"third-party-metered-blocked\", \"auth_class\": \"api-key\", \"auth_source\": \"stored\", \"qualification_state\": \"blocked-live-certification\", \"assignment_sha256\": \"sha256:8774da75fc3356a0807a7344064a3759ca4bc76cde93692d1b29078831ac11a0\"}, {\"role\": \"adjudicate\", \"provider_id\": \"anthropic\", \"model_id\": \"opus-4.8\", \"model\": \"anthropic/opus-4.8\", \"api\": \"anthropic-messages\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"anthropic-sanitized-v1\", \"route_policy_revision\": 1, \"billing_class\": \"metered-third-party-blocked\", \"billing_route_class\": \"third-party-metered-blocked\", \"auth_class\": \"api-key\", \"auth_source\": \"stored\", \"qualification_state\": \"blocked-live-certification\", \"assignment_sha256\": \"sha256:f62731724f9459b3c80f8737ef2696cb45798e4498c054d6357024c4c0e2d3e2\"}, {\"role\": \"bughunt\", \"provider_id\": \"anthropic\", \"model_id\": \"opus-4.8\", \"model\": \"anthropic/opus-4.8\", \"api\": \"anthropic-messages\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 200000, \"max_output_tokens\": 32768, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"anthropic-sanitized-v1\", \"route_policy_revision\": 1, \"billing_class\": \"metered-third-party-blocked\", \"billing_route_class\": \"third-party-metered-blocked\", \"auth_class\": \"api-key\", \"auth_source\": \"stored\", \"qualification_state\": \"blocked-live-certification\", \"assignment_sha256\": \"sha256:b6a0971a7eba50267b5e3b26e74a41f56594aff123bb3ec1ade6c318b80f8ea6\"}, {\"role\": \"extract\", \"provider_id\": \"anthropic\", \"model_id\": \"haiku-4.5\", \"model\": \"anthropic/haiku-4.5\", \"api\": \"anthropic-messages\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"anthropic-autopilot-sanitized.v1\", \"context_window\": 100000, \"max_output_tokens\": 16384, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"anthropic-sanitized-v1\", \"route_policy_revision\": 1, \"billing_class\": \"metered-third-party-blocked\", \"billing_route_class\": \"third-party-metered-blocked\", \"auth_class\": \"api-key\", \"auth_source\": \"stored\", \"qualification_state\": \"blocked-live-certification\", \"assignment_sha256\": \"sha256:8fb792b490cd6339142c17bee1fd8bccb5f82217514fe449812910a2402a9217\"}], \"capability_summary\": {\"min_context_window\": 100000, \"min_max_output_tokens\": 16384, \"input_modalities\": [\"image\", \"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, \"billing_summary\": {\"billing_class\": \"metered-third-party-blocked\", \"billing_route_class\": \"third-party-metered-blocked\", \"route_policy_ids\": [\"anthropic-sanitized-v1\"], \"service_tiers\": [null]}, \"auth_summary\": {\"auth_classes\": [\"api-key\"], \"auth_sources\": [\"stored\"], \"secret_fields_present\": false}, \"certification_manifest_id\": null, \"certification_manifest_sha256\": null, \"created_at\": \"2026-07-22T00:00:00.000Z\", \"roster_sha256\": \"sha256:15592a2eb13b6a89b89bbdb56193baed9cd14617457dcd510f45064802038a1e\"}, {\"schema_version\": \"autopilot.roster.v1\", \"roster_id\": \"precision-codex-subscription-bdb4f15f0ff9\", \"roster_revision\": 1, \"display_name\": \"Precision seed \\u2014 codex-subscription\", \"scope\": \"user\", \"selected_scope\": \"user\", \"profile_id\": \"precision\", \"recipe_id\": \"codex-subscription\", \"recipe_revision\": 1, \"generation_source\": \"w0-non-certifying-seed\", \"package_version\": \"1.3.0\", \"pi_version\": \"0.80.6\", \"route_policy_ids\": [\"codex-subscription-v1\"], \"assignment_set_sha256\": \"sha256:bdb4f15f0ff90aff9d1e46a3a56bfdfddabafcf3c7f5c293a7b558ff2f22a3c4\", \"assignments\": [{\"role\": \"parent\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:84f17adbb0637e61c3ba9e57e897aacccd819e9bd9528d92e14a3b8036f9e7cc\"}, {\"role\": \"strategy\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:60e16ca3a610903c20a488f69b46d9bb1c84247f3021f1e914de08d74067f3d7\"}, {\"role\": \"implement\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-terra\", \"model\": \"openai-codex/gpt-5.6-terra\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:00e29e2942321f72e2ca7a0af5425bd125880a8c591bac119ebab35d3c326e33\"}, {\"role\": \"validate\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:b4269a5a9acb9879d6797385f9b5bd8955ff5125d522578b787242979af45b9f\"}, {\"role\": \"fix\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-terra\", \"model\": \"openai-codex/gpt-5.6-terra\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:27a4fe4e430c9135fda0a2800d42b336b72a58f789719dc93ba0f92fbaf510e8\"}, {\"role\": \"adjudicate\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:ecca8ceb0fc080f88ddff78fa0660da5e22bd8f9dca6b75fbe52be13797c01f6\"}, {\"role\": \"bughunt\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-sol\", \"model\": \"openai-codex/gpt-5.6-sol\", \"api\": \"openai-codex-responses\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 512000, \"max_output_tokens\": 65536, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:418e5a6f3c72a90dd5fb6734348375f659aed62ef52cc9063dbd4f43342d4a27\"}, {\"role\": \"extract\", \"provider_id\": \"openai-codex\", \"model_id\": \"gpt-5.6-luna\", \"model\": \"openai-codex/gpt-5.6-luna\", \"api\": \"openai-codex-responses\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"auth_class\": \"oauth\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:8631fe6d02ca00c77a653348528449dcacb16b0b35b5f0c2d57492bf9ab209a1\"}], \"capability_summary\": {\"min_context_window\": 256000, \"min_max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, \"billing_summary\": {\"billing_class\": \"plan-backed-subscription\", \"billing_route_class\": \"subscription-oauth\", \"route_policy_ids\": [\"codex-subscription-v1\"], \"service_tiers\": [null]}, \"auth_summary\": {\"auth_classes\": [\"oauth\"], \"auth_sources\": [\"stored\"], \"secret_fields_present\": false}, \"certification_manifest_id\": null, \"certification_manifest_sha256\": null, \"created_at\": \"2026-07-22T00:00:00.000Z\", \"roster_sha256\": \"sha256:3cb35e9f63613f85e8d586a3de6fe7e418d3bb935f088651ec3300d63f82b7f9\"}, {\"schema_version\": \"autopilot.roster.v1\", \"roster_id\": \"precision-kimi-coding-plan-af83b830e2e6\", \"roster_revision\": 1, \"display_name\": \"Precision seed \\u2014 kimi-coding-plan\", \"scope\": \"user\", \"selected_scope\": \"user\", \"profile_id\": \"precision\", \"recipe_id\": \"kimi-coding-plan\", \"recipe_revision\": 1, \"generation_source\": \"w0-non-certifying-seed\", \"package_version\": \"1.3.0\", \"pi_version\": \"0.80.6\", \"route_policy_ids\": [\"kimi-coding-plan-v1\"], \"assignment_set_sha256\": \"sha256:af83b830e2e6f39fa4558c88f0e4260ee1253e64bd0f8602745fe86d394d96c4\", \"assignments\": [{\"role\": \"parent\", \"provider_id\": \"kimi-coding\", \"model_id\": \"kimi-k3\", \"model\": \"kimi-coding/kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"kimi-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:17b44344bba3cdce8cb58545e424453b8ab22d0c1c78a9d997a3cbf0838f86ab\"}, {\"role\": \"strategy\", \"provider_id\": \"kimi-coding\", \"model_id\": \"kimi-k3\", \"model\": \"kimi-coding/kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"kimi-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:dc56e3f05e2cb7ac4352a6bf27ec24aeffb2c9dfb7a1c6156c74fbedcc74fc4e\"}, {\"role\": \"implement\", \"provider_id\": \"kimi-coding\", \"model_id\": \"kimi-for-coding\", \"model\": \"kimi-coding/kimi-for-coding\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"kimi-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:cf83f861142532e5408de79dbfaeef6d9c8941c26ec2df77dd8673fcfb1456dc\"}, {\"role\": \"validate\", \"provider_id\": \"kimi-coding\", \"model_id\": \"kimi-k3\", \"model\": \"kimi-coding/kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"kimi-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:a14d1c30e1e78a31ea0d252509c9361ec55220061d797f6261a4f24e16eddf44\"}, {\"role\": \"fix\", \"provider_id\": \"kimi-coding\", \"model_id\": \"kimi-for-coding\", \"model\": \"kimi-coding/kimi-for-coding\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"kimi-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:72d29f1838cc3565d9c5b2903bb1a66181d64183b4e92dbc45063171beec8ba5\"}, {\"role\": \"adjudicate\", \"provider_id\": \"kimi-coding\", \"model_id\": \"kimi-k3\", \"model\": \"kimi-coding/kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"kimi-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:4bff14e082d503114055fd9163c72b70998ae9f6173225fae5860ae896b18778\"}, {\"role\": \"bughunt\", \"provider_id\": \"kimi-coding\", \"model_id\": \"kimi-k3\", \"model\": \"kimi-coding/kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"kimi-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:a9f07eb3c0819ae419b2ef41fd51e0c7ea92092883672c9a6c00ec0b4d65ea44\"}, {\"role\": \"extract\", \"provider_id\": \"kimi-coding\", \"model_id\": \"kimi-for-coding-highspeed\", \"model\": \"kimi-coding/kimi-for-coding-highspeed\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 128000, \"max_output_tokens\": 16384, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"kimi-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:ec0d9e5f9da88d09015c4f51bd59ef596ba771133c7023df68bb846b1f62b2ee\"}], \"capability_summary\": {\"min_context_window\": 128000, \"min_max_output_tokens\": 16384, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, \"billing_summary\": {\"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"route_policy_ids\": [\"kimi-coding-plan-v1\"], \"service_tiers\": [null]}, \"auth_summary\": {\"auth_classes\": [\"api-key-plan-token\"], \"auth_sources\": [\"stored\"], \"secret_fields_present\": false}, \"certification_manifest_id\": null, \"certification_manifest_sha256\": null, \"created_at\": \"2026-07-22T00:00:00.000Z\", \"roster_sha256\": \"sha256:669061f5e1a419552c9b43f03e4ca4ca28f238b60283113d54f52000ef164a77\"}, {\"schema_version\": \"autopilot.roster.v1\", \"roster_id\": \"precision-opencode-go-plan-b41a3cb01adc\", \"roster_revision\": 1, \"display_name\": \"Precision seed \\u2014 opencode-go-plan\", \"scope\": \"user\", \"selected_scope\": \"user\", \"profile_id\": \"precision\", \"recipe_id\": \"opencode-go-plan\", \"recipe_revision\": 1, \"generation_source\": \"w0-non-certifying-seed\", \"package_version\": \"1.3.0\", \"pi_version\": \"0.80.6\", \"route_policy_ids\": [\"opencode-go-plan-v1\"], \"assignment_set_sha256\": \"sha256:b41a3cb01adcd2698fd58b49484898b1446650537c9fe7b09648fc8b08c6e00a\", \"assignments\": [{\"role\": \"parent\", \"provider_id\": \"opencode-go\", \"model_id\": \"kimi-k3\", \"model\": \"opencode-go/kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"opencode-go-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:e033eab1c8223da84a36ce0032d035ed112b6607d13ea25861802e074af0d082\"}, {\"role\": \"strategy\", \"provider_id\": \"opencode-go\", \"model_id\": \"kimi-k3\", \"model\": \"opencode-go/kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"opencode-go-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:cf53e80581c3cebbe75d6fd220db088b5bf2e315ba67c5af4102a44f6c265e9a\"}, {\"role\": \"implement\", \"provider_id\": \"opencode-go\", \"model_id\": \"kimi-k2.7-code\", \"model\": \"opencode-go/kimi-k2.7-code\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"opencode-go-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:f0667d9345e0dc6ddc4a798805206a343871a5de9bd6ae1d2dc683716b34e435\"}, {\"role\": \"validate\", \"provider_id\": \"opencode-go\", \"model_id\": \"kimi-k3\", \"model\": \"opencode-go/kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"opencode-go-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:edf4e136035f443104a8e8c36cb689bb3c2e68471a94883c46dbfd0cd32f2e0e\"}, {\"role\": \"fix\", \"provider_id\": \"opencode-go\", \"model_id\": \"kimi-k2.7-code\", \"model\": \"opencode-go/kimi-k2.7-code\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"opencode-go-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:ff3bd32358bdfe3529f101642e37c0adf165ed121b79cc46c9f22635bfc4202c\"}, {\"role\": \"adjudicate\", \"provider_id\": \"opencode-go\", \"model_id\": \"kimi-k3\", \"model\": \"opencode-go/kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"opencode-go-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:9cf24f7735c6552cdf3529eec21c8c4e96054adae242e6c6fe628526f737f6f8\"}, {\"role\": \"bughunt\", \"provider_id\": \"opencode-go\", \"model_id\": \"kimi-k3\", \"model\": \"opencode-go/kimi-k3\", \"api\": \"openai-completions\", \"thinking\": \"xhigh\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"opencode-go-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:5b680337bae7e7bc7b70d434249f475d8f879dc05c9c3b7f0f5c5ae7946a2b71\"}, {\"role\": \"extract\", \"provider_id\": \"opencode-go\", \"model_id\": \"deepseek-v4-flash\", \"model\": \"opencode-go/deepseek-v4-flash\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 128000, \"max_output_tokens\": 16384, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"opencode-go-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:c557e1de47d53df65b8c4922e8f43c216ab757644b88e731758c697a044736f8\"}], \"capability_summary\": {\"min_context_window\": 128000, \"min_max_output_tokens\": 16384, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, \"billing_summary\": {\"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"route_policy_ids\": [\"opencode-go-plan-v1\"], \"service_tiers\": [null]}, \"auth_summary\": {\"auth_classes\": [\"api-key-plan-token\"], \"auth_sources\": [\"stored\"], \"secret_fields_present\": false}, \"certification_manifest_id\": null, \"certification_manifest_sha256\": null, \"created_at\": \"2026-07-22T00:00:00.000Z\", \"roster_sha256\": \"sha256:132f02106fab13bd2c95812b4f26991c5cf3b23efb9dadeaa684e4c0728bdb07\"}, {\"schema_version\": \"autopilot.roster.v1\", \"roster_id\": \"precision-zai-coding-plan-3e1073d30a26\", \"roster_revision\": 1, \"display_name\": \"Precision seed \\u2014 zai-coding-plan\", \"scope\": \"user\", \"selected_scope\": \"user\", \"profile_id\": \"precision\", \"recipe_id\": \"zai-coding-plan\", \"recipe_revision\": 1, \"generation_source\": \"w0-non-certifying-seed\", \"package_version\": \"1.3.0\", \"pi_version\": \"0.80.6\", \"route_policy_ids\": [\"zai-coding-plan-v1\"], \"assignment_set_sha256\": \"sha256:3e1073d30a26616a4a0ad3446d0b9719ff2ed93dd0981e08e0f9760ef0d2eaf8\", \"assignments\": [{\"role\": \"parent\", \"provider_id\": \"zai\", \"model_id\": \"glm-5.2\", \"model\": \"zai/glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"zai-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:675db114cff31ed404160f0af4e2beb62fefad89fb6f4035c9be3f213fe401ce\"}, {\"role\": \"strategy\", \"provider_id\": \"zai\", \"model_id\": \"glm-5.2\", \"model\": \"zai/glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"zai-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:3103213773393c8fca682a3a562dad5c3853184e190a2647cb920958e81ca015\"}, {\"role\": \"implement\", \"provider_id\": \"zai\", \"model_id\": \"glm-5.2\", \"model\": \"zai/glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"zai-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:a49215d875156d684306b61ed102e11ce9fffc5218550db8bc587774e49341f3\"}, {\"role\": \"validate\", \"provider_id\": \"zai\", \"model_id\": \"glm-5.2\", \"model\": \"zai/glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"zai-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:62a61bb0bcf4502c0175ed57828d3194a8ee1e374453b21fa22200042f24ff9f\"}, {\"role\": \"fix\", \"provider_id\": \"zai\", \"model_id\": \"glm-5.2\", \"model\": \"zai/glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"zai-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:16b4dfd81c10200c271e83dcee70a3fa747cb32fc8d3fc811347de0bb88e4c82\"}, {\"role\": \"adjudicate\", \"provider_id\": \"zai\", \"model_id\": \"glm-5.2\", \"model\": \"zai/glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"zai-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:ed4a6219f3b4970ab208c6d091d84c9fbb4d31cff4106985a957a6e79a929202\"}, {\"role\": \"bughunt\", \"provider_id\": \"zai\", \"model_id\": \"glm-5.2\", \"model\": \"zai/glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"zai-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:898305681f9a55cca7da50c5d69fa3050afce0b280130993f48dd80d49a2bcaf\"}, {\"role\": \"extract\", \"provider_id\": \"zai\", \"model_id\": \"glm-5.2\", \"model\": \"zai/glm-5.2\", \"api\": \"openai-completions\", \"thinking\": \"high\", \"service_tier\": null, \"cache_policy\": \"provider-default\", \"system_prompt_profile\": \"pi-default.v1\", \"context_window\": 256000, \"max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\", \"route_policy_id\": \"zai-coding-plan-v1\", \"route_policy_revision\": 1, \"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"auth_class\": \"api-key-plan-token\", \"auth_source\": \"stored\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"assignment_sha256\": \"sha256:6df75fba2eb2fc01059f691bb099cb3e1acc626bc2ddc45f2b16268e0386ab2d\"}], \"capability_summary\": {\"min_context_window\": 256000, \"min_max_output_tokens\": 32768, \"input_modalities\": [\"text\"], \"output_modalities\": [\"text\"], \"reasoning_capability\": \"reasoning-supported\", \"tool_capability\": \"tool-use-supported\"}, \"billing_summary\": {\"billing_class\": \"plan-token\", \"billing_route_class\": \"plan-api-token\", \"route_policy_ids\": [\"zai-coding-plan-v1\"], \"service_tiers\": [null]}, \"auth_summary\": {\"auth_classes\": [\"api-key-plan-token\"], \"auth_sources\": [\"stored\"], \"secret_fields_present\": false}, \"certification_manifest_id\": null, \"certification_manifest_sha256\": null, \"created_at\": \"2026-07-22T00:00:00.000Z\", \"roster_sha256\": \"sha256:563ee93ee2abc26b71ee75dcea58da4a23791cdfc9fd230154fbb434ee68f0dd\"}]";
const SEED_CANDIDATES_JSON = "[{\"schema_version\": \"autopilot.roster_candidate.v1\", \"candidate_id\": \"codex-afterburner-v1\", \"candidate_sort_key\": \"afterburner:codex-subscription:0001:codex-afterburner-v1\", \"scope\": \"user\", \"profile_id\": \"afterburner\", \"recipe_id\": \"codex-subscription\", \"recipe_revision\": 1, \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"roster_id\": \"afterburner-codex-subscription-7814ccd19c58\", \"roster_revision\": 1, \"assignment_set_sha256\": \"sha256:7814ccd19c5807b001764c9a6a40f6d1e7e669c6fda29220c1f4e0e96c309e5d\", \"roster_sha256\": \"sha256:ba7d0cdd955589f24fb9afbb403057c8b5461fe9d62c8265b347ec7827578a85\", \"candidate_state\": \"qualification-required\", \"launch_readiness\": \"not-ready-until-w4\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"non_certifying_seed\": true, \"synthetic_fixture_ready_only\": false, \"converges_with\": null, \"diagnostic_codes\": [\"ROSTER_PRIORITY_PROOF_REQUIRED\", \"ROSTER_QUALIFICATION_REQUIRED\"], \"candidate_sha256\": \"sha256:76be6c15481412e1f440525c24e9b9a1e7a8861cd6fe7038ae9a65a6dd8e1eb9\"}, {\"schema_version\": \"autopilot.roster_candidate.v1\", \"candidate_id\": \"codex-cruise-v1\", \"candidate_sort_key\": \"cruise:codex-subscription:0001:codex-cruise-v1\", \"scope\": \"user\", \"profile_id\": \"cruise\", \"recipe_id\": \"codex-subscription\", \"recipe_revision\": 1, \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"roster_id\": \"cruise-codex-subscription-bdb4f15f0ff9\", \"roster_revision\": 1, \"assignment_set_sha256\": \"sha256:bdb4f15f0ff90aff9d1e46a3a56bfdfddabafcf3c7f5c293a7b558ff2f22a3c4\", \"roster_sha256\": \"sha256:f3ac0895d9abedfbe3616a79af0c1c3691962d24d5f17d195a78e6ab24d2b4a0\", \"candidate_state\": \"qualification-required\", \"launch_readiness\": \"not-ready-until-w4\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"non_certifying_seed\": true, \"synthetic_fixture_ready_only\": false, \"converges_with\": \"codex-precision-v1\", \"diagnostic_codes\": [\"ROSTER_CONVERGED_ASSIGNMENT_SET\", \"ROSTER_QUALIFICATION_REQUIRED\"], \"candidate_sha256\": \"sha256:a945f8534e6104e0a7d98e04e121ea367053e9b0755c412dca532c34cd816674\"}, {\"schema_version\": \"autopilot.roster_candidate.v1\", \"candidate_id\": \"anthropic-precision-v1\", \"candidate_sort_key\": \"precision:anthropic-sanitized:0001:anthropic-precision-v1\", \"scope\": \"user\", \"profile_id\": \"precision\", \"recipe_id\": \"anthropic-sanitized\", \"recipe_revision\": 1, \"route_policy_id\": \"anthropic-sanitized-v1\", \"route_policy_revision\": 1, \"roster_id\": \"precision-anthropic-sanitized-b7321cad3237\", \"roster_revision\": 1, \"assignment_set_sha256\": \"sha256:b7321cad32374c9299499d1edbb6f0f2038f4bc5fdee82b9af892cea47bdc724\", \"roster_sha256\": \"sha256:15592a2eb13b6a89b89bbdb56193baed9cd14617457dcd510f45064802038a1e\", \"candidate_state\": \"blocked-live-certification\", \"launch_readiness\": \"blocked\", \"qualification_state\": \"blocked-live-certification\", \"non_certifying_seed\": true, \"synthetic_fixture_ready_only\": false, \"converges_with\": null, \"diagnostic_codes\": [\"ROSTER_QUALIFICATION_REQUIRED\", \"ROSTER_ROUTE_FORBIDDEN\"], \"candidate_sha256\": \"sha256:ddedd4f4ef90faf865107574cf2818f8b9cef5fd6279dda76a73ec34de1466de\"}, {\"schema_version\": \"autopilot.roster_candidate.v1\", \"candidate_id\": \"codex-precision-v1\", \"candidate_sort_key\": \"precision:codex-subscription:0001:codex-precision-v1\", \"scope\": \"user\", \"profile_id\": \"precision\", \"recipe_id\": \"codex-subscription\", \"recipe_revision\": 1, \"route_policy_id\": \"codex-subscription-v1\", \"route_policy_revision\": 1, \"roster_id\": \"precision-codex-subscription-bdb4f15f0ff9\", \"roster_revision\": 1, \"assignment_set_sha256\": \"sha256:bdb4f15f0ff90aff9d1e46a3a56bfdfddabafcf3c7f5c293a7b558ff2f22a3c4\", \"roster_sha256\": \"sha256:3cb35e9f63613f85e8d586a3de6fe7e418d3bb935f088651ec3300d63f82b7f9\", \"candidate_state\": \"qualification-required\", \"launch_readiness\": \"not-ready-until-w4\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"non_certifying_seed\": true, \"synthetic_fixture_ready_only\": false, \"converges_with\": null, \"diagnostic_codes\": [\"ROSTER_QUALIFICATION_REQUIRED\"], \"candidate_sha256\": \"sha256:cceb419b612573b1bd6fee0a9a1d2925610b5d3e01222f8c5c7c22ff5b77bc12\"}, {\"schema_version\": \"autopilot.roster_candidate.v1\", \"candidate_id\": \"kimi-coding-precision-v1\", \"candidate_sort_key\": \"precision:kimi-coding-plan:0001:kimi-coding-precision-v1\", \"scope\": \"user\", \"profile_id\": \"precision\", \"recipe_id\": \"kimi-coding-plan\", \"recipe_revision\": 1, \"route_policy_id\": \"kimi-coding-plan-v1\", \"route_policy_revision\": 1, \"roster_id\": \"precision-kimi-coding-plan-af83b830e2e6\", \"roster_revision\": 1, \"assignment_set_sha256\": \"sha256:af83b830e2e6f39fa4558c88f0e4260ee1253e64bd0f8602745fe86d394d96c4\", \"roster_sha256\": \"sha256:669061f5e1a419552c9b43f03e4ca4ca28f238b60283113d54f52000ef164a77\", \"candidate_state\": \"qualification-required\", \"launch_readiness\": \"not-ready-until-w4\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"non_certifying_seed\": true, \"synthetic_fixture_ready_only\": false, \"converges_with\": null, \"diagnostic_codes\": [\"ROSTER_QUALIFICATION_REQUIRED\"], \"candidate_sha256\": \"sha256:126eb6bc872047a1b8d441ddaa31ca09831366bc999a91a09f26d52424ed2544\"}, {\"schema_version\": \"autopilot.roster_candidate.v1\", \"candidate_id\": \"opencode-go-precision-v1\", \"candidate_sort_key\": \"precision:opencode-go-plan:0001:opencode-go-precision-v1\", \"scope\": \"user\", \"profile_id\": \"precision\", \"recipe_id\": \"opencode-go-plan\", \"recipe_revision\": 1, \"route_policy_id\": \"opencode-go-plan-v1\", \"route_policy_revision\": 1, \"roster_id\": \"precision-opencode-go-plan-b41a3cb01adc\", \"roster_revision\": 1, \"assignment_set_sha256\": \"sha256:b41a3cb01adcd2698fd58b49484898b1446650537c9fe7b09648fc8b08c6e00a\", \"roster_sha256\": \"sha256:132f02106fab13bd2c95812b4f26991c5cf3b23efb9dadeaa684e4c0728bdb07\", \"candidate_state\": \"qualification-required\", \"launch_readiness\": \"not-ready-until-w4\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"non_certifying_seed\": true, \"synthetic_fixture_ready_only\": false, \"converges_with\": null, \"diagnostic_codes\": [\"ROSTER_QUALIFICATION_REQUIRED\"], \"candidate_sha256\": \"sha256:f09d20f9e654ac94a345f07becc060084b937c4c21fa8d1465112c22cc160ac8\"}, {\"schema_version\": \"autopilot.roster_candidate.v1\", \"candidate_id\": \"zai-precision-v1\", \"candidate_sort_key\": \"precision:zai-coding-plan:0001:zai-precision-v1\", \"scope\": \"user\", \"profile_id\": \"precision\", \"recipe_id\": \"zai-coding-plan\", \"recipe_revision\": 1, \"route_policy_id\": \"zai-coding-plan-v1\", \"route_policy_revision\": 1, \"roster_id\": \"precision-zai-coding-plan-3e1073d30a26\", \"roster_revision\": 1, \"assignment_set_sha256\": \"sha256:3e1073d30a26616a4a0ad3446d0b9719ff2ed93dd0981e08e0f9760ef0d2eaf8\", \"roster_sha256\": \"sha256:563ee93ee2abc26b71ee75dcea58da4a23791cdfc9fd230154fbb434ee68f0dd\", \"candidate_state\": \"qualification-required\", \"launch_readiness\": \"not-ready-until-w4\", \"qualification_state\": \"unqualified-non-certifying-seed\", \"non_certifying_seed\": true, \"synthetic_fixture_ready_only\": false, \"converges_with\": null, \"diagnostic_codes\": [\"ROSTER_QUALIFICATION_REQUIRED\"], \"candidate_sha256\": \"sha256:a722c99c87116a3bd0facee6ea48c06b5c1d7e49c3f123466b72f15e9e7581aa\"}]";
export const PROVIDER_RECIPES = deepFreezeRecipeAuthority(JSON.parse(PROVIDER_RECIPES_JSON));
export const SEED_ROSTERS = deepFreezeRecipeAuthority(JSON.parse(SEED_ROSTERS_JSON));
export const SEED_CANDIDATES = deepFreezeRecipeAuthority(JSON.parse(SEED_CANDIDATES_JSON));
export function providerRecipeSortKey(recipe) {
    return `${recipe.recipe_id}:${String(recipe.recipe_revision).padStart(10, '0')}`;
}
export function sortProviderRecipes(recipes) {
    return [...recipes].sort((left, right) => providerRecipeSortKey(left).localeCompare(providerRecipeSortKey(right)));
}
export function computeProviderRecipeRegistry(recipes = PROVIDER_RECIPES) {
    const registryEntries = sortProviderRecipes(recipes).map((recipe) => ({
        recipe_id: recipe.recipe_id,
        recipe_revision: recipe.recipe_revision,
        recipe_sha256: recipe.recipe_sha256,
    }));
    const preimage = {
        schema_version: 'autopilot.provider_recipe_registry.v1',
        freeze_id: PHASE37_FREEZE_ID,
        recipes: registryEntries,
    };
    return { ...preimage, recipe_registry_sha256: canonicalSha256(preimage) };
}
export const PROVIDER_RECIPE_REGISTRY = deepFreezeRecipeAuthority(computeProviderRecipeRegistry());
export const PROVIDER_RECIPE_REGISTRY_SHA256 = PROVIDER_RECIPE_REGISTRY.recipe_registry_sha256;
export function sortRosterCandidates(candidates) {
    const sorted = [...candidates].sort((left, right) => left.candidate_sort_key.localeCompare(right.candidate_sort_key));
    for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index - 1].candidate_sort_key === sorted[index].candidate_sort_key) {
            throw new Error(`duplicate candidate sort key ${sorted[index].candidate_sort_key}`);
        }
    }
    return sorted;
}
export function computeSeedCandidateRegistry(candidates = SEED_CANDIDATES) {
    const entries = sortRosterCandidates(candidates).map((candidate) => ({
        candidate_id: candidate.candidate_id,
        candidate_sort_key: candidate.candidate_sort_key,
        candidate_sha256: candidate.candidate_sha256,
    }));
    const preimage = {
        schema_version: 'autopilot.seed_candidate_registry.v1',
        freeze_id: PHASE37_FREEZE_ID,
        candidates: entries,
    };
    return { ...preimage, candidate_registry_sha256: canonicalSha256(preimage) };
}
export const SEED_CANDIDATE_REGISTRY = deepFreezeRecipeAuthority(computeSeedCandidateRegistry());
export const SEED_CANDIDATE_REGISTRY_SHA256 = SEED_CANDIDATE_REGISTRY.candidate_registry_sha256;
const SEED_CANDIDATE_BY_RECIPE_PROFILE = new Map(SEED_CANDIDATES.map((candidate) => [
    `${candidate.recipe_id}:${candidate.recipe_revision}:${candidate.profile_id}`,
    candidate,
]));
export function getProviderRecipe(recipeId, recipeRevision, recipes = PROVIDER_RECIPES) {
    return recipes.find((recipe) => recipe.recipe_id === recipeId && recipe.recipe_revision === recipeRevision) ?? null;
}
export function getProfileTemplate(recipe, profileId) {
    return recipe.profile_templates.find((profile) => profile.profile_id === profileId) ?? null;
}
export function verifyProviderRecipeSeeds(recipes = PROVIDER_RECIPES, routePolicies = ROUTE_POLICIES) {
    const issues = [];
    const seen = new Set();
    for (const recipe of sortProviderRecipes(recipes)) {
        const identity = `${recipe.recipe_id}@${recipe.recipe_revision}`;
        if (seen.has(identity)) {
            issues.push(`duplicate provider recipe ${identity}`);
        }
        seen.add(identity);
        const expectedRecipeHash = hashObjectOmitting(recipe, 'recipe_sha256');
        if (expectedRecipeHash !== recipe.recipe_sha256) {
            issues.push(`${identity} hash mismatch: expected ${expectedRecipeHash}, found ${recipe.recipe_sha256}`);
        }
        if (recipe.non_certifying_seed !== true) {
            issues.push(`${identity} must remain a non-certifying seed`);
        }
        if (recipe.recipe_state === 'synthetic-fixture-ready' || recipe.qualification_state === 'synthetic-test-ready') {
            issues.push(`${identity} seed must not be launch-ready`);
        }
        const policy = findRoutePolicy(recipe.route_policy_id, recipe.route_policy_revision, routePolicies);
        if (policy === null) {
            issues.push(`${identity} references missing route policy ${recipe.route_policy_id}@${recipe.route_policy_revision}`);
        }
        else if (policy.provider_id !== recipe.provider_family) {
            issues.push(`${identity} provider_family must match direct route policy provider_id`);
        }
        issues.push(...validateProfileTemplates(recipe));
    }
    const registry = computeProviderRecipeRegistry(recipes);
    if (recipes === PROVIDER_RECIPES && registry.recipe_registry_sha256 !== PROVIDER_RECIPE_REGISTRY_SHA256) {
        issues.push(`provider recipe registry hash mismatch: expected ${PROVIDER_RECIPE_REGISTRY_SHA256}, found ${registry.recipe_registry_sha256}`);
    }
    return issues;
}
export function verifySeedCandidateRegistry(candidates = SEED_CANDIDATES) {
    const issues = [];
    const seen = new Set();
    for (const candidate of sortRosterCandidates(candidates)) {
        const identity = `${candidate.candidate_id}`;
        if (seen.has(identity)) {
            issues.push(`duplicate seed candidate ${identity}`);
        }
        seen.add(identity);
        const expected = hashObjectOmitting(candidate, 'candidate_sha256');
        if (expected !== candidate.candidate_sha256) {
            issues.push(`${identity} hash mismatch: expected ${expected}, found ${candidate.candidate_sha256}`);
        }
        const recipe = getProviderRecipe(candidate.recipe_id, candidate.recipe_revision);
        if (recipe === null) {
            issues.push(`${identity} references missing recipe ${candidate.recipe_id}@${candidate.recipe_revision}`);
        }
        else {
            const profile = getProfileTemplate(recipe, candidate.profile_id);
            if (profile === null) {
                issues.push(`${identity} references missing profile ${candidate.profile_id}`);
            }
            if (recipe.route_policy_id !== candidate.route_policy_id || recipe.route_policy_revision !== candidate.route_policy_revision) {
                issues.push(`${identity} route reference must match direct recipe route reference`);
            }
        }
        if (candidate.launch_readiness === 'synthetic-fixture-only' || candidate.synthetic_fixture_ready_only) {
            issues.push(`${identity} production seed must not be synthetic ready`);
        }
    }
    const registry = computeSeedCandidateRegistry(candidates);
    if (candidates === SEED_CANDIDATES && registry.candidate_registry_sha256 !== SEED_CANDIDATE_REGISTRY_SHA256) {
        issues.push(`seed candidate registry hash mismatch: expected ${SEED_CANDIDATE_REGISTRY_SHA256}, found ${registry.candidate_registry_sha256}`);
    }
    return issues;
}
function validateProfileTemplates(recipe) {
    const issues = [];
    const seenProfiles = new Set();
    const sortedProfiles = [...recipe.profile_templates].sort((left, right) => left.profile_id.localeCompare(right.profile_id));
    if (JSON.stringify(sortedProfiles.map((profile) => profile.profile_id)) !== JSON.stringify(recipe.profile_templates.map((profile) => profile.profile_id))) {
        issues.push(`${recipe.recipe_id}@${recipe.recipe_revision} profiles must be sorted by profile_id`);
    }
    for (const profile of recipe.profile_templates) {
        if (!isRosterProfileId(profile.profile_id)) {
            issues.push(`${recipe.recipe_id}@${recipe.recipe_revision} has unknown profile ${profile.profile_id}`);
        }
        if (seenProfiles.has(profile.profile_id)) {
            issues.push(`${recipe.recipe_id}@${recipe.recipe_revision} duplicates profile ${profile.profile_id}`);
        }
        seenProfiles.add(profile.profile_id);
        if (profile.route_policy_id !== recipe.route_policy_id || profile.route_policy_revision !== recipe.route_policy_revision) {
            issues.push(`${recipe.recipe_id}@${recipe.recipe_revision}/${profile.profile_id} must directly reference the recipe route policy`);
        }
        issues.push(...validateRoleTemplates(recipe, profile));
    }
    return issues;
}
function validateRoleTemplates(recipe, profile) {
    const issues = [];
    const actualRoles = profile.role_templates.map((role) => role.role);
    const expectedRoles = [...ROSTER_ROLE_ORDER];
    if (actualRoles.length !== expectedRoles.length) {
        issues.push(`${recipe.recipe_id}@${recipe.recipe_revision}/${profile.profile_id} must contain exactly ${expectedRoles.length} role templates`);
    }
    for (let index = 0; index < expectedRoles.length; index += 1) {
        if (actualRoles[index] !== expectedRoles[index]) {
            issues.push(`${recipe.recipe_id}@${recipe.recipe_revision}/${profile.profile_id} role order mismatch at ${index}: expected ${expectedRoles[index]}, found ${actualRoles[index] ?? '<missing>'}`);
        }
    }
    const unique = new Set(actualRoles);
    if (unique.size !== actualRoles.length) {
        issues.push(`${recipe.recipe_id}@${recipe.recipe_revision}/${profile.profile_id} duplicates a role template`);
    }
    for (const roleTemplate of profile.role_templates) {
        if (!isRosterRole(roleTemplate.role)) {
            issues.push(`${recipe.recipe_id}@${recipe.recipe_revision}/${profile.profile_id} has unknown role ${roleTemplate.role}`);
        }
    }
    return issues;
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
function uniqueSortedStrings(values) {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function uniqueSortedServiceTiers(values) {
    return [...new Set(values)].sort(compareNullableStrings);
}
function hasAll(available, required) {
    return required.every((item) => available.includes(item));
}
function modelSatisfiesTemplate(model, template) {
    return (model.model_id === template.model_id &&
        model.api === template.api &&
        model.context_window >= template.context_window &&
        model.max_output_tokens >= template.max_output_tokens &&
        hasAll(model.input_modalities, template.input_modalities) &&
        hasAll(model.output_modalities, template.output_modalities) &&
        model.reasoning_capability === template.reasoning_capability &&
        model.tool_capability === template.tool_capability &&
        model.thinking_values.includes(template.thinking) &&
        model.service_tiers.some((tier) => tier === template.service_tier) &&
        model.cache_policies.includes(template.cache_policy) &&
        model.system_prompt_profiles.includes(template.system_prompt_profile));
}
export function validateInventoryForProfile(inventory, recipe, profile, routePolicy, routePolicies) {
    const diagnostics = [];
    if (!inventory.project_trusted) {
        diagnostics.push('ROSTER_PROJECT_UNTRUSTED');
    }
    const provider = findInventoryProvider(inventory, routePolicy.provider_id);
    if (provider === null) {
        diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
        return dedupeDiagnostics(diagnostics);
    }
    const routeResult = resolveRoute({
        schema_version: 'autopilot.route_resolution_request.v1',
        provider_id: provider.provider_id,
        api: routePolicy.allowed_apis[0],
        auth_class: authClassForRoute(provider),
        auth_source: authSourceForRoute(provider),
        project_trusted: inventory.project_trusted,
    }, routePolicies);
    diagnostics.push(...routeResult.diagnostics.map((diagnostic) => diagnostic.code));
    if (provider.billing_route_class !== routePolicy.billing_route_class) {
        diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
    }
    for (const roleTemplate of profile.role_templates) {
        const model = findInventoryModel(provider, roleTemplate.model_id, roleTemplate.api);
        if (model === null || !modelSatisfiesTemplate(model, roleTemplate)) {
            diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
        }
        diagnostics.push(...validateRouteConformance({
            provider_id: routePolicy.provider_id,
            api: roleTemplate.api,
            auth_class: authClassForRoute(provider),
            auth_source: authSourceForRoute(provider),
            billing_class: routePolicy.billing_class,
            billing_route_class: routePolicy.billing_route_class,
            service_tier: roleTemplate.service_tier,
            cache_policy: roleTemplate.cache_policy,
            system_prompt_profile: roleTemplate.system_prompt_profile,
            route_policy_id: routePolicy.route_policy_id,
            route_policy_revision: routePolicy.revision,
        }, routePolicies).map((diagnostic) => diagnostic.code));
    }
    const structureIssues = validateRoleTemplates(recipe, profile);
    if (structureIssues.length > 0) {
        diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
    }
    return dedupeDiagnostics(diagnostics);
}
export function assignmentSetSha256(assignments) {
    const sorted = sortAssignmentsByRole(assignments);
    const roles = sorted.map((assignment) => assignment.role);
    if (JSON.stringify(roles) !== JSON.stringify(ROSTER_ROLE_ORDER)) {
        throw new Error(`assignment set must cover ROLE_ORDER exactly; found ${roles.join(',')}`);
    }
    const preimage = {
        schema_version: 'autopilot.assignment_set.v1',
        role_order: ROSTER_ROLE_ORDER,
        assignment_sha256s: sorted.map((assignment) => assignment.assignment_sha256),
    };
    return canonicalSha256(preimage);
}
export function sortAssignmentsByRole(assignments) {
    const sorted = [...assignments].sort((left, right) => roleSortIndex(left.role) - roleSortIndex(right.role));
    for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index - 1].role === sorted[index].role) {
            throw new Error(`duplicate assignment role ${sorted[index].role}`);
        }
    }
    return sorted;
}
export function buildAssignment(roleTemplate, routePolicy, provider, routePolicies) {
    const withoutHash = {
        role: roleTemplate.role,
        provider_id: routePolicy.provider_id,
        model_id: roleTemplate.model_id,
        model: `${routePolicy.provider_id}/${roleTemplate.model_id}`,
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
        route_policy_id: routePolicy.route_policy_id,
        route_policy_revision: routePolicy.revision,
        billing_class: routePolicy.billing_class,
        billing_route_class: routePolicy.billing_route_class,
        auth_class: authClassForRoute(provider),
        auth_source: authSourceForRoute(provider),
        qualification_state: routePolicy.qualification_state,
    };
    const assignment = {
        ...withoutHash,
        assignment_sha256: canonicalSha256(withoutHash),
    };
    const routeDiagnostics = validateRouteConformance(assignment, routePolicies);
    if (routeDiagnostics.length > 0) {
        throw new Error(`assignment ${assignment.role} does not conform to route policy: ${routeDiagnostics.map((diagnostic) => diagnostic.code).join(',')}`);
    }
    return assignment;
}
function displayNameForProfile(profileId, recipeId) {
    const displayProfile = profileId.charAt(0).toUpperCase() + profileId.slice(1);
    return `${displayProfile} seed — ${recipeId}`;
}
function summarizeCapabilities(assignments) {
    const sorted = sortAssignmentsByRole(assignments);
    const inputIntersection = sorted.reduce((current, assignment) => {
        if (current === null) {
            return assignment.input_modalities;
        }
        return current.filter((modality) => assignment.input_modalities.includes(modality));
    }, null);
    const outputIntersection = sorted.reduce((current, assignment) => {
        if (current === null) {
            return assignment.output_modalities;
        }
        return current.filter((modality) => assignment.output_modalities.includes(modality));
    }, null);
    return {
        min_context_window: Math.min(...sorted.map((assignment) => assignment.context_window)),
        min_max_output_tokens: Math.min(...sorted.map((assignment) => assignment.max_output_tokens)),
        input_modalities: uniqueSortedStrings(inputIntersection ?? []),
        output_modalities: uniqueSortedStrings(outputIntersection ?? []),
        reasoning_capability: sorted.every((assignment) => assignment.reasoning_capability === 'reasoning-supported')
            ? 'reasoning-supported'
            : 'reasoning-unsupported',
        tool_capability: sorted.every((assignment) => assignment.tool_capability === 'tool-use-supported')
            ? 'tool-use-supported'
            : 'tool-use-unsupported',
    };
}
function summarizeBilling(assignments) {
    const sorted = sortAssignmentsByRole(assignments);
    const first = sorted[0];
    if (first === undefined) {
        throw new Error('cannot summarize empty assignment set');
    }
    if (!sorted.every((assignment) => assignment.billing_class === first.billing_class && assignment.billing_route_class === first.billing_route_class)) {
        throw new Error('mixed billing routes are forbidden');
    }
    return {
        billing_class: first.billing_class,
        billing_route_class: first.billing_route_class,
        route_policy_ids: uniqueSortedStrings(sorted.map((assignment) => assignment.route_policy_id)),
        service_tiers: uniqueSortedServiceTiers(sorted.map((assignment) => assignment.service_tier)),
    };
}
function summarizeAuth(assignments) {
    const sorted = sortAssignmentsByRole(assignments);
    return {
        auth_classes: uniqueSortedStrings(sorted.map((assignment) => assignment.auth_class)),
        auth_sources: uniqueSortedStrings(sorted.map((assignment) => assignment.auth_source)),
        secret_fields_present: false,
    };
}
export function buildRosterFromRecipe(options) {
    const assignments = sortAssignmentsByRole(options.profile.role_templates.map((roleTemplate) => buildAssignment(roleTemplate, options.routePolicy, options.provider, options.routePolicies)));
    const assignment_set_sha256 = assignmentSetSha256(assignments);
    const roster_id = `${options.profile.profile_id}-${options.recipe.recipe_id}-${assignment_set_sha256.slice('sha256:'.length, 'sha256:'.length + 12)}`;
    const withoutHash = {
        schema_version: 'autopilot.roster.v1',
        roster_id,
        roster_revision: 1,
        display_name: displayNameForProfile(options.profile.profile_id, options.recipe.recipe_id),
        scope: options.scope,
        selected_scope: options.scope,
        profile_id: options.profile.profile_id,
        recipe_id: options.recipe.recipe_id,
        recipe_revision: options.recipe.recipe_revision,
        generation_source: 'w0-non-certifying-seed',
        package_version: PHASE37_PACKAGE_VERSION,
        pi_version: PHASE37_PI_VERSION,
        route_policy_ids: uniqueSortedStrings(assignments.map((assignment) => assignment.route_policy_id)),
        assignment_set_sha256,
        assignments,
        capability_summary: summarizeCapabilities(assignments),
        billing_summary: summarizeBilling(assignments),
        auth_summary: summarizeAuth(assignments),
        certification_manifest_id: options.recipe.certification_manifest_id,
        certification_manifest_sha256: options.recipe.certification_manifest_sha256,
        created_at: options.created_at ?? PHASE37_W0_SEED_CREATED_AT,
    };
    return { ...withoutHash, roster_sha256: canonicalSha256(withoutHash) };
}
function readinessForCandidate(recipe, profile, routePolicy, qualificationManifest) {
    if (routePolicy.policy_state === 'blocked-live-certification' || recipe.recipe_state === 'blocked-live-certification') {
        return {
            candidate_state: 'blocked-live-certification',
            launch_readiness: 'blocked',
            qualification_state: 'blocked-live-certification',
            synthetic_fixture_ready_only: false,
            diagnostic_codes: ['ROSTER_QUALIFICATION_REQUIRED', 'ROSTER_ROUTE_FORBIDDEN'],
        };
    }
    void qualificationManifest;
    const priorityProofRequired = profile.role_templates.some((roleTemplate) => roleTemplate.service_tier === 'priority');
    return {
        candidate_state: 'qualification-required',
        launch_readiness: 'not-ready-until-w4',
        qualification_state: 'unqualified-non-certifying-seed',
        synthetic_fixture_ready_only: false,
        diagnostic_codes: priorityProofRequired
            ? ['ROSTER_PRIORITY_PROOF_REQUIRED', 'ROSTER_QUALIFICATION_REQUIRED']
            : ['ROSTER_QUALIFICATION_REQUIRED'],
    };
}
function seedCandidateFor(recipe, profile) {
    return SEED_CANDIDATE_BY_RECIPE_PROFILE.get(`${recipe.recipe_id}:${recipe.recipe_revision}:${profile.profile_id}`) ?? null;
}
function materializeCandidate(recipe, profile, routePolicy, roster, qualificationManifest) {
    const seed = seedCandidateFor(recipe, profile);
    const readiness = readinessForCandidate(recipe, profile, routePolicy, qualificationManifest);
    const withoutHash = {
        schema_version: 'autopilot.roster_candidate.v1',
        candidate_id: seed?.candidate_id ?? `${profile.profile_id}-${recipe.recipe_id}-v${recipe.recipe_revision}`,
        candidate_sort_key: seed?.candidate_sort_key ?? `${profile.profile_id}:${recipe.recipe_id}:${String(recipe.recipe_revision).padStart(4, '0')}:${profile.profile_id}-${recipe.recipe_id}-v${recipe.recipe_revision}`,
        scope: roster.scope,
        profile_id: profile.profile_id,
        recipe_id: recipe.recipe_id,
        recipe_revision: recipe.recipe_revision,
        route_policy_id: routePolicy.route_policy_id,
        route_policy_revision: routePolicy.revision,
        roster_id: roster.roster_id,
        roster_revision: roster.roster_revision,
        assignment_set_sha256: roster.assignment_set_sha256,
        roster_sha256: roster.roster_sha256,
        candidate_state: readiness.candidate_state,
        launch_readiness: readiness.launch_readiness,
        qualification_state: readiness.qualification_state,
        non_certifying_seed: recipe.non_certifying_seed,
        synthetic_fixture_ready_only: readiness.synthetic_fixture_ready_only,
        converges_with: null,
        diagnostic_codes: readiness.diagnostic_codes,
    };
    return { ...withoutHash, candidate_sha256: canonicalSha256(withoutHash) };
}
function withCandidateDiagnostics(candidate, diagnostics, convergesWith = candidate.converges_with) {
    const diagnostic_codes = [...new Set(diagnostics)].sort((left, right) => left.localeCompare(right));
    const withoutHash = {
        schema_version: candidate.schema_version,
        candidate_id: candidate.candidate_id,
        candidate_sort_key: candidate.candidate_sort_key,
        scope: candidate.scope,
        profile_id: candidate.profile_id,
        recipe_id: candidate.recipe_id,
        recipe_revision: candidate.recipe_revision,
        route_policy_id: candidate.route_policy_id,
        route_policy_revision: candidate.route_policy_revision,
        roster_id: candidate.roster_id,
        roster_revision: candidate.roster_revision,
        assignment_set_sha256: candidate.assignment_set_sha256,
        roster_sha256: candidate.roster_sha256,
        candidate_state: candidate.candidate_state,
        launch_readiness: candidate.launch_readiness,
        qualification_state: candidate.qualification_state,
        non_certifying_seed: candidate.non_certifying_seed,
        synthetic_fixture_ready_only: candidate.synthetic_fixture_ready_only,
        converges_with: convergesWith,
        diagnostic_codes,
        ...(candidate.readiness_authority === undefined ? {} : { readiness_authority: candidate.readiness_authority }),
        ...(candidate.provider_pack_id === undefined ? {} : { provider_pack_id: candidate.provider_pack_id }),
        ...(candidate.certification_manifest_id === undefined ? {} : { certification_manifest_id: candidate.certification_manifest_id }),
        ...(candidate.certification_manifest_sha256 === undefined ? {} : { certification_manifest_sha256: candidate.certification_manifest_sha256 }),
        ...(candidate.recipe_sha256 === undefined ? {} : { recipe_sha256: candidate.recipe_sha256 }),
        ...(candidate.route_policy_sha256 === undefined ? {} : { route_policy_sha256: candidate.route_policy_sha256 }),
    };
    return { ...withoutHash, candidate_sha256: canonicalSha256(withoutHash) };
}
export function resolveRecipe(request, inventory, options = {}) {
    const recipes = options.recipes ?? PROVIDER_RECIPES;
    const routePolicies = options.routePolicies ?? ROUTE_POLICIES;
    const normalizedInventory = normalizeRosterInventory(inventory);
    const diagnostics = [];
    if (normalizedInventory.inventory_sha256 !== request.inventory_sha256) {
        diagnostics.push('ROSTER_APPROVAL_STALE_CANDIDATE_SET');
    }
    const recipe = getProviderRecipe(request.recipe_id, request.recipe_revision, recipes);
    if (recipe === null || !isRosterProfileId(request.profile_id)) {
        diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
        return materializeRecipeResult(false, null, diagnostics);
    }
    const profile = getProfileTemplate(recipe, request.profile_id);
    if (profile === null) {
        diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
        return materializeRecipeResult(false, null, diagnostics);
    }
    const routePolicy = findRoutePolicy(recipe.route_policy_id, recipe.route_policy_revision, routePolicies);
    if (routePolicy === null || profile.route_policy_id !== recipe.route_policy_id || profile.route_policy_revision !== recipe.route_policy_revision) {
        diagnostics.push('ROSTER_ROUTE_FORBIDDEN');
        return materializeRecipeResult(false, null, diagnostics);
    }
    const provider = findInventoryProvider(normalizedInventory, routePolicy.provider_id);
    diagnostics.push(...validateInventoryForProfile(normalizedInventory, recipe, profile, routePolicy, routePolicies).map((diagnostic) => diagnostic.code));
    if (provider === null || diagnostics.some((code) => code === 'ROSTER_AUTH_REQUIRED' || code === 'ROSTER_AUTH_CHANNEL_FORBIDDEN' || code === 'ROSTER_ROUTE_FORBIDDEN' || code === 'ROSTER_PROJECT_UNTRUSTED')) {
        return materializeRecipeResult(false, null, diagnostics);
    }
    const roster = buildRosterFromRecipe({
        recipe,
        profile,
        routePolicy,
        routePolicies,
        provider,
        scope: request.scope ?? 'user',
        created_at: request.created_at ?? PHASE37_W0_SEED_CREATED_AT,
    });
    const candidate = materializeCandidate(recipe, profile, routePolicy, roster, request.qualification_manifest);
    diagnostics.push(...candidate.diagnostic_codes);
    return materializeRecipeResult(true, candidate, diagnostics);
}
function materializeRecipeResult(resolved, candidate, diagnostics) {
    const preimage = {
        schema_version: 'autopilot.recipe_resolution_result.v1',
        resolved,
        candidate,
        diagnostics: dedupeDiagnostics(diagnostics),
    };
    return { ...preimage, result_sha256: canonicalSha256(preimage) };
}
function convergenceCanonical(candidates) {
    const profileOrder = ['precision', 'cruise', 'afterburner'];
    const sorted = [...candidates].sort((left, right) => {
        const profileDiff = profileOrder.indexOf(left.profile_id) - profileOrder.indexOf(right.profile_id);
        if (profileDiff !== 0) {
            return profileDiff;
        }
        return left.candidate_sort_key.localeCompare(right.candidate_sort_key);
    });
    const first = sorted[0];
    if (first === undefined) {
        throw new Error('empty convergence group');
    }
    return first;
}
function applyConvergence(candidates) {
    const groups = new Map();
    for (const candidate of candidates) {
        const group = groups.get(candidate.assignment_set_sha256) ?? [];
        group.push(candidate);
        groups.set(candidate.assignment_set_sha256, group);
    }
    const converged = new Map();
    for (const group of groups.values()) {
        if (group.length === 1) {
            const only = group[0];
            converged.set(only.candidate_id, only);
            continue;
        }
        const canonical = convergenceCanonical(group);
        for (const candidate of group) {
            if (candidate.candidate_id === canonical.candidate_id) {
                converged.set(candidate.candidate_id, withCandidateDiagnostics(candidate, candidate.diagnostic_codes, null));
            }
            else {
                converged.set(candidate.candidate_id, withCandidateDiagnostics(candidate, [...candidate.diagnostic_codes, 'ROSTER_CONVERGED_ASSIGNMENT_SET'], canonical.candidate_id));
            }
        }
    }
    return sortRosterCandidates([...converged.values()]);
}
export function createRosterCandidateSet(request) {
    return proposeRosterCandidates(request).candidate_set;
}
export function proposeRosterCandidates(request) {
    const recipes = request.recipes ?? PROVIDER_RECIPES;
    const routePolicies = request.routePolicies ?? ROUTE_POLICIES;
    const scope = request.scope ?? 'user';
    const normalizedInventory = normalizeRosterInventory(request.inventory);
    const diagnostics = [];
    if (scope === 'trusted-project' && !normalizedInventory.project_trusted) {
        diagnostics.push('ROSTER_PROJECT_UNTRUSTED');
    }
    if (normalizedInventory.providers.some((provider) => isForbiddenGatewayProvider(provider.provider_id) || provider.billing_route_class === 'gateway-forbidden' || provider.auth_source === 'environment')) {
        diagnostics.push('ROSTER_AUTH_CHANNEL_FORBIDDEN', 'ROSTER_ROUTE_FORBIDDEN');
    }
    const candidates = [];
    const pendingExcludedCandidateDiagnostics = [];
    const pendingUnavailableDiagnostics = [];
    for (const recipe of sortProviderRecipes(recipes)) {
        for (const profile of recipe.profile_templates) {
            const qualificationManifest = request.qualification_manifests?.find((manifest) => manifest.subject_id === recipe.recipe_id) ?? null;
            const result = resolveRecipe({
                schema_version: 'autopilot.recipe_resolution_request.v1',
                profile_id: profile.profile_id,
                recipe_id: recipe.recipe_id,
                recipe_revision: recipe.recipe_revision,
                inventory_sha256: normalizedInventory.inventory_sha256,
                scope,
                created_at: PHASE37_W0_SEED_CREATED_AT,
                qualification_manifest: qualificationManifest,
            }, normalizedInventory, { recipes, routePolicies });
            const resultCodes = result.diagnostics.map((diagnostic) => diagnostic.code);
            if (result.candidate !== null && result.candidate.launch_readiness === 'synthetic-fixture-only') {
                diagnostics.push(...resultCodes);
                candidates.push(result.candidate);
            }
            else if (result.candidate !== null && request.include_unready === true) {
                diagnostics.push(...resultCodes);
                candidates.push(result.candidate);
            }
            else if (result.candidate !== null) {
                pendingExcludedCandidateDiagnostics.push(...resultCodes);
            }
            else {
                pendingUnavailableDiagnostics.push(...resultCodes);
            }
        }
    }
    if (candidates.length === 0) {
        diagnostics.push(...(pendingExcludedCandidateDiagnostics.length > 0 ? pendingExcludedCandidateDiagnostics : pendingUnavailableDiagnostics));
    }
    const convergedCandidates = applyConvergence(candidates);
    diagnostics.push(...convergedCandidates.flatMap((candidate) => candidate.diagnostic_codes));
    const recommended = convergedCandidates.find((candidate) => candidate.profile_id === ROSTER_RECOMMENDED_PROFILE_ID);
    if (recommended !== undefined && recommended.launch_readiness === 'blocked') {
        diagnostics.push('ROSTER_RECOMMENDED_PROFILE_BLOCKED', 'ROSTER_EXPLICIT_CHOICE_REQUIRED');
    }
    const registry = computeProviderRecipeRegistry(recipes);
    const withoutIdAndHash = {
        schema_version: 'autopilot.roster_candidate_set.v1',
        scope,
        inventory_sha256: normalizedInventory.inventory_sha256,
        recipe_registry_sha256: registry.recipe_registry_sha256,
        candidates: convergedCandidates,
        recommended_profile_id: ROSTER_RECOMMENDED_PROFILE_ID,
        created_at: request.created_at ?? PHASE37_FIXTURE_CLOCK,
    };
    const candidateSetIdHash = canonicalSha256(withoutIdAndHash).slice('sha256:'.length, 'sha256:'.length + 16);
    const withoutHash = {
        schema_version: withoutIdAndHash.schema_version,
        candidate_set_id: `candidate-set-${candidateSetIdHash}`,
        scope: withoutIdAndHash.scope,
        inventory_sha256: withoutIdAndHash.inventory_sha256,
        recipe_registry_sha256: withoutIdAndHash.recipe_registry_sha256,
        candidates: withoutIdAndHash.candidates,
        recommended_profile_id: withoutIdAndHash.recommended_profile_id,
        created_at: withoutIdAndHash.created_at,
    };
    const candidate_set = { ...withoutHash, candidate_set_sha256: canonicalSha256(withoutHash) };
    const uniqueDiagnostics = dedupeDiagnostics(diagnostics);
    const hasReady = convergedCandidates.some((candidate) => candidate.launch_readiness === 'synthetic-fixture-only');
    const hasBlockingRouteOrAuth = uniqueDiagnostics.some((diagnostic) => diagnostic.code === 'ROSTER_AUTH_REQUIRED' ||
        diagnostic.code === 'ROSTER_AUTH_CHANNEL_FORBIDDEN' ||
        diagnostic.code === 'ROSTER_ROUTE_FORBIDDEN' ||
        diagnostic.code === 'ROSTER_PROJECT_UNTRUSTED' ||
        diagnostic.code === 'ROSTER_RECOMMENDED_PROFILE_BLOCKED' ||
        diagnostic.code === 'ROSTER_EXPLICIT_CHOICE_REQUIRED');
    const ok = hasReady && !hasBlockingRouteOrAuth;
    return {
        ok,
        status: ok ? 'proposed' : 'blocked',
        candidate_set,
        diagnostics: uniqueDiagnostics,
        write_count: 0,
        lock_count: 0,
        files_touched: [],
    };
}
export function validateCandidateSetApproval(currentCandidateSet, approvedCandidateSetSha256, approvedRosterSha256s) {
    const diagnostics = [];
    if (currentCandidateSet.candidate_set_sha256 !== approvedCandidateSetSha256) {
        diagnostics.push('ROSTER_APPROVAL_STALE_CANDIDATE_SET');
    }
    const currentRosterSha256s = currentCandidateSet.candidates.map((candidate) => candidate.roster_sha256);
    if (approvedRosterSha256s.length === 0 || new Set(approvedRosterSha256s).size !== approvedRosterSha256s.length) {
        diagnostics.push('ROSTER_APPROVAL_STALE_CANDIDATE_SET');
    }
    else {
        let cursor = 0;
        for (const sha of approvedRosterSha256s) {
            const index = currentRosterSha256s.indexOf(sha, cursor);
            if (index < 0) {
                diagnostics.push('ROSTER_APPROVAL_STALE_CANDIDATE_SET');
                break;
            }
            cursor = index + 1;
        }
    }
    return dedupeDiagnostics(diagnostics);
}
export function requestProfileFromAssignment(assignment) {
    const withoutHash = {
        provider_id: assignment.provider_id,
        model_id: assignment.model_id,
        model: assignment.model,
        api: assignment.api,
        thinking: assignment.thinking,
        service_tier: assignment.service_tier,
        cache_policy: assignment.cache_policy,
        system_prompt_profile: assignment.system_prompt_profile,
        context_window: assignment.context_window,
        max_output_tokens: assignment.max_output_tokens,
        input_modalities: assignment.input_modalities,
        output_modalities: assignment.output_modalities,
        reasoning_capability: assignment.reasoning_capability,
        tool_capability: assignment.tool_capability,
        route_policy_id: assignment.route_policy_id,
        route_policy_revision: assignment.route_policy_revision,
    };
    return { ...withoutHash, request_profile_sha256: canonicalSha256(withoutHash) };
}
export function validateRequestProfileForAssignment(requestProfile, assignment) {
    const expected = requestProfileFromAssignment(assignment);
    const mismatches = [];
    if (expected.request_profile_sha256 !== requestProfile.request_profile_sha256) {
        mismatches.push('ROSTER_REQUEST_PROFILE_DRIFT');
    }
    for (const key of Object.keys(expected)) {
        if (JSON.stringify(expected[key]) !== JSON.stringify(requestProfile[key])) {
            mismatches.push('ROSTER_REQUEST_PROFILE_DRIFT');
        }
    }
    return dedupeDiagnostics(mismatches);
}
export function validateObservedProfileAgainstRequest(requested, observed) {
    const diagnostics = [];
    if (observed.request_profile_sha256 !== requested.request_profile_sha256) {
        diagnostics.push('ROSTER_REQUEST_PROFILE_DRIFT');
    }
    if (observed.provider_id !== requested.provider_id || observed.api !== requested.api) {
        diagnostics.push('ROSTER_REQUEST_PROFILE_DRIFT');
    }
    if (observed.requested_model_id !== requested.model_id || observed.executed_model_id !== requested.model_id) {
        diagnostics.push('ROSTER_OBSERVED_MODEL_MISMATCH');
    }
    if (observed.thinking !== requested.thinking) {
        diagnostics.push('ROSTER_OBSERVED_THINKING_MISMATCH');
    }
    if (observed.service_tier !== requested.service_tier ||
        observed.cache_policy !== requested.cache_policy ||
        observed.system_prompt_profile !== requested.system_prompt_profile ||
        observed.route_policy_id !== requested.route_policy_id ||
        observed.route_policy_revision !== requested.route_policy_revision) {
        diagnostics.push('ROSTER_REQUEST_PROFILE_DRIFT');
    }
    return dedupeDiagnostics(diagnostics);
}
export function makeObservedProfile(input) {
    return { ...input, observed_profile_sha256: canonicalSha256(input) };
}
export function fakeInventoryFromProviders(options) {
    return normalizeRosterInventory({
        schema_version: 'autopilot.roster_inventory.v1',
        inventory_id: options.inventory_id,
        created_at: options.created_at ?? PHASE37_FIXTURE_CLOCK,
        source: options.source ?? 'synthetic-fixture',
        project_trusted: options.project_trusted ?? true,
        providers: options.providers,
    });
}
export function buildW4CertifiedRosterForCandidate(input) {
    const seedCandidate = seedCandidateForRecipeProfile(input.candidate.recipe_id, input.candidate.recipe_revision, input.candidate.profile_id);
    if (seedCandidate === null)
        return null;
    const seedRoster = SEED_ROSTERS.find((roster) => roster.roster_id === seedCandidate.roster_id && roster.roster_revision === seedCandidate.roster_revision) ?? null;
    if (seedRoster === null)
        return null;
    const assignments = sortAssignmentsByRole(seedRoster.assignments.map((assignment) => assignmentWithQualificationState(assignment, 'w4-certified-ready')));
    const assignment_set_sha256 = assignmentSetSha256(assignments);
    const roster_id = `${seedRoster.profile_id}-${seedRoster.recipe_id}-${assignment_set_sha256.slice('sha256:'.length, 'sha256:'.length + 12)}`;
    const withoutHash = {
        schema_version: seedRoster.schema_version,
        roster_id,
        roster_revision: seedRoster.roster_revision,
        display_name: seedRoster.display_name,
        scope: seedRoster.scope,
        selected_scope: seedRoster.selected_scope,
        profile_id: seedRoster.profile_id,
        recipe_id: seedRoster.recipe_id,
        recipe_revision: seedRoster.recipe_revision,
        generation_source: 'w4-certified-recipe',
        package_version: seedRoster.package_version,
        pi_version: seedRoster.pi_version,
        route_policy_ids: seedRoster.route_policy_ids,
        assignment_set_sha256,
        assignments,
        capability_summary: seedRoster.capability_summary,
        billing_summary: seedRoster.billing_summary,
        auth_summary: seedRoster.auth_summary,
        certification_manifest_id: input.certification_manifest_id,
        certification_manifest_sha256: input.certification_manifest_sha256,
        created_at: seedRoster.created_at,
    };
    return { ...withoutHash, roster_sha256: canonicalSha256(withoutHash) };
}
export function seedRosterByCandidate(candidate) {
    const seed = SEED_ROSTERS.find((roster) => roster.roster_id === candidate.roster_id && roster.roster_revision === candidate.roster_revision) ?? null;
    if (seed !== null)
        return seed;
    if (candidate.qualification_state === 'w4-certified-ready' &&
        candidate.launch_readiness === 'w4-certified-ready' &&
        candidate.candidate_state === 'w4-certified-ready' &&
        candidate.readiness_authority === 'w4-provider-registry.v1' &&
        candidate.provider_pack_id !== undefined &&
        candidate.provider_pack_id !== null &&
        candidate.recipe_sha256 !== undefined &&
        candidate.recipe_sha256 !== null &&
        candidate.route_policy_sha256 !== undefined &&
        candidate.route_policy_sha256 !== null &&
        candidate.certification_manifest_id !== undefined &&
        candidate.certification_manifest_id !== null &&
        candidate.certification_manifest_sha256 !== undefined &&
        candidate.certification_manifest_sha256 !== null) {
        const certified = buildW4CertifiedRosterForCandidate({
            candidate,
            certification_manifest_id: candidate.certification_manifest_id,
            certification_manifest_sha256: candidate.certification_manifest_sha256,
        });
        if (certified !== null && certified.roster_id === candidate.roster_id && certified.roster_revision === candidate.roster_revision && certified.roster_sha256 === candidate.roster_sha256) {
            return certified;
        }
    }
    return null;
}
function seedCandidateForRecipeProfile(recipeId, recipeRevision, profileId) {
    return SEED_CANDIDATE_BY_RECIPE_PROFILE.get(`${recipeId}:${recipeRevision}:${profileId}`) ?? null;
}
function assignmentWithQualificationState(assignment, qualification_state) {
    const withoutHash = {
        role: assignment.role,
        provider_id: assignment.provider_id,
        model_id: assignment.model_id,
        model: assignment.model,
        api: assignment.api,
        thinking: assignment.thinking,
        service_tier: assignment.service_tier,
        cache_policy: assignment.cache_policy,
        system_prompt_profile: assignment.system_prompt_profile,
        context_window: assignment.context_window,
        max_output_tokens: assignment.max_output_tokens,
        input_modalities: assignment.input_modalities,
        output_modalities: assignment.output_modalities,
        reasoning_capability: assignment.reasoning_capability,
        tool_capability: assignment.tool_capability,
        route_policy_id: assignment.route_policy_id,
        route_policy_revision: assignment.route_policy_revision,
        billing_class: assignment.billing_class,
        billing_route_class: assignment.billing_route_class,
        auth_class: assignment.auth_class,
        auth_source: assignment.auth_source,
        qualification_state,
    };
    return { ...withoutHash, assignment_sha256: canonicalSha256(withoutHash) };
}
export function diagnosticsForCandidate(candidate) {
    return dedupeDiagnostics(candidate.diagnostic_codes.map((code) => rosterDiagnostic(code)));
}
export function assertCandidateDirectReferences(candidate, recipes = PROVIDER_RECIPES) {
    const recipe = getProviderRecipe(candidate.recipe_id, candidate.recipe_revision, recipes);
    if (recipe === null) {
        throw new Error(`candidate ${candidate.candidate_id} references missing recipe`);
    }
    if (recipe.route_policy_id !== candidate.route_policy_id || recipe.route_policy_revision !== candidate.route_policy_revision) {
        throw new Error(`candidate ${candidate.candidate_id} route reference is not direct`);
    }
}
export function inventoryHashMatches(inventory) {
    return verifyRosterInventoryHash(inventory) && hashRosterInventory(inventory) === inventory.inventory_sha256;
}
