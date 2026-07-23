import { PHASE37_PACKAGE_VERSION, PHASE37_PI_VERSION, ROSTER_ROLE_ORDER, canonicalSha256, } from "../route-policies.js";
import { PROVIDER_RECIPES, } from "../provider-recipes.js";
function deepFreezeKimiCodingAuthority(value, seen = new WeakSet()) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        return value;
    }
    const objectValue = value;
    if (seen.has(objectValue)) {
        return value;
    }
    seen.add(objectValue);
    for (const key of Reflect.ownKeys(objectValue)) {
        deepFreezeKimiCodingAuthority(objectValue[key], seen);
    }
    return Object.freeze(objectValue);
}
export const KIMI_CODING_PROVIDER_ID = 'kimi-coding';
export const KIMI_CODING_RECIPE_ID = 'kimi-coding-plan';
export const KIMI_CODING_RECIPE_REVISION = 1;
export const KIMI_CODING_ROUTE_POLICY_ID = 'kimi-coding-plan-v1';
export const KIMI_CODING_ROUTE_POLICY_REVISION = 1;
export const KIMI_CODING_PROFILE_ID = 'precision';
export const KIMI_CODING_BASE_URL = 'https://api.kimi.com/coding';
export const KIMI_CODING_API = 'openai-completions';
export const KIMI_CODING_AUTH_CLASS = 'api-key-plan-token';
export const KIMI_CODING_BILLING_CLASS = 'plan-token';
export const KIMI_CODING_BILLING_ROUTE_CLASS = 'plan-api-token';
export const KIMI_CODING_AUTH_MATERIAL_SHAPE = 'api-key-shaped-plan-token';
export const KIMI_CODING_SYSTEM_PROMPT_PROFILE = 'pi-default.v1';
export const KIMI_CODING_CACHE_POLICY = 'provider-default';
export const KIMI_CODING_SERVICE_TIER = null;
export const KIMI_CODING_ISSUED_AT = '2026-07-23T00:00:00.000Z';
export const KIMI_CODING_EXPIRES_AT = '2026-08-22T00:00:00.000Z';
export const KIMI_CODING_EVALUATION_SCHEMA_VERSION = 'autopilot.kimi_coding_qualification_evaluation.v1';
export const KIMI_CODING_MANIFEST_CANDIDATE_SCHEMA_VERSION = 'autopilot.kimi_coding_qualification_manifest_candidate.v1';
export const KIMI_CODING_OFFLINE_REPORT_SCHEMA_VERSION = 'autopilot.kimi_coding_w4_offline_qualification_report.v1';
export const KIMI_CODING_SYNTHETIC_FIXTURE_SCHEMA_VERSION = 'autopilot.kimi_coding_provider_fixture.v1';
const TEXT_MODALITIES = ['text'];
const FORBIDDEN_GATEWAYS = ['arbitrary-api-key', 'metered-frontier', 'openrouter'];
const ALLOWED_AUTH_SOURCES = ['runtime', 'stored'];
export const KIMI_CODING_FORBIDDEN_GATEWAYS = deepFreezeKimiCodingAuthority(FORBIDDEN_GATEWAYS);
export const KIMI_CODING_ALLOWED_AUTH_SOURCES = deepFreezeKimiCodingAuthority(ALLOWED_AUTH_SOURCES);
export const KIMI_CODING_PROVIDER_RECIPE = (() => {
    const recipe = PROVIDER_RECIPES.find((candidate) => candidate.recipe_id === KIMI_CODING_RECIPE_ID && candidate.recipe_revision === KIMI_CODING_RECIPE_REVISION);
    if (recipe === undefined) {
        throw new Error('Kimi Coding W0 recipe authority is missing');
    }
    return recipe;
})();
const KIMI_CODING_PROVIDER_PROFILE = (() => {
    const profile = KIMI_CODING_PROVIDER_RECIPE.profile_templates.find((candidate) => candidate.profile_id === KIMI_CODING_PROFILE_ID);
    if (profile === undefined) {
        throw new Error('Kimi Coding W0 precision profile is missing');
    }
    return profile;
})();
function cloneRoleTemplate(template) {
    return {
        ...template,
        input_modalities: [...template.input_modalities],
        output_modalities: [...template.output_modalities],
    };
}
export const KIMI_CODING_ROLE_TEMPLATES = deepFreezeKimiCodingAuthority(KIMI_CODING_PROVIDER_PROFILE.role_templates.map((template) => cloneRoleTemplate(template)));
const KIMI_CODING_ROLE_TEMPLATE_MAP = new Map(KIMI_CODING_ROLE_TEMPLATES.map((template) => [template.role, template]));
deepFreezeKimiCodingAuthority(ROSTER_ROLE_ORDER);
export const KIMI_CODING_ROUTE_FACTS = deepFreezeKimiCodingAuthority({
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
    schema_version: 'autopilot.kimi_coding_labels.v1',
    provider_label: 'Kimi Coding',
    model_labels: ['kimi-k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
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
]);
export function isKimiCodingRole(value) {
    return ROSTER_ROLE_ORDER.includes(value);
}
export function getKimiCodingRoleTemplate(role) {
    return kimiCodingRoleTemplate(role);
}
export function kimiCodingRoleTemplate(role) {
    const template = KIMI_CODING_ROLE_TEMPLATE_MAP.get(role);
    if (template === undefined) {
        throw new Error(`Kimi Coding role template missing for ${role}`);
    }
    return template;
}
export function buildKimiCodingRequestProfile(role) {
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
    };
    return { ...withoutHash, request_profile_sha256: canonicalSha256(withoutHash) };
}
export function kimiCodingRequestProfileForRole(role) {
    return buildKimiCodingRequestProfile(role);
}
export function allKimiCodingRequestProfiles() {
    return ROSTER_ROLE_ORDER.map((role) => buildKimiCodingRequestProfile(role));
}
export function buildKimiCodingObservedProfile(role, systemPromptSha256) {
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
    };
    return { ...withoutHash, observed_profile_sha256: canonicalSha256(withoutHash) };
}
export function makeKimiCodingObservedEvidence(profile, options = {}) {
    const withoutHash = {
        provider_id: options.provider_id ?? profile.provider_id,
        requested_model_id: options.requested_model_id ?? profile.model_id,
        executed_model_id: options.executed_model_id ?? profile.model_id,
        api: options.api ?? profile.api,
        thinking: options.thinking ?? profile.thinking,
        service_tier: options.service_tier ?? profile.service_tier,
        cache_policy: options.cache_policy ?? profile.cache_policy,
        system_prompt_profile: options.system_prompt_profile ?? profile.system_prompt_profile,
        system_prompt_sha256: options.system_prompt_sha256 ?? `sha256:${'a'.repeat(64)}`,
        route_policy_id: options.route_policy_id ?? profile.route_policy_id,
        route_policy_revision: options.route_policy_revision ?? profile.route_policy_revision,
        request_profile_sha256: options.request_profile_sha256 ?? profile.request_profile_sha256,
    };
    return { ...withoutHash, observed_profile_sha256: canonicalSha256(withoutHash) };
}
export function exactKimiCodingRouteObservation(auth_source = 'runtime') {
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
export function validateKimiCodingRouteObservation(route) {
    const diagnostics = [];
    const forbiddenGatewayProvider = route.provider_id === 'openrouter' || route.provider_id === 'arbitrary-api-key' || route.provider_id === 'metered-frontier';
    if (forbiddenGatewayProvider) {
        diagnostics.push('KIMI_CODING_ROUTE_FORBIDDEN');
    }
    if (route.provider_id !== KIMI_CODING_PROVIDER_ID ||
        route.route_policy_id !== KIMI_CODING_ROUTE_POLICY_ID ||
        route.route_policy_revision !== KIMI_CODING_ROUTE_POLICY_REVISION ||
        route.base_url !== KIMI_CODING_BASE_URL) {
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
    if (!ALLOWED_AUTH_SOURCES.includes(String(route.auth_source))) {
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
export function evaluateKimiCodingQualification(input) {
    const issues = [];
    const routeKeys = [];
    validateTopLevelRoute(input, issues, routeKeys);
    validateQualificationProof(input.entitlement_proof, 'entitlement', 'entitlement_proof', input.evidence_source, issues, routeKeys);
    validateQualificationProof(input.billing_route_proof, 'billing-route', 'billing_route_proof', input.evidence_source, issues, routeKeys);
    validateRoleWitnesses(input.role_witnesses, input.evidence_source, issues, routeKeys);
    validateMixedRoute(routeKeys, issues);
    const uniqueIssues = sortIssues(issues);
    const structuralPass = uniqueIssues.length === 0;
    const certificationReady = structuralPass && input.evidence_source === 'live-post-w3-witness';
    const pendingLiveWitnesses = certificationReady ? [] : KIMI_CODING_PENDING_LIVE_POST_W3_WITNESSES;
    const qualificationState = certificationReady ? 'w4-certified-ready' : 'qualification-required';
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
        no_network: true,
        pending_live_post_w3_witnesses: pendingLiveWitnesses,
        issues: uniqueIssues,
    };
    return { ...withoutHash, evaluation_sha256: canonicalSha256(withoutHash) };
}
export function buildKimiCodingQualificationManifestCandidate(input) {
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
        no_network: true,
        pending_live_post_w3_witnesses: evaluation.pending_live_post_w3_witnesses,
        evaluation,
        certification_manifest: certificationManifest,
    };
    return { ...withoutHash, manifest_candidate_sha256: canonicalSha256(withoutHash) };
}
export function buildKimiCodingOfflineQualificationReport(input) {
    const manifestCandidate = buildKimiCodingQualificationManifestCandidate(input);
    const withoutHash = {
        schema_version: KIMI_CODING_OFFLINE_REPORT_SCHEMA_VERSION,
        phase: 'phase37-w4',
        provider_id: KIMI_CODING_PROVIDER_ID,
        recipe_id: KIMI_CODING_RECIPE_ID,
        route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
        offline: true,
        network_calls: 0,
        network_calls_performed: false,
        qualification_state: manifestCandidate.qualification_state,
        certifying: false,
        launch_ready: false,
        synthetic_fixture_non_certifying: true,
        live_provider_certification_asserted: false,
        synthetic_fixtures_certifying: false,
        openrouter_or_arbitrary_keys_allowed: false,
        generic_api_key_permission_allowed: false,
        model_substitution_allowed: false,
        pending_live_post_w3_witnesses: manifestCandidate.pending_live_post_w3_witnesses,
        report: 'qualification-required: live W3-authenticated role-complete Kimi Coding entitlement, billing, and observed request/executed-model evidence refs/digests are pending; synthetic offline fixture is non-certifying.',
        route_facts: KIMI_CODING_ROUTE_FACTS,
        role_templates: KIMI_CODING_ROLE_TEMPLATES,
        manifest_candidate: manifestCandidate,
    };
    return { ...withoutHash, report_sha256: canonicalSha256(withoutHash) };
}
export function buildKimiCodingQualification(input) {
    const manifestCandidate = buildKimiCodingQualificationManifestCandidate(input);
    const evaluation = manifestCandidate.evaluation;
    const roleResults = ROSTER_ROLE_ORDER.map((role) => {
        const roleIssues = evaluation.issues
            .filter((issue) => issue.path.includes(role))
            .map((issue) => issue.code);
        const uniqueDiagnostics = uniqueSortedDiagnostics(roleIssues);
        const state = evaluation.certification_ready
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
        qualification_state: evaluation.qualification_state,
        certifying: evaluation.certification_ready,
        live_evidence_complete: evaluation.certification_ready,
        synthetic_fixture: input.evidence_source === 'synthetic-fixture',
        network_calls_performed: false,
        diagnostics,
        role_results: roleResults,
        issued_at: KIMI_CODING_ISSUED_AT,
        expires_at: KIMI_CODING_EXPIRES_AT,
    };
    return { ...withoutHash, report_sha256: canonicalSha256(withoutHash) };
}
export function verifyKimiCodingOfflineQualificationReport(report) {
    const issues = [];
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
export function makeKimiCodingSyntheticQualificationInput() {
    const entitlementEvidence = evidenceRef('fixture-kimi-coding-plan-entitlement-proof', 'route-proof', 'fixture://phase37/kimi-coding/entitlement-route-proof', null, null);
    const billingEvidence = evidenceRef('fixture-kimi-coding-billing-route-proof', 'billing-proof', 'fixture://phase37/kimi-coding/billing-route-proof', null, null);
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
export function makeKimiCodingRoleEntitlementEvidence(role) {
    void role;
    return proof('fixture-kimi-coding-plan-entitlement-proof', 'entitlement', evidenceRef('fixture-kimi-coding-plan-entitlement-proof', 'route-proof', 'fixture://phase37/kimi-coding/entitlement-route-proof', null, null), KIMI_CODING_ISSUED_AT);
}
export function kimiCodingFixtureDigest(label) {
    return canonicalSha256({ provider_id: KIMI_CODING_PROVIDER_ID, fixture_label: label });
}
function makeSyntheticRoleWitness(role) {
    const systemPromptSha256 = kimiCodingFixtureDigest(`system-prompt-${role}`);
    const evidence = evidenceRef(`fixture-kimi-coding-exec-${role}-proof`, 'execution-proof', `fixture://phase37/kimi-coding/execution/${role}`, null, null);
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
function proof(proofId, proofKind, evidence, observedAt) {
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
function evidenceRef(evidenceId, kind, uri, sha256, byteCount) {
    return {
        evidence_id: evidenceId,
        kind,
        uri,
        sha256,
        byte_count: byteCount,
        secret_free: true,
    };
}
function validateTopLevelRoute(input, issues, routeKeys) {
    routeKeys.push(routeKey(input.route.provider_id, input.route.route_policy_id, input.route.route_policy_revision, String(input.route.billing_route_class)));
    if (input.schema_version !== 'autopilot.kimi_coding_qualification_input.v1') {
        pushIssue(issues, 'KIMI_CODING_ROUTE_FORBIDDEN', 'schema_version', 'Kimi Coding qualification input schema is exact');
    }
    for (const code of validateKimiCodingRouteObservation(input.route)) {
        pushIssue(issues, code, `route.${routePathForDiagnostic(code)}`, 'top-level route must match the W0 frozen Kimi Coding plan-token route');
    }
    if (input.gateway_id !== null && FORBIDDEN_GATEWAYS.includes(input.gateway_id)) {
        pushIssue(issues, 'KIMI_CODING_ROUTE_FORBIDDEN', 'gateway_id', 'OpenRouter, arbitrary keys, and metered gateways are forbidden');
    }
    else if (input.gateway_id !== null && input.gateway_id !== KIMI_CODING_PROVIDER_ID) {
        pushIssue(issues, 'KIMI_CODING_MIXED_ROUTE_FORBIDDEN', 'gateway_id', 'gateway/provider must remain the exact Kimi Coding plan route');
    }
    if (input.no_fallback !== true) {
        pushIssue(issues, 'KIMI_CODING_NO_FALLBACK_REQUIRED', 'no_fallback', 'fallback model or route is forbidden');
    }
    if (input.evidence_source !== 'synthetic-fixture' && input.evidence_source !== 'live-post-w3-witness') {
        pushIssue(issues, 'KIMI_CODING_LIVE_W3_EVIDENCE_REQUIRED', 'evidence_source', 'evidence source must be synthetic-fixture or live-post-W3 witness');
    }
}
function routePathForDiagnostic(code) {
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
function validateQualificationProof(proofValue, expectedKind, path, evidenceSource, issues, routeKeys) {
    const missingCode = expectedKind === 'entitlement' ? 'KIMI_CODING_ENTITLEMENT_EVIDENCE_REQUIRED' : 'KIMI_CODING_BILLING_EVIDENCE_REQUIRED';
    if (proofValue === null) {
        pushIssue(issues, missingCode, path, expectedKind === 'entitlement'
            ? 'non-secret Kimi Coding plan entitlement evidence ref/digest is required'
            : 'non-secret Kimi Coding billing-route evidence ref/digest is required');
        return;
    }
    routeKeys.push(routeKey(proofValue.provider_id, proofValue.route_policy_id, proofValue.route_policy_revision, proofValue.billing_route_class));
    if (proofValue.proof_kind !== expectedKind) {
        pushIssue(issues, missingCode, `${path}.proof_kind`, `proof kind must be ${expectedKind}`);
    }
    validateRoutePolicyCarrier(proofValue, path, issues);
    const expectedEvidenceKind = expectedKind === 'entitlement' ? 'route-proof' : 'billing-proof';
    if (proofValue.evidence_ref.kind !== expectedEvidenceKind) {
        pushIssue(issues, missingCode, `${path}.evidence_ref.kind`, `proof evidence kind must be ${expectedEvidenceKind}`);
    }
    validateEvidenceRefs([proofValue.evidence_ref], `${path}.evidence_ref`, evidenceSource, issues, expectedEvidenceKind, expectedKind === 'entitlement' ? 'plan-entitlement' : 'billing-route');
}
function validateRoutePolicyCarrier(carrier, pathPrefix, issues) {
    const path = (field) => pathPrefix.length === 0 ? field : `${pathPrefix}.${field}`;
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
        pushIssue(issues, 'KIMI_CODING_ROUTE_TOKEN_SHAPE_IS_NOT_API_KEY_PERMISSION', path('auth_material_shape'), 'API-key-shaped token shape proves only the plan-token route when auth_class is api-key-plan-token');
    }
    if (carrier.auth_material_shape !== KIMI_CODING_AUTH_MATERIAL_SHAPE) {
        pushIssue(issues, 'KIMI_CODING_PLAN_TOKEN_PROOF_REQUIRED', path('auth_material_shape'), 'auth material shape must be the plan-token shape');
    }
    if (!ALLOWED_AUTH_SOURCES.includes(carrier.auth_source)) {
        pushIssue(issues, 'KIMI_CODING_AUTH_SOURCE_FORBIDDEN', path('auth_source'), 'auth_source must be runtime or stored, never environment fallback');
    }
    if (carrier.billing_class !== KIMI_CODING_BILLING_CLASS || carrier.billing_route_class !== KIMI_CODING_BILLING_ROUTE_CLASS) {
        pushIssue(issues, 'KIMI_CODING_BILLING_EVIDENCE_REQUIRED', path('billing_route_class'), 'billing route must be plan-api-token');
    }
    if (carrier.no_fallback !== true) {
        pushIssue(issues, 'KIMI_CODING_NO_FALLBACK_REQUIRED', path('no_fallback'), 'fallback is forbidden');
    }
}
function validateRoleWitnesses(roleWitnesses, evidenceSource, issues, routeKeys) {
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
function validateWitnessRoute(witness, path, issues) {
    validateRoutePolicyCarrier(witness, path, issues);
    if (witness.authenticated !== true) {
        pushIssue(issues, 'KIMI_CODING_AUTHENTICATED_W3_EXECUTION_REQUIRED', `${path}.authenticated`, 'role execution must be authenticated by W3 evidence');
    }
}
function validateRequestProfileExact(role, requestProfile, path, issues, routeKeys) {
    const expected = buildKimiCodingRequestProfile(role);
    routeKeys.push(routeKey(requestProfile.provider_id, requestProfile.route_policy_id, requestProfile.route_policy_revision, KIMI_CODING_BILLING_ROUTE_CLASS));
    for (const key of Object.keys(expected)) {
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
function pushRequestProfileIssue(role, requestProfile, key, path, issues) {
    const code = key === 'api'
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
function validateObservedProfileExact(role, observedProfile, path, issues, routeKeys) {
    const expectedRequest = buildKimiCodingRequestProfile(role);
    routeKeys.push(routeKey(observedProfile.provider_id, observedProfile.route_policy_id, observedProfile.route_policy_revision, KIMI_CODING_BILLING_ROUTE_CLASS));
    const expectedPairs = [
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
            const code = key === 'api'
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
function validateEvidenceRefs(evidenceRefs, path, evidenceSource, issues, requiredKind, requiredScope) {
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
function validateLiveW3EvidenceRef(ref, path, issues, requiredScope) {
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
function validateMixedRoute(routeKeys, issues) {
    const unique = new Set(routeKeys);
    if (unique.size > 1) {
        pushIssue(issues, 'KIMI_CODING_MIXED_ROUTE_FORBIDDEN', 'route', 'all proofs, request profiles, and observed profiles must use one exact Kimi Coding route');
    }
}
function buildQualificationManifest(input, evaluation) {
    const roleResults = ROSTER_ROLE_ORDER.map((role) => {
        const witness = input.role_witnesses.find((candidate) => candidate.role === role) ?? null;
        const state = evaluation.certification_ready
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
        schema_version: 'autopilot.certification_manifest.v1',
        manifest_id: evaluation.certification_ready
            ? 'kimi-coding-plan-w4-qualified-v1'
            : 'kimi-coding-plan-qualification-required-v1',
        manifest_revision: 1,
        subject_kind: 'provider_recipe',
        subject_id: KIMI_CODING_RECIPE_ID,
        subject_sha256: KIMI_CODING_PROVIDER_RECIPE.recipe_sha256,
        package_version: PHASE37_PACKAGE_VERSION,
        pi_version: PHASE37_PI_VERSION,
        qualification_state: evaluation.qualification_state,
        role_results: roleResults,
        required_evidence: KIMI_CODING_REQUIRED_EVIDENCE_REFS,
        live_evidence: evaluation.certification_ready ? liveEvidenceRefs(input) : [],
        issued_at: KIMI_CODING_ISSUED_AT,
        expires_at: KIMI_CODING_EXPIRES_AT,
    };
    return { ...withoutHash, manifest_sha256: canonicalSha256(withoutHash) };
}
function requiredExecutionEvidenceRef(role) {
    const ref = KIMI_CODING_REQUIRED_EVIDENCE_REFS.find((candidate) => candidate.evidence_id === `kimi-coding-exec-${role}-proof`);
    if (ref === undefined) {
        throw new Error(`missing required execution evidence ref for ${role}`);
    }
    return ref;
}
function liveEvidenceRefs(input) {
    const refs = [];
    if (input.entitlement_proof !== null)
        refs.push(input.entitlement_proof.evidence_ref);
    if (input.billing_route_proof !== null)
        refs.push(input.billing_route_proof.evidence_ref);
    for (const witness of input.role_witnesses)
        refs.push(...witness.evidence_refs);
    return sortEvidenceRefs(refs);
}
function sortEvidenceRefs(refs) {
    const byId = new Map();
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
    ...ROSTER_ROLE_ORDER.map((role) => evidenceRef(`kimi-coding-exec-${role}-proof`, 'execution-proof', `witness-required://phase37/kimi-coding/execution/${role}`, null, null)),
]));
function validateReportHashes(report, issues) {
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
function validateManifestCandidateBinding(candidate, issues) {
    if (candidate.provider_id !== KIMI_CODING_PROVIDER_ID || candidate.recipe_id !== KIMI_CODING_RECIPE_ID || candidate.recipe_revision !== KIMI_CODING_RECIPE_REVISION) {
        pushIssue(issues, 'KIMI_CODING_MANIFEST_BINDING_MISMATCH', 'manifest_candidate.recipe_id', 'manifest candidate must bind to kimi-coding-plan@1');
    }
    if (candidate.route_policy_id !== KIMI_CODING_ROUTE_POLICY_ID || candidate.route_policy_revision !== KIMI_CODING_ROUTE_POLICY_REVISION) {
        pushIssue(issues, 'KIMI_CODING_MANIFEST_BINDING_MISMATCH', 'manifest_candidate.route_policy_id', 'manifest candidate must bind to kimi-coding-plan-v1@1');
    }
    const manifest = candidate.certification_manifest;
    if (manifest.subject_kind !== 'provider_recipe' ||
        manifest.subject_id !== KIMI_CODING_RECIPE_ID ||
        manifest.subject_sha256 !== KIMI_CODING_PROVIDER_RECIPE.recipe_sha256 ||
        manifest.package_version !== PHASE37_PACKAGE_VERSION ||
        manifest.pi_version !== PHASE37_PI_VERSION ||
        manifest.issued_at !== KIMI_CODING_ISSUED_AT ||
        manifest.expires_at !== KIMI_CODING_EXPIRES_AT) {
        pushIssue(issues, 'KIMI_CODING_MANIFEST_BINDING_MISMATCH', 'manifest_candidate.certification_manifest', 'manifest must bind exact subject/package 1.3.0/Pi 0.80.6/issued/expires W4 facts');
    }
    if (!jsonEqual(manifest.required_evidence, KIMI_CODING_REQUIRED_EVIDENCE_REFS)) {
        pushIssue(issues, 'KIMI_CODING_REQUIRED_EVIDENCE_MISMATCH', 'manifest_candidate.certification_manifest.required_evidence', 'required evidence refs must be the exact Kimi Coding W3 proof set');
    }
    if (candidate.certification_ready !== true && manifest.live_evidence.length !== 0) {
        pushIssue(issues, 'KIMI_CODING_LIVE_W3_EVIDENCE_REQUIRED', 'manifest_candidate.certification_manifest.live_evidence', 'non-ready manifests must not claim live evidence');
    }
}
function omitReportHash(report) {
    const { report_sha256: _reportSha256, ...withoutHash } = report;
    return withoutHash;
}
function omitManifestCandidateHash(candidate) {
    const { manifest_candidate_sha256: _manifestCandidateSha256, ...withoutHash } = candidate;
    return withoutHash;
}
function omitEvaluationHash(evaluation) {
    const { evaluation_sha256: _evaluationSha256, ...withoutHash } = evaluation;
    return withoutHash;
}
function omitManifestHash(manifest) {
    const { manifest_sha256: _manifestSha256, ...withoutHash } = manifest;
    return withoutHash;
}
function hashRequestProfile(requestProfile) {
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
    };
    return canonicalSha256(withoutHash);
}
function hashObservedProfile(observedProfile) {
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
    };
    return canonicalSha256(withoutHash);
}
function routeKey(providerId, routePolicyId, routePolicyRevision, billingRouteClass) {
    return `${providerId}\0${routePolicyId}\0${String(routePolicyRevision)}\0${billingRouteClass}`;
}
function pushIssue(issues, code, path, message) {
    issues.push({ code, path, message });
}
function sortIssues(issues) {
    const byIdentity = new Map();
    for (const issue of issues) {
        byIdentity.set(`${issue.code}\0${issue.path}`, issue);
    }
    return [...byIdentity.values()].sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path));
}
function uniqueSortedDiagnostics(diagnostics) {
    return [...new Set(diagnostics)].sort((left, right) => left.localeCompare(right));
}
function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function jsonEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function isSha256Digest(value) {
    return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}
function isOldDivergentRoute(route) {
    return route.api === 'anthropic-messages' || route.system_prompt_profile === 'anthropic-autopilot-sanitized.v1';
}
function isOldDivergentRequestProfile(profile) {
    return (profile.api === 'anthropic-messages' ||
        profile.system_prompt_profile === 'anthropic-autopilot-sanitized.v1' ||
        profile.context_window === 262144 ||
        !arraysEqual(profile.input_modalities, TEXT_MODALITIES) ||
        profile.model_id === legacyUppercaseKimiModelId());
}
function isOldDivergentObservedProfile(profile) {
    return (profile.api === 'anthropic-messages' ||
        profile.system_prompt_profile === 'anthropic-autopilot-sanitized.v1' ||
        profile.requested_model_id === legacyUppercaseKimiModelId() ||
        profile.executed_model_id === legacyUppercaseKimiModelId());
}
function isForbiddenModelSubstitution(role, modelId) {
    const expected = buildKimiCodingRequestProfile(role).model_id;
    if (modelId === expected) {
        return false;
    }
    return (role === 'extract' && modelId === 'kimi-for-coding') || modelId === legacyUppercaseKimiModelId();
}
function legacyUppercaseKimiModelId() {
    return ['K', '3'].join('');
}
export function assertKimiCodingRoleTemplateCompleteness(templates = KIMI_CODING_ROLE_TEMPLATES) {
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
});
