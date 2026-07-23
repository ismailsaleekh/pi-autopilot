import { computeAutopilotRosterContractObjectHash, parseAutopilotReceiptV2, parseAutopilotRosterContract, parseAutopilotUnitSpecV2, } from "../contracts.js";
import { getProviderRecipe, } from "../provider-recipes.js";
import { PHASE37_PACKAGE_VERSION, PHASE37_PI_VERSION, ROSTER_ROLE_ORDER, ROUTE_POLICIES, findRoutePolicy, } from "../route-policies.js";
export const CODEX_PROVIDER_PACK_ID = 'codex-subscription-w4-offline';
export const CODEX_PROVIDER_ID = 'openai-codex';
export const CODEX_RECIPE_ID = 'codex-subscription';
export const CODEX_RECIPE_REVISION = 1;
export const CODEX_ROUTE_POLICY_ID = 'codex-subscription-v1';
export const CODEX_ROUTE_POLICY_REVISION = 1;
export const CODEX_API = 'openai-codex-responses';
export const CODEX_AUTH_CLASS = 'oauth';
export const CODEX_ALLOWED_AUTH_SOURCES = ['runtime', 'stored'];
export const CODEX_BILLING_CLASS = 'plan-backed-subscription';
export const CODEX_BILLING_ROUTE_CLASS = 'subscription-oauth';
export const CODEX_CACHE_POLICY = 'provider-default';
export const CODEX_SYSTEM_PROMPT_PROFILE = 'pi-default.v1';
export const CODEX_REQUIRED_PACKAGE_VERSION = PHASE37_PACKAGE_VERSION;
export const CODEX_REQUIRED_PI_VERSION = PHASE37_PI_VERSION;
export const CODEX_BLOCKED_REASON = 'blocked pending post-W3 live subscription witness';
export const CODEX_COMPATIBILITY_ISSUE_CODES = [
    'CODEX_PACKAGE_VERSION_MISMATCH',
    'CODEX_PI_VERSION_MISMATCH',
    'CODEX_PROVIDER_ROUTE_MISMATCH',
    'CODEX_AUTH_NOT_OAUTH_SUBSCRIPTION',
    'CODEX_FORBIDDEN_API_KEY_OR_GATEWAY',
    'CODEX_PROFILE_NOT_FROZEN_SEED',
    'CODEX_ROLE_MISSING',
    'CODEX_ROLE_EXTRA_OR_DUPLICATE',
    'CODEX_UNIT_SPEC_W3_AUTHENTICATION_INVALID',
    'CODEX_RECEIPT_W3_AUTHENTICATION_INVALID',
    'CODEX_CORRUPT_W3_EVIDENCE',
    'CODEX_REQUEST_PROFILE_MISMATCH',
    'CODEX_MODEL_REQUIREMENT_MISMATCH',
    'CODEX_EXECUTED_MODEL_MISMATCH',
    'CODEX_API_THINKING_MISMATCH',
    'CODEX_SERVICE_TIER_MISMATCH',
    'CODEX_CACHE_POLICY_MISMATCH',
    'CODEX_PROMPT_PROFILE_MISMATCH',
    'CODEX_ROUTE_POLICY_MISMATCH',
    'CODEX_CONTEXT_BOUNDARY_MISSING',
    'CODEX_CONTEXT_BOUNDARY_MISMATCH',
    'CODEX_PROMPT_BOUNDARY_MISSING',
    'CODEX_PROMPT_BOUNDARY_MISMATCH',
    'CODEX_CACHE_EVIDENCE_MISSING',
    'CODEX_REQUEST_EVIDENCE_MISSING',
    'CODEX_OBSERVED_EVIDENCE_MISSING',
    'CODEX_LIVE_BILLING_WITNESS_MISSING',
    'CODEX_LIVE_REQUEST_WITNESS_MISSING',
    'CODEX_SYNTHETIC_NON_CERTIFYING',
    'CODEX_FALLBACK_FORBIDDEN',
    'CODEX_CRITICAL_ROLE_INVARIANT_BROKEN',
    'CODEX_OFFLINE_PACK_NEVER_READY',
];
const ZERO_DIGEST = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const CONTROL_PLANE_ROLES = ['parent', 'strategy', 'validate', 'adjudicate', 'bughunt'];
const SOURCE_CHANGE_ROLES = ['implement', 'fix'];
const PROFILE_ORDER = ['afterburner', 'cruise', 'precision'];
const codexRecipe = requireCodexRecipe();
const codexRoutePolicy = requireCodexRoutePolicy();
assertCodexAuthority(codexRecipe, codexRoutePolicy);
export const CODEX_PROVIDER_RECIPE = deepFreezeCodex(cloneJson(codexRecipe));
export const CODEX_SUBSCRIPTION_ROUTE_POLICY = deepFreezeCodex(cloneJson(codexRoutePolicy));
export const CODEX_PROFILE_TEMPLATES = deepFreezeCodex(cloneJson(codexRecipe.profile_templates));
export const CODEX_CRITICAL_ROLE_QUALITY_INVARIANTS = deepFreezeCodex([
    {
        invariant_id: 'codex-sol-control-plane-xhigh',
        profile_ids: ['precision', 'cruise', 'afterburner'],
        roles: [...CONTROL_PLANE_ROLES],
        model_ids: ['gpt-5.6-sol'],
        thinking_values: ['xhigh'],
        service_tiers: [null],
        min_context_window: 512000,
        min_max_output_tokens: 65536,
        rationale: 'Parent, strategy, validation, adjudication, and bughunt remain on Sol/xhigh with the full W0 context/output floor.',
    },
    {
        invariant_id: 'codex-terra-precision-cruise-source-change-floor',
        profile_ids: ['precision', 'cruise'],
        roles: [...SOURCE_CHANGE_ROLES],
        model_ids: ['gpt-5.6-terra'],
        thinking_values: ['high'],
        service_tiers: [null],
        min_context_window: 512000,
        min_max_output_tokens: 65536,
        rationale: 'Precision and Cruise source-changing roles are never downgraded below Terra/high.',
    },
    {
        invariant_id: 'codex-afterburner-priority-boundary',
        profile_ids: ['afterburner'],
        roles: [...SOURCE_CHANGE_ROLES],
        model_ids: ['gpt-5.5'],
        thinking_values: ['high'],
        service_tiers: ['priority'],
        min_context_window: 256000,
        min_max_output_tokens: 32768,
        rationale: 'Afterburner is the only profile that may request priority tier, and only for implement/fix on the frozen quick role template.',
    },
    {
        invariant_id: 'codex-luna-extract-boundary',
        profile_ids: ['precision', 'cruise', 'afterburner'],
        roles: ['extract'],
        model_ids: ['gpt-5.6-luna'],
        thinking_values: ['high'],
        service_tiers: [null],
        min_context_window: 256000,
        min_max_output_tokens: 32768,
        rationale: 'Extraction stays on Luna/high and is not substituted by a control-plane or source-change model.',
    },
]);
export const CODEX_PENDING_POST_W3_LIVE_BILLING_EVIDENCE = deepFreezeCodex({
    evidence_id: 'pending-codex-post-w3-live-billing',
    kind: 'billing-proof',
    uri: 'pending://phase37/w4/codex/post-w3-live-subscription-billing',
    sha256: null,
    byte_count: null,
    secret_free: true,
});
export const CODEX_PENDING_POST_W3_LIVE_REQUEST_EVIDENCE = deepFreezeCodex({
    evidence_id: 'pending-codex-post-w3-live-requests',
    kind: 'execution-proof',
    uri: 'pending://phase37/w4/codex/post-w3-live-role-requests',
    sha256: null,
    byte_count: null,
    secret_free: true,
});
export function getCodexProfileTemplate(profileId) {
    return CODEX_PROFILE_TEMPLATES.find((profile) => profile.profile_id === profileId) ?? null;
}
export function getCodexRoleRequirement(profileId, role) {
    const profile = getCodexProfileTemplate(profileId);
    const template = profile?.role_templates.find((entry) => entry.role === role) ?? null;
    return template === null ? null : roleRequirementFromTemplate(template);
}
export function codexRoleRequirementsForProfile(profileId) {
    const profile = getCodexProfileTemplate(profileId);
    if (profile === null)
        return [];
    return deepFreezeCodex(profile.role_templates.map((template) => roleRequirementFromTemplate(template)));
}
export function expectedCodexRequestProfile(profileId, role) {
    const requirement = getCodexRoleRequirement(profileId, role);
    if (requirement === null)
        return null;
    return requestProfileFromRequirement(requirement);
}
export function evaluateCodexProviderCompatibility(input) {
    const globalIssues = [];
    const profile = getCodexProfileTemplate(input.profile_id);
    const profileId = profile?.profile_id ?? null;
    if (input.package_version !== CODEX_REQUIRED_PACKAGE_VERSION) {
        pushIssue(globalIssues, 'CODEX_PACKAGE_VERSION_MISMATCH', 'fatal', `package_version must be ${CODEX_REQUIRED_PACKAGE_VERSION}`);
    }
    if (input.pi_version !== CODEX_REQUIRED_PI_VERSION) {
        pushIssue(globalIssues, 'CODEX_PI_VERSION_MISMATCH', 'fatal', `pi_version must be ${CODEX_REQUIRED_PI_VERSION}`);
    }
    if (input.recipe_id !== CODEX_RECIPE_ID || input.recipe_revision !== CODEX_RECIPE_REVISION) {
        pushIssue(globalIssues, 'CODEX_PROFILE_NOT_FROZEN_SEED', 'fatal', 'qualification input must target the frozen codex-subscription recipe revision');
    }
    if (input.route_policy_id !== CODEX_ROUTE_POLICY_ID || input.route_policy_revision !== CODEX_ROUTE_POLICY_REVISION) {
        pushIssue(globalIssues, 'CODEX_ROUTE_POLICY_MISMATCH', 'fatal', 'qualification input must directly reference codex-subscription-v1@1');
    }
    if (profile === null) {
        pushIssue(globalIssues, 'CODEX_PROFILE_NOT_FROZEN_SEED', 'fatal', 'profile_id must be one of the frozen Codex seed profiles');
    }
    validateCodexAuth(input.auth, globalIssues);
    collectEvidenceRef(input.route_evidence, 'CODEX_ROUTE_POLICY_MISMATCH', 'fatal', globalIssues, undefined, 'route evidence is required');
    collectEvidenceRef(input.billing_evidence, 'CODEX_LIVE_BILLING_WITNESS_MISSING', 'blocking', globalIssues, undefined, 'billing evidence is required');
    const liveBillingWitness = collectEvidenceRef(input.live_billing_witness, 'CODEX_LIVE_BILLING_WITNESS_MISSING', 'blocking', globalIssues, undefined, 'post-W3 live Codex subscription billing witness is required before readiness');
    if (liveBillingWitness !== null && !isLiveEvidenceRef(liveBillingWitness)) {
        pushIssue(globalIssues, 'CODEX_LIVE_BILLING_WITNESS_MISSING', 'blocking', 'billing witness is not live post-W3 provider evidence');
    }
    if (input.evidence_source !== 'w3-live-observed') {
        pushIssue(globalIssues, 'CODEX_SYNTHETIC_NON_CERTIFYING', 'blocking', 'offline synthetic fixtures are non-certifying');
    }
    pushIssue(globalIssues, 'CODEX_OFFLINE_PACK_NEVER_READY', 'blocking', CODEX_BLOCKED_REASON);
    const roleResults = profile === null
        ? []
        : evaluateCodexRoles(profile, input.role_witnesses, globalIssues, input.evidence_source);
    const allIssues = sortIssues([...globalIssues, ...roleResults.flatMap((result) => [...result.issues])]);
    const compatible = !allIssues.some((issue) => issue.severity === 'fatal');
    const qualification_state = compatible ? 'blocked-live-certification' : 'unqualified-non-certifying-seed';
    return deepFreezeCodex({
        provider_pack_id: CODEX_PROVIDER_PACK_ID,
        compatible,
        qualified: false,
        ready: false,
        qualification_state,
        blocked_reason: CODEX_BLOCKED_REASON,
        profile_id: profileId,
        role_results: roleResults,
        issues: allIssues,
    });
}
export function buildCodexQualificationManifestCandidate(input) {
    const evaluation = evaluateCodexProviderCompatibility(input);
    if (!evaluation.compatible || evaluation.profile_id === null) {
        return deepFreezeCodex({
            provider_pack_id: CODEX_PROVIDER_PACK_ID,
            accepted: false,
            ready: false,
            qualification_state: evaluation.qualification_state,
            blocked_reason: CODEX_BLOCKED_REASON,
            manifest: null,
            evaluation,
        });
    }
    const role_results = ROSTER_ROLE_ORDER.map((role) => {
        const roleResult = evaluation.role_results.find((entry) => entry.role === role);
        if (roleResult === undefined || !roleResult.accepted || roleResult.evidence_refs.length === 0) {
            throw new Error(`internal Codex qualification invariant failed for role ${role}`);
        }
        const state = roleResult.synthetic_non_certifying ? 'synthetic-pass' : 'fail';
        return {
            role,
            state,
            evidence_refs: roleResult.evidence_refs,
        };
    });
    const required_evidence = uniqueEvidenceRefs([
        input.route_evidence,
        input.billing_evidence,
        CODEX_PENDING_POST_W3_LIVE_BILLING_EVIDENCE,
        CODEX_PENDING_POST_W3_LIVE_REQUEST_EVIDENCE,
        ...evaluation.role_results.flatMap((roleResult) => [...roleResult.evidence_refs]),
    ]);
    const live_evidence = uniqueEvidenceRefs([
        input.live_billing_witness,
        ...input.role_witnesses.map((witness) => witness.live_request_witness),
    ].filter((ref) => ref !== null && isLiveEvidenceRef(ref)));
    const withoutHash = {
        schema_version: 'autopilot.certification_manifest.v1',
        manifest_id: `${CODEX_RECIPE_ID}-w4-offline-${evaluation.profile_id}`,
        manifest_revision: 1,
        subject_kind: 'provider_recipe',
        subject_id: CODEX_RECIPE_ID,
        subject_sha256: CODEX_PROVIDER_RECIPE.recipe_sha256,
        package_version: CODEX_REQUIRED_PACKAGE_VERSION,
        pi_version: CODEX_REQUIRED_PI_VERSION,
        qualification_state: 'blocked-live-certification',
        role_results,
        required_evidence,
        live_evidence,
        issued_at: input.issued_at,
        expires_at: input.expires_at,
    };
    const manifest = parseAutopilotRosterContract('autopilot.certification_manifest.v1', {
        ...withoutHash,
        manifest_sha256: requiredRosterHash('autopilot.certification_manifest.v1', {
            ...withoutHash,
            manifest_sha256: ZERO_DIGEST,
        }),
    });
    return deepFreezeCodex({
        provider_pack_id: CODEX_PROVIDER_PACK_ID,
        accepted: true,
        ready: false,
        qualification_state: 'blocked-live-certification',
        blocked_reason: CODEX_BLOCKED_REASON,
        manifest,
        evaluation,
    });
}
function evaluateCodexRoles(profile, witnesses, globalIssues, evidenceSource) {
    const byRole = new Map();
    for (const witness of witnesses) {
        const role = asRosterRole(witness.role);
        if (role === null) {
            pushIssue(globalIssues, 'CODEX_ROLE_EXTRA_OR_DUPLICATE', 'fatal', `unknown Codex role witness ${JSON.stringify(witness.role)}`);
            continue;
        }
        if (byRole.has(role)) {
            pushIssue(globalIssues, 'CODEX_ROLE_EXTRA_OR_DUPLICATE', 'fatal', `duplicate Codex role witness ${role}`, role);
            continue;
        }
        byRole.set(role, witness);
    }
    const roleResults = [];
    for (const template of profile.role_templates) {
        const witness = byRole.get(template.role);
        if (witness === undefined) {
            pushIssue(globalIssues, 'CODEX_ROLE_MISSING', 'fatal', `missing W3 role witness for ${template.role}`, template.role);
            roleResults.push(emptyRoleResult(template.role, [
                issueObject('CODEX_ROLE_MISSING', 'fatal', `missing W3 role witness for ${template.role}`, template.role),
            ]));
            continue;
        }
        roleResults.push(evaluateCodexRoleWitness(profile.profile_id, template, witness, evidenceSource));
    }
    for (const role of byRole.keys()) {
        if (!profile.role_templates.some((template) => template.role === role)) {
            pushIssue(globalIssues, 'CODEX_ROLE_EXTRA_OR_DUPLICATE', 'fatal', `extra Codex role witness ${role}`, role);
        }
    }
    return deepFreezeCodex(roleResults.sort((left, right) => roleSortIndex(left.role) - roleSortIndex(right.role)));
}
function evaluateCodexRoleWitness(profileId, template, witness, evidenceSource) {
    const issues = [];
    const requirement = roleRequirementFromTemplate(template);
    const expectedRequest = requestProfileFromRequirement(requirement);
    const evidenceRefs = [];
    const requestEvidence = collectEvidenceRef(witness.request_evidence, 'CODEX_REQUEST_EVIDENCE_MISSING', 'fatal', issues, template.role, 'W3 unit/request evidence ref is required');
    const observedEvidence = collectEvidenceRef(witness.observed_evidence, 'CODEX_OBSERVED_EVIDENCE_MISSING', 'fatal', issues, template.role, 'W3 observed receipt evidence ref is required');
    const promptEvidence = collectEvidenceRef(witness.prompt_evidence, 'CODEX_PROMPT_BOUNDARY_MISSING', 'fatal', issues, template.role, 'prompt boundary evidence ref is required');
    const cacheEvidence = collectEvidenceRef(witness.cache_evidence, 'CODEX_CACHE_EVIDENCE_MISSING', 'fatal', issues, template.role, 'cache evidence ref is required');
    for (const ref of [requestEvidence, observedEvidence, promptEvidence, cacheEvidence]) {
        if (ref !== null)
            evidenceRefs.push(ref);
    }
    const liveRequestWitness = collectEvidenceRef(witness.live_request_witness, 'CODEX_LIVE_REQUEST_WITNESS_MISSING', 'blocking', issues, template.role, 'post-W3 live Codex request witness is required before readiness');
    if (liveRequestWitness !== null && !isLiveEvidenceRef(liveRequestWitness)) {
        pushIssue(issues, 'CODEX_LIVE_REQUEST_WITNESS_MISSING', 'blocking', 'request witness is not live post-W3 provider evidence', template.role);
    }
    if (evidenceSource !== 'w3-live-observed') {
        pushIssue(issues, 'CODEX_SYNTHETIC_NON_CERTIFYING', 'blocking', 'role witness is synthetic/non-certifying', template.role);
    }
    if ([requestEvidence, observedEvidence, promptEvidence, cacheEvidence].some((ref) => ref !== null && !isLiveEvidenceRef(ref))) {
        pushIssue(issues, 'CODEX_SYNTHETIC_NON_CERTIFYING', 'blocking', 'role evidence refs are offline fixture/pending evidence', template.role);
    }
    if (witness.fallback_used || witness.fallback_route_policy_id !== null) {
        pushIssue(issues, 'CODEX_FALLBACK_FORBIDDEN', 'fatal', 'fallback route/model execution is forbidden', template.role);
    }
    const directRequest = parseRequestProfileWitness(witness.request_profile, issues, template.role);
    const directObserved = parseObservedProfileWitness(witness.observed_profile, issues, template.role);
    const directProviderIdentity = parseProviderIdentityWitness(witness.provider_identity, issues, template.role);
    const needsChildArtifacts = template.role !== 'parent';
    const unit = needsChildArtifacts ? parseUnitSpecWitness(witness.unit_spec, issues, template.role) : null;
    const receipt = needsChildArtifacts ? parseReceiptWitness(witness.receipt, issues, template.role) : null;
    if (!needsChildArtifacts && (witness.unit_spec !== null || witness.receipt !== null)) {
        pushIssue(issues, 'CODEX_UNIT_SPEC_W3_AUTHENTICATION_INVALID', 'fatal', 'parent role uses direct parent requested/observed evidence, not child unit_spec.v2/receipt.v2 artifacts', template.role);
    }
    let requestedModelId = directRequest === null ? null : directRequest.model_id;
    let executedModelId = directObserved?.executed_model_id ?? directProviderIdentity?.executed_model_id ?? null;
    let requestProfileSha256 = directRequest === null ? null : directRequest.request_profile_sha256;
    let observedProfileSha256 = directObserved === null ? null : directObserved.observed_profile_sha256;
    if (directRequest !== null && !sameJson(directRequest, expectedRequest)) {
        pushRequestProfileMismatches(issues, expectedRequest, directRequest, template.role);
    }
    if (directObserved !== null && directProviderIdentity !== null) {
        compareObservedProfile(issues, expectedRequest, directObserved, directProviderIdentity, template.role);
    }
    if (unit !== null) {
        requestedModelId = unit.request_profile.model_id;
        requestProfileSha256 = unit.request_profile.request_profile_sha256;
        if (unit.role !== template.role || unit.template !== template.role) {
            pushIssue(issues, 'CODEX_REQUEST_PROFILE_MISMATCH', 'fatal', 'unit_spec.v2 role/template must match the frozen role template', template.role);
        }
        if (!sameJson(unit.request_profile, expectedRequest)) {
            pushRequestProfileMismatches(issues, expectedRequest, unit.request_profile, template.role);
        }
        if (directRequest !== null && !sameJson(unit.request_profile, directRequest)) {
            pushIssue(issues, 'CODEX_REQUEST_PROFILE_MISMATCH', 'fatal', 'unit_spec.v2 request_profile must match direct request evidence', template.role);
        }
        if (unit.model !== expectedRequest.model || unit.thinking !== expectedRequest.thinking) {
            pushIssue(issues, 'CODEX_API_THINKING_MISMATCH', 'fatal', 'unit_spec.v2 model/thinking must match the frozen request profile', template.role);
        }
    }
    if (receipt !== null) {
        executedModelId = receipt.provider_identity.executed_model_id;
        observedProfileSha256 = receipt.observed_profile.observed_profile_sha256;
        if (receipt.role !== template.role) {
            pushIssue(issues, 'CODEX_REQUEST_PROFILE_MISMATCH', 'fatal', 'receipt.v2 role must match the frozen role template', template.role);
        }
        if (!sameJson(receipt.request_profile, expectedRequest)) {
            pushRequestProfileMismatches(issues, expectedRequest, receipt.request_profile, template.role);
        }
        if (directRequest !== null && !sameJson(receipt.request_profile, directRequest)) {
            pushIssue(issues, 'CODEX_REQUEST_PROFILE_MISMATCH', 'fatal', 'receipt.v2 request_profile must match direct request evidence', template.role);
        }
        if (directObserved !== null && !sameJson(receipt.observed_profile, directObserved)) {
            pushIssue(issues, 'CODEX_REQUEST_PROFILE_MISMATCH', 'fatal', 'receipt.v2 observed_profile must match direct observed evidence', template.role);
        }
        if (directProviderIdentity !== null && !sameJson(receipt.provider_identity, directProviderIdentity)) {
            pushIssue(issues, 'CODEX_EXECUTED_MODEL_MISMATCH', 'fatal', 'receipt.v2 provider_identity must match direct observed provider identity', template.role);
        }
        compareObservedProfile(issues, expectedRequest, receipt.observed_profile, receipt.provider_identity, template.role);
    }
    if (unit !== null && receipt !== null) {
        for (const field of ['workstream', 'unit_id', 'role', 'attempt', 'status_output']) {
            if (unit[field] !== receipt[field]) {
                pushIssue(issues, 'CODEX_CORRUPT_W3_EVIDENCE', 'fatal', `receipt.v2 ${field} must match unit_spec.v2`, template.role);
            }
        }
        for (const field of ['roster_id', 'roster_revision', 'roster_sha256', 'assignment_sha256', 'pre_run_selection_sha256']) {
            if (unit[field] !== receipt[field]) {
                pushIssue(issues, 'CODEX_CORRUPT_W3_EVIDENCE', 'fatal', `receipt.v2 ${field} must match unit_spec.v2`, template.role);
            }
        }
        if (!sameJson(unit.request_profile, receipt.request_profile)) {
            pushIssue(issues, 'CODEX_REQUEST_PROFILE_MISMATCH', 'fatal', 'unit_spec.v2 and receipt.v2 request profiles must match byte-for-byte canonically', template.role);
        }
    }
    validateContextBoundary(witness.context_boundary, requirement, issues, template.role);
    validatePromptBoundary(witness.prompt_boundary, directObserved ?? receipt?.observed_profile ?? null, requirement, issues, template.role);
    validateCriticalRoleInvariants(profileId, requirement, issues);
    const sortedIssues = sortIssues(issues);
    const accepted = !sortedIssues.some((issue) => issue.severity === 'fatal');
    const syntheticNonCertifying = sortedIssues.some((issue) => issue.code === 'CODEX_SYNTHETIC_NON_CERTIFYING') || evidenceSource !== 'w3-live-observed';
    return deepFreezeCodex({
        role: template.role,
        accepted,
        certifying: false,
        synthetic_non_certifying: syntheticNonCertifying,
        requested_model_id: requestedModelId,
        executed_model_id: executedModelId,
        request_profile_sha256: requestProfileSha256,
        observed_profile_sha256: observedProfileSha256,
        evidence_refs: uniqueEvidenceRefs(evidenceRefs),
        issues: sortedIssues,
    });
}
function validateCodexAuth(auth, issues) {
    const routeMatches = auth.route_policy_id === CODEX_ROUTE_POLICY_ID && auth.route_policy_revision === CODEX_ROUTE_POLICY_REVISION;
    if (auth.provider_id !== CODEX_PROVIDER_ID || !routeMatches) {
        pushIssue(issues, 'CODEX_PROVIDER_ROUTE_MISMATCH', 'fatal', 'auth evidence must name openai-codex on codex-subscription-v1@1');
    }
    if (auth.gateway_provider_id !== null || auth.provider_id === 'openrouter') {
        pushIssue(issues, 'CODEX_FORBIDDEN_API_KEY_OR_GATEWAY', 'fatal', 'OpenRouter and metered gateway providers are forbidden for Codex');
    }
    if (auth.auth_class === 'api-key' || auth.auth_source === 'environment') {
        pushIssue(issues, 'CODEX_FORBIDDEN_API_KEY_OR_GATEWAY', 'fatal', 'API keys and environment-secret routes are forbidden for Codex subscription qualification');
    }
    if (!auth.auth_configured ||
        auth.auth_class !== CODEX_AUTH_CLASS ||
        !CODEX_ALLOWED_AUTH_SOURCES.includes(auth.auth_source) ||
        auth.auth_status !== 'configured' ||
        !auth.is_using_oauth ||
        auth.billing_class !== CODEX_BILLING_CLASS ||
        auth.billing_route_class !== CODEX_BILLING_ROUTE_CLASS) {
        pushIssue(issues, 'CODEX_AUTH_NOT_OAUTH_SUBSCRIPTION', 'fatal', 'Codex qualification requires configured OAuth subscription auth with subscription-oauth billing');
    }
}
function pushRequestProfileMismatches(issues, expected, actual, role) {
    if (actual.provider_id !== expected.provider_id)
        pushIssue(issues, 'CODEX_PROVIDER_ROUTE_MISMATCH', 'fatal', 'provider_id must remain openai-codex', role);
    if (actual.model_id !== expected.model_id || actual.model !== expected.model) {
        pushIssue(issues, 'CODEX_MODEL_REQUIREMENT_MISMATCH', 'fatal', `model must remain ${expected.model_id}`, role);
    }
    if (actual.api !== expected.api || actual.thinking !== expected.thinking) {
        pushIssue(issues, 'CODEX_API_THINKING_MISMATCH', 'fatal', 'api/thinking must match the frozen Codex template', role);
    }
    if (actual.service_tier !== expected.service_tier) {
        pushIssue(issues, 'CODEX_SERVICE_TIER_MISMATCH', 'fatal', 'service_tier must match the frozen Codex template', role);
    }
    if (actual.cache_policy !== expected.cache_policy) {
        pushIssue(issues, 'CODEX_CACHE_POLICY_MISMATCH', 'fatal', 'cache_policy must remain provider-default', role);
    }
    if (actual.system_prompt_profile !== expected.system_prompt_profile) {
        pushIssue(issues, 'CODEX_PROMPT_PROFILE_MISMATCH', 'fatal', 'system_prompt_profile must remain pi-default.v1', role);
    }
    if (actual.route_policy_id !== expected.route_policy_id || actual.route_policy_revision !== expected.route_policy_revision) {
        pushIssue(issues, 'CODEX_ROUTE_POLICY_MISMATCH', 'fatal', 'route policy must directly reference codex-subscription-v1@1', role);
    }
    if (actual.context_window !== expected.context_window ||
        actual.max_output_tokens !== expected.max_output_tokens ||
        !sameJson(actual.input_modalities, expected.input_modalities) ||
        !sameJson(actual.output_modalities, expected.output_modalities) ||
        actual.reasoning_capability !== expected.reasoning_capability ||
        actual.tool_capability !== expected.tool_capability) {
        pushIssue(issues, 'CODEX_CONTEXT_BOUNDARY_MISMATCH', 'fatal', 'model capability/context boundaries must match the frozen Codex template', role);
    }
    if (actual.request_profile_sha256 !== expected.request_profile_sha256) {
        pushIssue(issues, 'CODEX_REQUEST_PROFILE_MISMATCH', 'fatal', 'request_profile_sha256 must match the frozen request profile', role);
    }
}
function compareObservedProfile(issues, expected, observed, providerIdentity, role) {
    if (observed.provider_id !== expected.provider_id || providerIdentity.provider_id !== expected.provider_id) {
        pushIssue(issues, 'CODEX_PROVIDER_ROUTE_MISMATCH', 'fatal', 'observed provider must remain openai-codex', role);
    }
    if (observed.requested_model_id !== expected.model_id ||
        observed.executed_model_id !== expected.model_id ||
        providerIdentity.requested_model_id !== expected.model_id ||
        providerIdentity.executed_model_id !== expected.model_id) {
        pushIssue(issues, 'CODEX_EXECUTED_MODEL_MISMATCH', 'fatal', 'actual executed model must match the requested frozen model with no fallback', role);
    }
    if (observed.api !== expected.api || providerIdentity.api !== expected.api || providerIdentity.thinking_level !== expected.thinking) {
        pushIssue(issues, 'CODEX_API_THINKING_MISMATCH', 'fatal', 'observed API/thinking must match the frozen request', role);
    }
    if (observed.thinking !== expected.thinking)
        pushIssue(issues, 'CODEX_API_THINKING_MISMATCH', 'fatal', 'observed thinking must match the frozen request', role);
    if (observed.service_tier !== expected.service_tier)
        pushIssue(issues, 'CODEX_SERVICE_TIER_MISMATCH', 'fatal', 'observed tier must match the frozen request', role);
    if (observed.cache_policy !== expected.cache_policy)
        pushIssue(issues, 'CODEX_CACHE_POLICY_MISMATCH', 'fatal', 'observed cache policy must match the frozen request', role);
    if (observed.system_prompt_profile !== expected.system_prompt_profile)
        pushIssue(issues, 'CODEX_PROMPT_PROFILE_MISMATCH', 'fatal', 'observed prompt profile must match the frozen request', role);
    if (observed.route_policy_id !== expected.route_policy_id || observed.route_policy_revision !== expected.route_policy_revision) {
        pushIssue(issues, 'CODEX_ROUTE_POLICY_MISMATCH', 'fatal', 'observed route must match codex-subscription-v1@1', role);
    }
    if (observed.request_profile_sha256 !== expected.request_profile_sha256) {
        pushIssue(issues, 'CODEX_REQUEST_PROFILE_MISMATCH', 'fatal', 'observed profile must bind the expected request_profile_sha256', role);
    }
}
function validateContextBoundary(boundary, requirement, issues, role) {
    if (boundary === null) {
        pushIssue(issues, 'CODEX_CONTEXT_BOUNDARY_MISSING', 'fatal', 'context boundary evidence is required', role);
        return;
    }
    if (boundary.context_window !== requirement.context_window ||
        boundary.max_output_tokens !== requirement.max_output_tokens ||
        !sameJson([...boundary.input_modalities].sort(), [...requirement.input_modalities].sort()) ||
        !sameJson([...boundary.output_modalities].sort(), [...requirement.output_modalities].sort())) {
        pushIssue(issues, 'CODEX_CONTEXT_BOUNDARY_MISMATCH', 'fatal', 'context/output/input modality boundary must match the frozen role template', role);
    }
}
function validatePromptBoundary(boundary, observed, requirement, issues, role) {
    if (boundary === null) {
        pushIssue(issues, 'CODEX_PROMPT_BOUNDARY_MISSING', 'fatal', 'prompt boundary evidence is required', role);
        return;
    }
    if (boundary.prompt_body_included) {
        pushIssue(issues, 'CODEX_PROMPT_BOUNDARY_MISMATCH', 'fatal', 'prompt boundary evidence must not contain prompt bodies', role);
    }
    if (boundary.system_prompt_profile !== requirement.system_prompt_profile || boundary.system_prompt_profile !== CODEX_SYSTEM_PROMPT_PROFILE) {
        pushIssue(issues, 'CODEX_PROMPT_PROFILE_MISMATCH', 'fatal', 'prompt profile must be pi-default.v1', role);
    }
    if (!isDigest(boundary.system_prompt_sha256)) {
        pushIssue(issues, 'CODEX_PROMPT_BOUNDARY_MISMATCH', 'fatal', 'system prompt boundary must carry a sha256 digest', role);
    }
    if (observed !== null && boundary.system_prompt_sha256 !== observed.system_prompt_sha256) {
        pushIssue(issues, 'CODEX_PROMPT_BOUNDARY_MISMATCH', 'fatal', 'prompt boundary digest must match observed_profile.system_prompt_sha256', role);
    }
}
function validateCriticalRoleInvariants(profileId, requirement, issues) {
    for (const invariant of CODEX_CRITICAL_ROLE_QUALITY_INVARIANTS) {
        if (!invariant.profile_ids.includes(profileId) || !invariant.roles.includes(requirement.role))
            continue;
        if (!invariant.model_ids.includes(requirement.model_id) ||
            !invariant.thinking_values.includes(requirement.thinking) ||
            !invariant.service_tiers.some((tier) => tier === requirement.service_tier) ||
            requirement.context_window < invariant.min_context_window ||
            requirement.max_output_tokens < invariant.min_max_output_tokens) {
            pushIssue(issues, 'CODEX_CRITICAL_ROLE_INVARIANT_BROKEN', 'fatal', `${invariant.invariant_id} is broken`, requirement.role);
        }
    }
}
function parseRequestProfileWitness(value, issues, role) {
    try {
        return parseAutopilotRosterContract('autopilot.request_profile.v1', value);
    }
    catch (error) {
        const message = errorMessage(error);
        pushIssue(issues, /hash mismatch|sha256|duplicate object member/u.test(message) ? 'CODEX_CORRUPT_W3_EVIDENCE' : 'CODEX_REQUEST_PROFILE_MISMATCH', 'fatal', `request_profile.v1 W3 evidence rejected: ${message}`, role);
        return null;
    }
}
function parseObservedProfileWitness(value, issues, role) {
    try {
        return parseAutopilotRosterContract('autopilot.observed_profile.v1', value);
    }
    catch (error) {
        const message = errorMessage(error);
        pushIssue(issues, /hash mismatch|sha256|duplicate object member/u.test(message) ? 'CODEX_CORRUPT_W3_EVIDENCE' : 'CODEX_RECEIPT_W3_AUTHENTICATION_INVALID', 'fatal', `observed_profile.v1 W3 evidence rejected: ${message}`, role);
        return null;
    }
}
function parseProviderIdentityWitness(value, issues, role) {
    if (value === null) {
        pushIssue(issues, 'CODEX_OBSERVED_EVIDENCE_MISSING', 'fatal', 'observed provider identity is required', role);
        return null;
    }
    const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
    const expected = ['api', 'executed_model_id', 'provider_id', 'requested_model_id', 'thinking_level'];
    if (!sameJson(keys, expected)) {
        pushIssue(issues, 'CODEX_RECEIPT_W3_AUTHENTICATION_INVALID', 'fatal', 'provider_identity fields are not exact', role);
        return null;
    }
    if (typeof value.provider_id !== 'string' ||
        typeof value.requested_model_id !== 'string' ||
        typeof value.executed_model_id !== 'string' ||
        typeof value.api !== 'string' ||
        typeof value.thinking_level !== 'string') {
        pushIssue(issues, 'CODEX_RECEIPT_W3_AUTHENTICATION_INVALID', 'fatal', 'provider_identity values must be strings', role);
        return null;
    }
    return value;
}
function parseUnitSpecWitness(value, issues, role) {
    try {
        return parseAutopilotUnitSpecV2(value);
    }
    catch (error) {
        const message = errorMessage(error);
        pushIssue(issues, /hash mismatch|sha256|duplicate object member/u.test(message) ? 'CODEX_CORRUPT_W3_EVIDENCE' : 'CODEX_UNIT_SPEC_W3_AUTHENTICATION_INVALID', 'fatal', `unit_spec.v2 W3 evidence rejected: ${message}`, role);
        return null;
    }
}
function parseReceiptWitness(value, issues, role) {
    try {
        return parseAutopilotReceiptV2(value);
    }
    catch (error) {
        const message = errorMessage(error);
        const code = /executed_model_id|provider_identity executed_model_id/u.test(message)
            ? 'CODEX_EXECUTED_MODEL_MISMATCH'
            : /hash mismatch|sha256|duplicate object member/u.test(message)
                ? 'CODEX_CORRUPT_W3_EVIDENCE'
                : 'CODEX_RECEIPT_W3_AUTHENTICATION_INVALID';
        pushIssue(issues, code, 'fatal', `receipt.v2 W3 observed evidence rejected: ${message}`, role);
        return null;
    }
}
function roleRequirementFromTemplate(template) {
    return {
        ...template,
        provider_id: CODEX_PROVIDER_ID,
        model: `${CODEX_PROVIDER_ID}/${template.model_id}`,
        route_policy_id: CODEX_ROUTE_POLICY_ID,
        route_policy_revision: CODEX_ROUTE_POLICY_REVISION,
        billing_class: CODEX_BILLING_CLASS,
        billing_route_class: CODEX_BILLING_ROUTE_CLASS,
        auth_class: CODEX_AUTH_CLASS,
        allowed_auth_sources: CODEX_ALLOWED_AUTH_SOURCES,
    };
}
function requestProfileFromRequirement(requirement) {
    const withoutHash = {
        provider_id: requirement.provider_id,
        model_id: requirement.model_id,
        model: requirement.model,
        api: requirement.api,
        thinking: requirement.thinking,
        service_tier: requirement.service_tier,
        cache_policy: requirement.cache_policy,
        system_prompt_profile: requirement.system_prompt_profile,
        context_window: requirement.context_window,
        max_output_tokens: requirement.max_output_tokens,
        input_modalities: requirement.input_modalities,
        output_modalities: requirement.output_modalities,
        reasoning_capability: requirement.reasoning_capability,
        tool_capability: requirement.tool_capability,
        route_policy_id: requirement.route_policy_id,
        route_policy_revision: requirement.route_policy_revision,
    };
    return parseAutopilotRosterContract('autopilot.request_profile.v1', {
        ...withoutHash,
        request_profile_sha256: requiredRosterHash('autopilot.request_profile.v1', {
            ...withoutHash,
            request_profile_sha256: ZERO_DIGEST,
        }),
    });
}
function collectEvidenceRef(value, missingCode, missingSeverity, issues, role, missingMessage) {
    if (value === null) {
        pushIssue(issues, missingCode, missingSeverity, missingMessage, role);
        return null;
    }
    try {
        return parseAutopilotRosterContract('autopilot.evidence_ref.v1', value);
    }
    catch (error) {
        pushIssue(issues, missingCode, 'fatal', `evidence ref rejected: ${errorMessage(error)}`, role);
        return null;
    }
}
function emptyRoleResult(role, issues) {
    return deepFreezeCodex({
        role,
        accepted: false,
        certifying: false,
        synthetic_non_certifying: false,
        requested_model_id: null,
        executed_model_id: null,
        request_profile_sha256: null,
        observed_profile_sha256: null,
        evidence_refs: [],
        issues: sortIssues(issues),
    });
}
function requireCodexRecipe() {
    const recipe = getProviderRecipe(CODEX_RECIPE_ID, CODEX_RECIPE_REVISION);
    if (recipe === null)
        throw new Error('W0 Codex provider recipe seed is missing');
    return recipe;
}
function requireCodexRoutePolicy() {
    const policy = findRoutePolicy(CODEX_ROUTE_POLICY_ID, CODEX_ROUTE_POLICY_REVISION, ROUTE_POLICIES);
    if (policy === null)
        throw new Error('W0 Codex route policy seed is missing');
    return policy;
}
function assertCodexAuthority(recipe, routePolicy) {
    const issues = [];
    if (recipe.recipe_id !== CODEX_RECIPE_ID || recipe.recipe_revision !== CODEX_RECIPE_REVISION)
        issues.push('wrong recipe identity');
    if (recipe.provider_family !== CODEX_PROVIDER_ID)
        issues.push('wrong provider family');
    if (recipe.route_policy_id !== CODEX_ROUTE_POLICY_ID || recipe.route_policy_revision !== CODEX_ROUTE_POLICY_REVISION)
        issues.push('recipe route is not direct codex-subscription-v1@1');
    if (routePolicy.provider_id !== CODEX_PROVIDER_ID)
        issues.push('wrong route provider');
    if (!sameJson(routePolicy.allowed_auth_classes, [CODEX_AUTH_CLASS]))
        issues.push('Codex route must allow only oauth');
    if (!sameJson([...routePolicy.allowed_auth_sources].sort(), [...CODEX_ALLOWED_AUTH_SOURCES].sort()))
        issues.push('Codex route auth sources mismatch');
    if (routePolicy.billing_class !== CODEX_BILLING_CLASS || routePolicy.billing_route_class !== CODEX_BILLING_ROUTE_CLASS)
        issues.push('Codex route billing mismatch');
    if (!sameJson(routePolicy.allowed_apis, [CODEX_API]))
        issues.push('Codex route API mismatch');
    if (!sameJson(routePolicy.allowed_cache_policies, [CODEX_CACHE_POLICY]))
        issues.push('Codex route cache mismatch');
    if (!sameJson(routePolicy.allowed_system_prompt_profiles, [CODEX_SYSTEM_PROMPT_PROFILE]))
        issues.push('Codex route prompt mismatch');
    if (!routePolicy.forbidden_gateways.includes('openrouter') || routePolicy.allowed_auth_classes.includes('api-key'))
        issues.push('Codex route must forbid OpenRouter/API keys');
    if (routePolicy.requires_live_billing_proof !== true)
        issues.push('Codex route must require live billing proof');
    if (recipe.minimum_pi_version !== CODEX_REQUIRED_PI_VERSION)
        issues.push('Codex recipe Pi version mismatch');
    if (recipe.certification_manifest_id !== null || recipe.certification_manifest_sha256 !== null)
        issues.push('Codex W0 seed must not carry certification manifest authority');
    if (recipe.non_certifying_seed !== true)
        issues.push('Codex W0 recipe must remain a non-certifying seed');
    if (!sameJson(recipe.profile_templates.map((profile) => profile.profile_id), PROFILE_ORDER))
        issues.push('Codex profiles must remain in frozen seed order');
    for (const profile of recipe.profile_templates) {
        if (profile.route_policy_id !== CODEX_ROUTE_POLICY_ID || profile.route_policy_revision !== CODEX_ROUTE_POLICY_REVISION) {
            issues.push(`${profile.profile_id} profile route is not direct codex-subscription-v1@1`);
        }
        if (!sameJson(profile.role_templates.map((template) => template.role), ROSTER_ROLE_ORDER)) {
            issues.push(`${profile.profile_id} role order does not match frozen ROLE_ORDER`);
        }
    }
    if (issues.length > 0)
        throw new Error(`Codex provider pack authority mismatch: ${issues.join('; ')}`);
}
function requiredRosterHash(schemaVersion, value) {
    const hash = computeAutopilotRosterContractObjectHash(schemaVersion, value);
    if (hash === null)
        throw new Error(`${schemaVersion} has no hash field`);
    return hash;
}
function uniqueEvidenceRefs(values) {
    const byId = new Map();
    for (const value of values) {
        if (value === null)
            continue;
        const ref = parseAutopilotRosterContract('autopilot.evidence_ref.v1', value);
        byId.set(ref.evidence_id, ref);
    }
    return [...byId.values()].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
}
function isLiveEvidenceRef(ref) {
    return (ref.secret_free === true &&
        ref.kind !== 'synthetic-fixture' &&
        !ref.uri.startsWith('fixture://') &&
        !ref.uri.startsWith('synthetic://') &&
        !ref.uri.startsWith('pending://'));
}
function issueObject(code, severity, message, role) {
    return role === undefined ? { code, severity, message } : { code, severity, message, role };
}
function pushIssue(issues, code, severity, message, role) {
    const candidate = issueObject(code, severity, message, role);
    if (issues.some((issue) => issue.code === candidate.code && issue.role === candidate.role && issue.message === candidate.message))
        return;
    issues.push(candidate);
}
function sortIssues(issues) {
    return [...issues].sort((left, right) => {
        const roleDiff = roleSortIndex(left.role ?? 'extract') - roleSortIndex(right.role ?? 'extract');
        if (left.role !== undefined || right.role !== undefined) {
            if (left.role === undefined)
                return -1;
            if (right.role === undefined)
                return 1;
            if (roleDiff !== 0)
                return roleDiff;
        }
        return left.code.localeCompare(right.code) || left.message.localeCompare(right.message);
    });
}
function roleSortIndex(role) {
    return ROSTER_ROLE_ORDER.indexOf(role);
}
function asRosterRole(value) {
    return ROSTER_ROLE_ORDER.includes(value) ? value : null;
}
function sameJson(left, right) {
    return canonicalJson(left) === canonicalJson(right);
}
function canonicalJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new Error('cannot canonicalize non-finite number');
        return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        const record = value;
        return `{${Object.keys(record).sort((left, right) => left.localeCompare(right)).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    throw new Error(`cannot canonicalize ${typeof value}`);
}
function isDigest(value) {
    return /^sha256:[a-f0-9]{64}$/u.test(value);
}
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
function deepFreezeCodex(value, seen = new WeakSet()) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
        return value;
    const objectValue = value;
    if (seen.has(objectValue))
        return value;
    seen.add(objectValue);
    for (const key of Reflect.ownKeys(objectValue)) {
        deepFreezeCodex(objectValue[key], seen);
    }
    return Object.freeze(objectValue);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
