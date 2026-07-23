import { join } from 'node:path';
import { autopilotRosterContractCanonicalJson, parseAutopilotRosterContract, } from "./contracts.js";
import { assignmentSetSha256, requestProfileFromAssignment, validateRequestProfileForAssignment, parseProviderQualificationManifest, parseProviderRoster, } from "./provider-recipes.js";
import { PHASE37_FIXTURE_CLOCK, PHASE37_PACKAGE_VERSION, PHASE37_PI_VERSION, ROSTER_ROLE_ORDER, ROUTE_POLICIES, authClassForRoute, authSourceForRoute, canonicalSha256, findInventoryModel, findInventoryProvider, findRoutePolicy, findRoutePolicyForProviderApi, isRosterProfileId, isRosterRole, normalizeRosterInventory, validateRouteConformance, } from "./route-policies.js";
import { formatAuthorityPath } from "./paths.js";
import { publishCreateOnlyAtomic, readAuthorityFileIfPresent } from "./transaction.js";
export const CUSTOM_ROSTER_REQUEST_SCHEMA = 'autopilot.custom_roster_request.v1';
export const CUSTOM_ROSTER_INTENT_REQUEST_SCHEMA = 'autopilot.custom_roster_request.v2';
export const CUSTOM_ROSTER_VALIDATION_RESULT_SCHEMA = 'autopilot.custom_roster_validation_result.v1';
export const CUSTOM_ROSTER_CERTIFICATION_AUTHORITY_SCHEMA = 'autopilot.custom_roster_certification_authority.v1';
export const CUSTOM_ROSTER_RECIPE_ID = 'custom-roster';
export const CUSTOM_ROSTER_RECIPE_REVISION = 1;
export const CUSTOM_ROSTER_TOOL_UNSUPPORTED_DIAGNOSTIC = 'ROSTER_CUSTOM_ROSTER_UNSUPPORTED';
const CUSTOM_ROSTER_LIVE_W3_URI_PREFIX = 'w3-evidence://phase37/custom-roster/';
const CUSTOM_REQUEST_ID_PATTERN = /^[a-z][a-z0-9-]{0,95}$/u;
const CUSTOM_ROSTER_ID_PATTERN = /^custom-[a-z0-9][a-z0-9-]{0,83}-[a-f0-9]{12}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_CUSTOM_NATURAL_LANGUAGE_BYTES = 16_000;
const CUSTOM_ROSTER_CERTIFICATION_AUTHORITY_DIR = 'custom-roster-certifications';
export const CURRENT_CUSTOM_ROSTER_TRUST_REGISTRY = deepFreezeCustomRosterAuthority({
    schema_version: 'autopilot.custom_roster_trust_registry.v1',
    live_w3_uri_prefix: CUSTOM_ROSTER_LIVE_W3_URI_PREFIX,
    trusted_manifest_ids: Object.freeze([]),
    trusted_manifest_sha256s: Object.freeze([]),
    trusted_roster_sha256s: Object.freeze([]),
});
function deepFreezeCustomRosterAuthority(value, seen = new WeakSet()) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        return value;
    }
    const objectValue = value;
    if (seen.has(objectValue))
        return value;
    seen.add(objectValue);
    for (const key of Reflect.ownKeys(objectValue)) {
        deepFreezeCustomRosterAuthority(objectValue[key], seen);
    }
    return Object.freeze(objectValue);
}
export function isCustomRosterUnsupportedToolPayload(value) {
    if (!isRecord(value))
        return false;
    const action = value['action'];
    if (typeof action === 'string' && /custom/u.test(action))
        return true;
    return [
        'custom_roster',
        'custom_roster_draft',
        'custom_candidate',
        'custom_request',
        'natural_language_request',
        'qualification_manifest',
        'qualification_manifests',
    ].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}
export function buildUserCustomRosterFromAssignments(input) {
    const assignments = sortAssignmentsByRole(input.assignments);
    const assignment_set_sha256 = assignmentSetSha256(assignments);
    const slug = normalizeCustomSlug(input.slug);
    const roster_id = `custom-${slug}-${assignment_set_sha256.slice('sha256:'.length, 'sha256:'.length + 12)}`;
    const withoutHash = {
        schema_version: 'autopilot.roster.v1',
        roster_id,
        roster_revision: CUSTOM_ROSTER_RECIPE_REVISION,
        display_name: input.display_name.slice(0, 120),
        scope: input.scope,
        selected_scope: input.scope,
        profile_id: normalizeProfileId(input.profile_id ?? 'precision'),
        recipe_id: CUSTOM_ROSTER_RECIPE_ID,
        recipe_revision: CUSTOM_ROSTER_RECIPE_REVISION,
        generation_source: 'user-custom',
        package_version: PHASE37_PACKAGE_VERSION,
        pi_version: PHASE37_PI_VERSION,
        route_policy_ids: uniqueSortedStrings(assignments.map((assignment) => assignment.route_policy_id)),
        assignment_set_sha256,
        assignments,
        capability_summary: summarizeCapabilities(assignments),
        billing_summary: summarizeBilling(assignments),
        auth_summary: summarizeAuth(assignments),
        certification_manifest_id: null,
        certification_manifest_sha256: null,
        created_at: input.created_at,
    };
    return { ...withoutHash, roster_sha256: canonicalSha256(withoutHash) };
}
export function validateCustomRosterSetupRequest(input) {
    const parsed = parseCustomRosterRequest(input.request);
    if (!parsed.ok)
        return invalidCustomValidation(null, ['ROSTER_CUSTOM_REQUEST_SCHEMA_INVALID']);
    const request = parsed.request;
    const rosterParsed = parseCustomRoster(request.roster);
    if (!rosterParsed.ok)
        return invalidCustomValidation(parsed.request_sha256, ['ROSTER_CUSTOM_DRAFT_SCHEMA_INVALID']);
    return validateCustomRosterObject({
        request_sha256: parsed.request_sha256,
        roster: rosterParsed.roster,
        qualification_manifest: request.qualification_manifest,
        inventory: input.inventory,
        scope: request.scope,
        now: input.now,
    });
}
export function validateCustomRosterIntentSetupRequest(input) {
    const parsed = parseCustomRosterIntentRequest(input.request);
    if (!parsed.ok) {
        return Object.freeze({
            request: null,
            roster: null,
            roster_bytes: null,
            qualification_manifest: null,
            qualification_manifest_sha256: null,
            validation: invalidCustomValidation(null, ['ROSTER_CUSTOM_REQUEST_SCHEMA_INVALID']),
        });
    }
    const request = parsed.request;
    const built = buildCustomRosterFromIntent({
        request,
        inventory: input.inventory,
        scope: input.scope,
        created_at: input.created_at ?? PHASE37_FIXTURE_CLOCK,
    });
    if (!built.ok) {
        return Object.freeze({
            request,
            roster: null,
            roster_bytes: null,
            qualification_manifest: request.qualification_manifest,
            qualification_manifest_sha256: request.qualification_manifest === null ? null : safeValueDigest(request.qualification_manifest),
            validation: invalidCustomValidation(parsed.request_sha256, built.codes),
        });
    }
    const validation = validateCustomRosterObject({
        request_sha256: parsed.request_sha256,
        roster: built.roster,
        qualification_manifest: request.qualification_manifest,
        inventory: input.inventory,
        scope: input.scope,
        now: input.now,
    });
    return Object.freeze({
        request,
        roster: built.roster,
        roster_bytes: canonicalRosterBytes(built.roster),
        qualification_manifest: request.qualification_manifest,
        qualification_manifest_sha256: request.qualification_manifest === null ? null : safeValueDigest(request.qualification_manifest),
        validation,
    });
}
function validateCustomRosterObject(input) {
    const structuralCodes = validateCustomRosterStructure({ roster: input.roster, inventory: input.inventory, scope: input.scope });
    const structuralValid = structuralCodes.length === 0;
    const manifestVerification = structuralValid
        ? verifyCustomRosterManifestForRoster({ roster: input.roster, manifest: input.qualification_manifest, now: input.now })
        : null;
    const certificationStatus = manifestVerification?.certification_status ?? (structuralValid ? 'absent' : 'invalid');
    const certificationOk = manifestVerification?.ok === true;
    const providerIds = uniqueSortedStrings(input.roster.assignments.map((assignment) => assignment.provider_id));
    const routePolicyIds = uniqueSortedStrings(input.roster.assignments.map((assignment) => assignment.route_policy_id));
    const manifestCodes = manifestVerification === null ? [] : rosterDiagnosticsForManifestIssues(manifestVerification.issues);
    const diagnostics = diagnosticsFromCodes([
        ...structuralCodes,
        ...manifestCodes,
        ...(certificationOk ? [] : ['ROSTER_QUALIFICATION_REQUIRED']),
    ]);
    return materializeValidationResult({
        schema_version: CUSTOM_ROSTER_VALIDATION_RESULT_SCHEMA,
        ok: certificationOk,
        status: certificationOk ? 'certified' : structuralValid ? 'blocked' : 'failed',
        structural_status: structuralValid ? 'structurally-valid-draft' : 'invalid',
        certification_status: certificationStatus,
        request_sha256: input.request_sha256,
        roster_id: input.roster.roster_id,
        roster_revision: input.roster.roster_revision,
        roster_sha256: input.roster.roster_sha256,
        assignment_set_sha256: input.roster.assignment_set_sha256,
        provider_ids: providerIds,
        route_policy_ids: routePolicyIds,
        mixed_provider_roster: providerIds.length > 1,
        diagnostics,
        write_count: 0,
        lock_count: 0,
        files_touched: [],
    });
}
function invalidCustomValidation(requestSha256, codes) {
    return materializeValidationResult({
        schema_version: CUSTOM_ROSTER_VALIDATION_RESULT_SCHEMA,
        ok: false,
        status: 'failed',
        structural_status: 'invalid',
        certification_status: 'invalid',
        request_sha256: requestSha256,
        roster_id: null,
        roster_revision: null,
        roster_sha256: null,
        assignment_set_sha256: null,
        provider_ids: [],
        route_policy_ids: [],
        mixed_provider_roster: false,
        diagnostics: diagnosticsFromCodes(codes.length === 0 ? ['ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID'] : codes),
        write_count: 0,
        lock_count: 0,
        files_touched: [],
    });
}
export function canonicalRosterBytes(roster) {
    const parsed = parseProviderRoster(roster);
    return new TextEncoder().encode(autopilotRosterContractCanonicalJson(parsed));
}
export function verifyCustomRosterManifestForRoster(input) {
    const requiredEvidence = requiredCustomRosterEvidenceRefs(input.roster);
    const issues = [];
    if (input.manifest === null || input.manifest === undefined) {
        return Object.freeze({
            ok: false,
            certification_status: 'absent',
            manifest: null,
            required_evidence: requiredEvidence,
            issues: Object.freeze([issue('W5_CUSTOM_MANIFEST_ABSENT', 'custom roster certification manifest is absent')]),
        });
    }
    const manifest = parseManifest(input.manifest);
    if (manifest === null) {
        return Object.freeze({
            ok: false,
            certification_status: 'invalid',
            manifest: null,
            required_evidence: requiredEvidence,
            issues: Object.freeze([issue('W5_CUSTOM_MANIFEST_SCHEMA_INVALID', 'custom roster manifest fails certification_manifest.v1 closed schema or hash validation')]),
        });
    }
    const trusted = CURRENT_CUSTOM_ROSTER_TRUST_REGISTRY;
    if (!trusted.trusted_manifest_ids.includes(manifest.manifest_id) ||
        !trusted.trusted_manifest_sha256s.includes(manifest.manifest_sha256) ||
        !trusted.trusted_roster_sha256s.includes(input.roster.roster_sha256)) {
        issues.push(issue('W5_CUSTOM_MANIFEST_HASH_UNTRUSTED', 'custom roster manifest and roster hash are not pinned by the current package trust registry'));
    }
    if (manifest.subject_kind !== 'custom_roster' ||
        manifest.subject_id !== input.roster.roster_id ||
        manifest.subject_sha256 !== input.roster.roster_sha256 ||
        manifest.package_version !== PHASE37_PACKAGE_VERSION ||
        manifest.pi_version !== PHASE37_PI_VERSION) {
        issues.push(issue('W5_CUSTOM_MANIFEST_BINDING_MISMATCH', 'manifest must bind subject_kind custom_roster to the exact roster id/hash and package/Pi versions'));
    }
    if (!manifestTimeIsValid(manifest, input.now ?? new Date())) {
        issues.push(issue('W5_CUSTOM_MANIFEST_TIME_INVALID', 'manifest issued_at/expires_at window is invalid or stale'));
    }
    if (manifest.qualification_state !== 'w4-certified-ready') {
        issues.push(issue('W5_CUSTOM_MANIFEST_NOT_READY', 'manifest qualification_state is not w4-certified-ready'));
    }
    if (!sameEvidenceRefs(manifest.required_evidence, requiredEvidence)) {
        issues.push(issue('W5_CUSTOM_MANIFEST_REQUIRED_EVIDENCE_MISMATCH', 'manifest required evidence must exactly match the custom roster role/request/route evidence preimage'));
    }
    if (!roleResultsCoverCustomRoster(manifest, input.roster, requiredEvidence)) {
        issues.push(issue('W5_CUSTOM_MANIFEST_ROLE_COVERAGE_MISMATCH', 'manifest role results must pass every Autopilot role with exact trusted W3 execution evidence'));
    }
    if (!liveEvidenceCoversCustomRoster(manifest, input.roster, requiredEvidence)) {
        issues.push(issue('W5_CUSTOM_MANIFEST_LIVE_EVIDENCE_UNTRUSTED', 'manifest live evidence must be trusted authenticated no-fallback W3 route, billing, prompt, cache, and execution refs'));
    }
    const uniqueIssues = uniqueIssuesByCode(issues);
    return Object.freeze({
        ok: uniqueIssues.length === 0,
        certification_status: uniqueIssues.length === 0
            ? 'autopilot-certified'
            : uniqueIssues.some((entry) => entry.code === 'W5_CUSTOM_MANIFEST_HASH_UNTRUSTED')
                ? 'untrusted'
                : 'invalid',
        manifest,
        required_evidence: requiredEvidence,
        issues: Object.freeze(uniqueIssues),
    });
}
export function requiredCustomRosterEvidenceRefs(roster) {
    const prefix = `custom-${roster.roster_sha256.slice('sha256:'.length, 'sha256:'.length + 12)}`;
    return deepFreezeCustomRosterAuthority(sortEvidenceRefs([
        evidenceRef(`${prefix}-billing-proof`, 'billing-proof', `witness-required://phase37/custom-roster/${roster.roster_id}/billing`, null, null),
        evidenceRef(`${prefix}-cache-proof`, 'cache-proof', `witness-required://phase37/custom-roster/${roster.roster_id}/cache`, null, null),
        evidenceRef(`${prefix}-prompt-proof`, 'prompt-proof', `witness-required://phase37/custom-roster/${roster.roster_id}/prompt`, null, null),
        evidenceRef(`${prefix}-route-proof`, 'route-proof', `witness-required://phase37/custom-roster/${roster.roster_id}/route`, null, null),
        ...ROSTER_ROLE_ORDER.map((role) => evidenceRef(`${prefix}-exec-${role}-proof`, 'execution-proof', `witness-required://phase37/custom-roster/${roster.roster_id}/execution/${role}`, null, null)),
    ]));
}
export function customRosterCertificationAuthorityPath(paths, roster) {
    return join(paths.authorityRoot, CUSTOM_ROSTER_CERTIFICATION_AUTHORITY_DIR, roster.roster_id, `${roster.roster_sha256.slice('sha256:'.length)}.json`);
}
export function buildCustomRosterCertificationAuthority(input) {
    const manifest = parseManifest(input.manifest);
    if (manifest === null)
        throw new Error('custom roster certification authority requires a closed certification manifest');
    const withoutHash = {
        schema_version: CUSTOM_ROSTER_CERTIFICATION_AUTHORITY_SCHEMA,
        roster_id: input.roster.roster_id,
        roster_revision: input.roster.roster_revision,
        roster_sha256: input.roster.roster_sha256,
        validation_result_sha256: input.validation_result_sha256,
        manifest_id: manifest.manifest_id,
        manifest_sha256: manifest.manifest_sha256,
        qualification_manifest: manifest,
        secret_free: true,
    };
    return Object.freeze({ ...withoutHash, authority_sha256: canonicalSha256(withoutHash) });
}
export function parseCustomRosterCertificationAuthority(value) {
    if (!isRecord(value))
        return null;
    const expected = new Set(['schema_version', 'roster_id', 'roster_revision', 'roster_sha256', 'validation_result_sha256', 'manifest_id', 'manifest_sha256', 'qualification_manifest', 'secret_free', 'authority_sha256']);
    const keys = Object.keys(value);
    if (keys.length !== expected.size || !keys.every((key) => expected.has(key)))
        return null;
    if (value['schema_version'] !== CUSTOM_ROSTER_CERTIFICATION_AUTHORITY_SCHEMA ||
        typeof value['roster_id'] !== 'string' || !CUSTOM_ROSTER_ID_PATTERN.test(value['roster_id']) ||
        typeof value['roster_revision'] !== 'number' || !Number.isSafeInteger(value['roster_revision']) || value['roster_revision'] < 1 ||
        typeof value['roster_sha256'] !== 'string' || !DIGEST_PATTERN.test(value['roster_sha256']) ||
        typeof value['validation_result_sha256'] !== 'string' || !DIGEST_PATTERN.test(value['validation_result_sha256']) ||
        typeof value['manifest_id'] !== 'string' || value['manifest_id'].length === 0 || value['manifest_id'].length > 120 ||
        typeof value['manifest_sha256'] !== 'string' || !DIGEST_PATTERN.test(value['manifest_sha256']) ||
        value['secret_free'] !== true ||
        typeof value['authority_sha256'] !== 'string' || !DIGEST_PATTERN.test(value['authority_sha256'])) {
        return null;
    }
    const rosterSha256 = value['roster_sha256'];
    const validationResultSha256 = value['validation_result_sha256'];
    const manifestSha256 = value['manifest_sha256'];
    const authoritySha256 = value['authority_sha256'];
    const manifest = parseManifest(value['qualification_manifest']);
    if (manifest === null || manifest.manifest_id !== value['manifest_id'] || manifest.manifest_sha256 !== manifestSha256)
        return null;
    const withoutHash = {
        schema_version: CUSTOM_ROSTER_CERTIFICATION_AUTHORITY_SCHEMA,
        roster_id: value['roster_id'],
        roster_revision: value['roster_revision'],
        roster_sha256: rosterSha256,
        validation_result_sha256: validationResultSha256,
        manifest_id: value['manifest_id'],
        manifest_sha256: manifestSha256,
        qualification_manifest: manifest,
        secret_free: true,
    };
    if (canonicalSha256(withoutHash) !== authoritySha256)
        return null;
    return Object.freeze({ ...withoutHash, authority_sha256: authoritySha256 });
}
export async function publishCustomRosterCertificationAuthority(input) {
    try {
        const authority = buildCustomRosterCertificationAuthority(input);
        const path = customRosterCertificationAuthorityPath(input.paths, input.roster);
        const bytes = new TextEncoder().encode(autopilotRosterContractCanonicalJson(authority));
        const publish = await publishCreateOnlyAtomic({ path, authorityRoot: input.paths.authorityRoot, bytes });
        const displayPath = formatAuthorityPath(path, input.paths.authorityRoot, input.paths.authorityDisplayRoot);
        if (publish.status === 'conflict') {
            return Object.freeze({
                ok: false,
                status: 'blocked',
                authority: null,
                path,
                display_path: displayPath,
                diagnostics: diagnosticsFromCodes(['ROSTER_CREATE_ONLY_CONFLICT']),
                write_count: 0,
                lock_count: 0,
                files_touched: [],
            });
        }
        return Object.freeze({
            ok: true,
            status: publish.status === 'created' ? 'published' : 'inspected',
            authority,
            path,
            display_path: displayPath,
            diagnostics: [],
            write_count: publish.status === 'created' ? 1 : 0,
            lock_count: 0,
            files_touched: publish.status === 'created' ? [displayPath] : [],
        });
    }
    catch {
        return Object.freeze({
            ok: false,
            status: 'failed',
            authority: null,
            path: null,
            display_path: null,
            diagnostics: diagnosticsFromCodes(['ROSTER_READBACK_MISMATCH']),
            write_count: 0,
            lock_count: 0,
            files_touched: [],
        });
    }
}
export async function readCustomRosterCertificationAuthority(input) {
    const path = customRosterCertificationAuthorityPath(input.paths, input.roster);
    const read = await readAuthorityFileIfPresent(path, input.paths.authorityRoot);
    if (read === null)
        return { ok: false, reason: 'absent' };
    try {
        const parsed = JSON.parse(Buffer.from(read.bytes).toString('utf8'));
        const authority = parseCustomRosterCertificationAuthority(parsed);
        if (authority === null ||
            authority.roster_id !== input.roster.roster_id ||
            authority.roster_revision !== input.roster.roster_revision ||
            authority.roster_sha256 !== input.roster.roster_sha256) {
            return { ok: false, reason: 'invalid' };
        }
        return { ok: true, authority };
    }
    catch {
        return { ok: false, reason: 'invalid' };
    }
}
function parseCustomRosterRequest(value) {
    if (!isRecord(value))
        return { ok: false };
    const expected = new Set(['schema_version', 'request_id', 'scope', 'natural_language_request', 'roster', 'qualification_manifest']);
    const keys = Object.keys(value);
    if (keys.length !== expected.size || !keys.every((key) => expected.has(key)))
        return { ok: false };
    const schemaVersion = value['schema_version'];
    const requestId = value['request_id'];
    const scope = value['scope'];
    const natural = value['natural_language_request'];
    const manifest = value['qualification_manifest'];
    if (schemaVersion !== CUSTOM_ROSTER_REQUEST_SCHEMA ||
        typeof requestId !== 'string' || !CUSTOM_REQUEST_ID_PATTERN.test(requestId) ||
        (scope !== 'user' && scope !== 'trusted-project') ||
        typeof natural !== 'string' || natural.length === 0 || natural.includes('\u0000') ||
        Buffer.byteLength(natural, 'utf8') > MAX_CUSTOM_NATURAL_LANGUAGE_BYTES ||
        (manifest !== null && !isRecord(manifest))) {
        return { ok: false };
    }
    const request = Object.freeze({
        schema_version: CUSTOM_ROSTER_REQUEST_SCHEMA,
        request_id: requestId,
        scope,
        natural_language_request: natural,
        roster: value['roster'],
        qualification_manifest: manifest,
    });
    return { ok: true, request, request_sha256: customRequestSha256(request) };
}
function customRequestSha256(request) {
    return canonicalSha256({
        schema_version: request.schema_version,
        request_id: request.request_id,
        scope: request.scope,
        natural_language_request_sha256: canonicalSha256({ natural_language_request: request.natural_language_request }),
        roster_sha256: safeValueDigest(request.roster),
        qualification_manifest_sha256: request.qualification_manifest === null ? null : safeValueDigest(request.qualification_manifest),
    });
}
function parseCustomRosterIntentRequest(value) {
    if (!isRecord(value))
        return { ok: false };
    const expected = new Set(['schema_version', 'request_id', 'natural_language_request', 'profile_id', 'role_assignment_intent', 'qualification_manifest']);
    const keys = Object.keys(value);
    if (keys.length !== expected.size || !keys.every((key) => expected.has(key)))
        return { ok: false };
    const schemaVersion = value['schema_version'];
    const requestId = value['request_id'];
    const natural = value['natural_language_request'];
    const profileId = value['profile_id'];
    const manifest = value['qualification_manifest'];
    const intents = parseRoleAssignmentIntent(value['role_assignment_intent']);
    if (schemaVersion !== CUSTOM_ROSTER_INTENT_REQUEST_SCHEMA ||
        typeof requestId !== 'string' || !CUSTOM_REQUEST_ID_PATTERN.test(requestId) ||
        typeof natural !== 'string' || natural.length === 0 || natural.includes('\u0000') ||
        Buffer.byteLength(natural, 'utf8') > MAX_CUSTOM_NATURAL_LANGUAGE_BYTES ||
        typeof profileId !== 'string' || !isRosterProfileId(profileId) ||
        intents === null ||
        (manifest !== null && !isRecord(manifest))) {
        return { ok: false };
    }
    const request = Object.freeze({
        schema_version: CUSTOM_ROSTER_INTENT_REQUEST_SCHEMA,
        request_id: requestId,
        natural_language_request: natural,
        profile_id: profileId,
        role_assignment_intent: Object.freeze(intents),
        qualification_manifest: manifest,
    });
    return { ok: true, request, request_sha256: customIntentRequestSha256(request) };
}
function parseRoleAssignmentIntent(value) {
    if (!Array.isArray(value) || value.length !== ROSTER_ROLE_ORDER.length)
        return null;
    const output = [];
    const seen = new Set();
    for (const entry of value) {
        if (!isRecord(entry))
            return null;
        const allowed = new Set(['role', 'provider_id', 'model_id', 'api', 'thinking', 'service_tier', 'cache_policy', 'system_prompt_profile']);
        const keys = Object.keys(entry);
        if (!keys.every((key) => allowed.has(key)))
            return null;
        for (const key of ['role', 'provider_id', 'model_id', 'api', 'thinking']) {
            if (!Object.prototype.hasOwnProperty.call(entry, key))
                return null;
        }
        const role = entry['role'];
        const providerId = entry['provider_id'];
        const modelId = entry['model_id'];
        const api = entry['api'];
        const thinking = entry['thinking'];
        const serviceTier = Object.prototype.hasOwnProperty.call(entry, 'service_tier') ? entry['service_tier'] : undefined;
        const cachePolicy = Object.prototype.hasOwnProperty.call(entry, 'cache_policy') ? entry['cache_policy'] : undefined;
        const systemPromptProfile = Object.prototype.hasOwnProperty.call(entry, 'system_prompt_profile') ? entry['system_prompt_profile'] : undefined;
        if (typeof role !== 'string' || !isRosterRole(role) || seen.has(role) ||
            typeof providerId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(providerId) ||
            typeof modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u.test(modelId) ||
            !isApiId(api) ||
            !isThinkingValue(thinking) ||
            (serviceTier !== undefined && !isServiceTier(serviceTier)) ||
            (cachePolicy !== undefined && !isCachePolicy(cachePolicy)) ||
            (systemPromptProfile !== undefined && !isSystemPromptProfile(systemPromptProfile))) {
            return null;
        }
        seen.add(role);
        output.push(Object.freeze({
            role,
            provider_id: providerId,
            model_id: modelId,
            api,
            thinking,
            ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
            ...(cachePolicy === undefined ? {} : { cache_policy: cachePolicy }),
            ...(systemPromptProfile === undefined ? {} : { system_prompt_profile: systemPromptProfile }),
        }));
    }
    const roles = output.map((entry) => entry.role).sort((left, right) => ROSTER_ROLE_ORDER.indexOf(left) - ROSTER_ROLE_ORDER.indexOf(right));
    return sameStrings(roles, ROSTER_ROLE_ORDER) ? output : null;
}
function customIntentRequestSha256(request) {
    return canonicalSha256({
        schema_version: request.schema_version,
        request_id: request.request_id,
        natural_language_request_sha256: canonicalSha256({ natural_language_request: request.natural_language_request }),
        profile_id: request.profile_id,
        role_assignment_intent: request.role_assignment_intent,
        qualification_manifest_sha256: request.qualification_manifest === null ? null : safeValueDigest(request.qualification_manifest),
    });
}
function safeValueDigest(value) {
    try {
        return canonicalSha256(value);
    }
    catch {
        return canonicalSha256({ invalid_canonical_value: true });
    }
}
function parseCustomRoster(value) {
    try {
        return { ok: true, roster: parseProviderRoster(value) };
    }
    catch {
        return { ok: false };
    }
}
function buildCustomRosterFromIntent(input) {
    const inventory = normalizeRosterInventory(input.inventory);
    const codes = new Set();
    if (input.scope === 'trusted-project' && !inventory.project_trusted)
        codes.add('ROSTER_PROJECT_UNTRUSTED');
    const assignments = [];
    const qualificationState = input.request.qualification_manifest === null ? 'qualification-required' : 'w4-certified-ready';
    for (const intent of sortIntentByRole(input.request.role_assignment_intent)) {
        const built = assignmentFromIntent({ intent, inventory, qualification_state: qualificationState });
        for (const code of built.codes)
            codes.add(code);
        if (built.assignment !== null)
            assignments.push(built.assignment);
    }
    if (assignments.length !== ROSTER_ROLE_ORDER.length || !sameStrings(assignments.map((assignment) => assignment.role), ROSTER_ROLE_ORDER)) {
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    }
    if (codes.size > 0 && assignments.length !== ROSTER_ROLE_ORDER.length)
        return { ok: false, codes: [...codes].sort((left, right) => left.localeCompare(right)) };
    try {
        const roster = buildUserCustomRosterFromAssignments({
            slug: input.request.request_id,
            display_name: `User custom roster (${input.request.profile_id})`,
            scope: input.scope,
            profile_id: input.request.profile_id,
            assignments,
            created_at: input.created_at,
        });
        return { ok: true, roster };
    }
    catch {
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
        return { ok: false, codes: [...codes].sort((left, right) => left.localeCompare(right)) };
    }
}
function assignmentFromIntent(input) {
    const codes = new Set();
    const provider = findInventoryProvider(input.inventory, input.intent.provider_id);
    if (provider === null)
        return { assignment: null, codes: ['ROSTER_CUSTOM_MODEL_UNREGISTERED'] };
    const model = findInventoryModel(provider, input.intent.model_id, input.intent.api);
    if (model === null)
        return { assignment: null, codes: ['ROSTER_CUSTOM_MODEL_UNREGISTERED'] };
    const routePolicy = findRoutePolicyForProviderApi(provider.provider_id, input.intent.api, ROUTE_POLICIES);
    if (routePolicy === null)
        codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
    const serviceTier = input.intent.service_tier ?? preferredServiceTier(model);
    const cachePolicy = input.intent.cache_policy ?? preferredCachePolicy(model);
    const systemPromptProfile = input.intent.system_prompt_profile ?? preferredSystemPromptProfile(model);
    if (!model.thinking_values.includes(input.intent.thinking))
        codes.add('ROSTER_CUSTOM_THINKING_UNREGISTERED');
    if (!model.service_tiers.some((tier) => tier === serviceTier))
        codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
    if (!model.cache_policies.includes(cachePolicy))
        codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
    if (!model.system_prompt_profiles.includes(systemPromptProfile))
        codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
    if (routePolicy === null)
        return { assignment: null, codes: [...codes].sort((left, right) => left.localeCompare(right)) };
    const withoutHash = {
        role: input.intent.role,
        provider_id: provider.provider_id,
        model_id: model.model_id,
        model: `${provider.provider_id}/${model.model_id}`,
        api: model.api,
        thinking: input.intent.thinking,
        service_tier: serviceTier,
        cache_policy: cachePolicy,
        system_prompt_profile: systemPromptProfile,
        context_window: model.context_window,
        max_output_tokens: model.max_output_tokens,
        input_modalities: model.input_modalities,
        output_modalities: model.output_modalities,
        reasoning_capability: model.reasoning_capability,
        tool_capability: model.tool_capability,
        route_policy_id: routePolicy.route_policy_id,
        route_policy_revision: routePolicy.revision,
        billing_class: routePolicy.billing_class,
        billing_route_class: routePolicy.billing_route_class,
        auth_class: authClassForRoute(provider),
        auth_source: authSourceForRoute(provider),
        qualification_state: input.qualification_state,
    };
    return {
        assignment: { ...withoutHash, assignment_sha256: canonicalSha256(withoutHash) },
        codes: [...codes].sort((left, right) => left.localeCompare(right)),
    };
}
function preferredServiceTier(model) {
    return model.service_tiers.find((tier) => tier === null) ?? model.service_tiers[0] ?? null;
}
function preferredCachePolicy(model) {
    return model.cache_policies.includes('provider-default') ? 'provider-default' : model.cache_policies[0] ?? 'provider-default';
}
function preferredSystemPromptProfile(model) {
    return model.system_prompt_profiles.includes('pi-default.v1') ? 'pi-default.v1' : model.system_prompt_profiles[0] ?? 'pi-default.v1';
}
function sortIntentByRole(intents) {
    return [...intents].sort((left, right) => ROSTER_ROLE_ORDER.indexOf(left.role) - ROSTER_ROLE_ORDER.indexOf(right.role));
}
function isApiId(value) {
    return value === 'openai-codex-responses' || value === 'anthropic-messages' || value === 'openai-completions';
}
function isThinkingValue(value) {
    return value === 'high' || value === 'xhigh';
}
function isServiceTier(value) {
    return value === null || value === 'priority';
}
function isCachePolicy(value) {
    return value === 'provider-default' || value === 'none' || value === 'short' || value === 'long';
}
function isSystemPromptProfile(value) {
    return value === 'pi-default.v1' || value === 'anthropic-autopilot-sanitized.v1';
}
function validateCustomRosterStructure(input) {
    const codes = new Set();
    const roster = input.roster;
    const inventory = normalizeRosterInventory(input.inventory);
    if (input.scope === 'trusted-project' && !inventory.project_trusted)
        codes.add('ROSTER_PROJECT_UNTRUSTED');
    if (roster.scope !== input.scope || roster.selected_scope !== input.scope)
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    if (roster.generation_source !== 'user-custom')
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    if (roster.recipe_id !== CUSTOM_ROSTER_RECIPE_ID || roster.recipe_revision !== CUSTOM_ROSTER_RECIPE_REVISION)
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    if (!CUSTOM_ROSTER_ID_PATTERN.test(roster.roster_id))
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    if (roster.package_version !== PHASE37_PACKAGE_VERSION || roster.pi_version !== PHASE37_PI_VERSION)
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    const sortedAssignments = sortAssignmentsByRole(roster.assignments);
    if (!sameStrings(sortedAssignments.map((assignment) => assignment.role), ROSTER_ROLE_ORDER))
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    try {
        if (assignmentSetSha256(sortedAssignments) !== roster.assignment_set_sha256)
            codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    }
    catch {
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    }
    if (!sameStrings(roster.route_policy_ids, uniqueSortedStrings(sortedAssignments.map((assignment) => assignment.route_policy_id)))) {
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    }
    if (!jsonEqual(roster.capability_summary, summarizeCapabilities(sortedAssignments)))
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    const billing = safeSummarizeBilling(sortedAssignments);
    if (billing === null || !jsonEqual(roster.billing_summary, billing))
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    if (!jsonEqual(roster.auth_summary, summarizeAuth(sortedAssignments)))
        codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
    for (const assignment of sortedAssignments) {
        const provider = findInventoryProvider(inventory, assignment.provider_id);
        if (provider === null) {
            codes.add('ROSTER_CUSTOM_MODEL_UNREGISTERED');
            continue;
        }
        if (assignment.auth_class !== authClassForRoute(provider) || assignment.auth_source !== authSourceForRoute(provider)) {
            codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
        }
        const model = findInventoryModel(provider, assignment.model_id, assignment.api);
        if (model === null) {
            codes.add('ROSTER_CUSTOM_MODEL_UNREGISTERED');
        }
        else {
            if (!model.thinking_values.includes(assignment.thinking))
                codes.add('ROSTER_CUSTOM_THINKING_UNREGISTERED');
            if (!model.service_tiers.some((tier) => tier === assignment.service_tier))
                codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
            if (!model.cache_policies.includes(assignment.cache_policy))
                codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
            if (!model.system_prompt_profiles.includes(assignment.system_prompt_profile))
                codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
            if (assignment.context_window > model.context_window || assignment.max_output_tokens > model.max_output_tokens)
                codes.add('ROSTER_CUSTOM_CONTEXT_UNREGISTERED');
            if (!assignment.input_modalities.every((modality) => model.input_modalities.includes(modality)))
                codes.add('ROSTER_CUSTOM_CONTEXT_UNREGISTERED');
            if (!assignment.output_modalities.every((modality) => model.output_modalities.includes(modality)))
                codes.add('ROSTER_CUSTOM_CONTEXT_UNREGISTERED');
            if (assignment.reasoning_capability === 'reasoning-supported' && model.reasoning_capability !== 'reasoning-supported')
                codes.add('ROSTER_CUSTOM_CONTEXT_UNREGISTERED');
            if (assignment.tool_capability === 'tool-use-supported' && model.tool_capability !== 'tool-use-supported')
                codes.add('ROSTER_CUSTOM_TOOL_UNREGISTERED');
        }
        const routePolicy = findRoutePolicy(assignment.route_policy_id, assignment.route_policy_revision, ROUTE_POLICIES);
        if (routePolicy === null || routePolicy.provider_id !== assignment.provider_id)
            codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
        const routeDiagnostics = validateRouteConformance(assignment, ROUTE_POLICIES);
        for (const diagnostic of routeDiagnostics) {
            codes.add(diagnostic.code);
            if (diagnostic.code === 'ROSTER_ROUTE_FORBIDDEN' || diagnostic.code === 'ROSTER_AUTH_CHANNEL_FORBIDDEN' || diagnostic.code === 'ROSTER_AUTH_REQUIRED') {
                codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
            }
        }
        const requestProfile = requestProfileFromAssignment(assignment);
        try {
            parseAutopilotRosterContract('autopilot.request_profile.v1', requestProfile);
        }
        catch {
            codes.add('ROSTER_REQUEST_PROFILE_DRIFT');
        }
        for (const diagnostic of validateRequestProfileForAssignment(requestProfile, assignment))
            codes.add(diagnostic.code);
    }
    return [...codes].sort((left, right) => left.localeCompare(right));
}
function parseManifest(value) {
    try {
        return parseProviderQualificationManifest(value);
    }
    catch {
        return null;
    }
}
function issue(code, message) {
    return Object.freeze({ code, message });
}
function uniqueIssuesByCode(issues) {
    return [...new Map(issues.map((entry) => [entry.code, entry])).values()].sort((left, right) => left.code.localeCompare(right.code));
}
function manifestTimeIsValid(manifest, now) {
    const issued = Date.parse(manifest.issued_at);
    const expires = Date.parse(manifest.expires_at);
    const current = now.getTime();
    return Number.isFinite(issued) && Number.isFinite(expires) && expires > issued && current >= issued && current < expires;
}
function sameEvidenceRefs(left, right) {
    return JSON.stringify(sortEvidenceRefs(left)) === JSON.stringify(sortEvidenceRefs(right));
}
function sortEvidenceRefs(refs) {
    return [...refs].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
}
function evidenceRef(evidence_id, kind, uri, sha256, byte_count) {
    return Object.freeze({ evidence_id, kind, uri, sha256, byte_count, secret_free: true });
}
function evidenceIdentity(ref) {
    return canonicalSha256(ref);
}
function requiredExecutionEvidenceRefForRole(requiredEvidence, role) {
    return requiredEvidence.find((ref) => ref.kind === 'execution-proof' && ref.evidence_id.endsWith(`-${role}-proof`)) ?? null;
}
function requiredEvidenceRefForKind(requiredEvidence, kind) {
    return requiredEvidence.find((ref) => ref.kind === kind) ?? null;
}
function roleResultsCoverCustomRoster(manifest, roster, requiredEvidence) {
    const liveEvidenceKeys = new Set(manifest.live_evidence.map(evidenceIdentity));
    for (const role of ROSTER_ROLE_ORDER) {
        const required = requiredExecutionEvidenceRefForRole(requiredEvidence, role);
        const result = manifest.role_results.find((entry) => entry.role === role);
        if (required === null || result === undefined || result.state !== 'pass')
            return false;
        if (result.evidence_refs.length !== 1)
            return false;
        const ref = result.evidence_refs[0];
        if (ref === undefined || ref.evidence_id !== required.evidence_id || ref.kind !== 'execution-proof')
            return false;
        if (!isTrustedCustomLiveW3EvidenceRef(ref, roster))
            return false;
        if (!liveEvidenceKeys.has(evidenceIdentity(ref)))
            return false;
    }
    return true;
}
function liveEvidenceCoversCustomRoster(manifest, roster, requiredEvidence) {
    const requiredIds = new Set(requiredEvidence.map((ref) => ref.evidence_id));
    for (const kind of ['route-proof', 'billing-proof', 'prompt-proof', 'cache-proof']) {
        const required = requiredEvidenceRefForKind(requiredEvidence, kind);
        if (required === null)
            return false;
        const live = manifest.live_evidence.find((ref) => ref.evidence_id === required.evidence_id && ref.kind === required.kind);
        if (live === undefined || !isTrustedCustomLiveW3EvidenceRef(live, roster))
            return false;
    }
    for (const role of ROSTER_ROLE_ORDER) {
        const required = requiredExecutionEvidenceRefForRole(requiredEvidence, role);
        if (required === null)
            return false;
        const live = manifest.live_evidence.find((ref) => ref.evidence_id === required.evidence_id && ref.kind === 'execution-proof');
        if (live === undefined || !isTrustedCustomLiveW3EvidenceRef(live, roster))
            return false;
    }
    return manifest.live_evidence.every((ref) => requiredIds.has(ref.evidence_id) && isTrustedCustomLiveW3EvidenceRef(ref, roster));
}
function isTrustedCustomLiveW3EvidenceRef(ref, roster) {
    const lowerUri = ref.uri.toLowerCase();
    const lowerId = ref.evidence_id.toLowerCase();
    return ref.secret_free === true &&
        ref.kind !== 'synthetic-fixture' &&
        ref.uri.startsWith(`${CURRENT_CUSTOM_ROSTER_TRUST_REGISTRY.live_w3_uri_prefix}${roster.roster_id}/`) &&
        lowerUri.includes('/authenticated/') &&
        lowerUri.includes('/no-fallback/') &&
        !lowerUri.startsWith('fixture://') &&
        !lowerUri.startsWith('synthetic://') &&
        !lowerUri.startsWith('offline-artifact://') &&
        !lowerUri.startsWith('qualification-required://') &&
        !lowerUri.includes('fixture') &&
        !lowerUri.includes('synthetic') &&
        !lowerUri.includes('offline') &&
        !lowerUri.includes('test') &&
        !lowerId.startsWith('fixture-') &&
        !lowerId.includes('synthetic') &&
        !lowerId.includes('offline') &&
        DIGEST_PATTERN.test(ref.sha256 ?? '') &&
        typeof ref.byte_count === 'number' &&
        ref.byte_count > 0;
}
function rosterDiagnosticsForManifestIssues(issues) {
    const codes = [];
    for (const issueEntry of issues) {
        switch (issueEntry.code) {
            case 'W5_CUSTOM_MANIFEST_ABSENT':
                break;
            case 'W5_CUSTOM_MANIFEST_SCHEMA_INVALID':
                codes.push('ROSTER_CUSTOM_MANIFEST_SCHEMA_INVALID');
                break;
            case 'W5_CUSTOM_MANIFEST_HASH_UNTRUSTED':
                codes.push('ROSTER_CUSTOM_MANIFEST_HASH_UNTRUSTED');
                break;
            case 'W5_CUSTOM_MANIFEST_BINDING_MISMATCH':
                codes.push('ROSTER_CUSTOM_MANIFEST_BINDING_MISMATCH');
                break;
            case 'W5_CUSTOM_MANIFEST_TIME_INVALID':
                codes.push('ROSTER_CUSTOM_MANIFEST_TIME_INVALID');
                break;
            case 'W5_CUSTOM_MANIFEST_NOT_READY':
                codes.push('ROSTER_CUSTOM_MANIFEST_NOT_READY');
                break;
            case 'W5_CUSTOM_MANIFEST_REQUIRED_EVIDENCE_MISMATCH':
                codes.push('ROSTER_CUSTOM_MANIFEST_REQUIRED_EVIDENCE_MISMATCH');
                break;
            case 'W5_CUSTOM_MANIFEST_ROLE_COVERAGE_MISMATCH':
                codes.push('ROSTER_CUSTOM_MANIFEST_ROLE_COVERAGE_MISMATCH');
                break;
            case 'W5_CUSTOM_MANIFEST_LIVE_EVIDENCE_UNTRUSTED':
                codes.push('ROSTER_CUSTOM_MANIFEST_LIVE_EVIDENCE_UNTRUSTED');
                break;
        }
    }
    return codes;
}
function diagnosticsFromCodes(codes) {
    const byCode = new Map();
    for (const code of codes)
        byCode.set(code, diagnosticForCode(code));
    return Object.freeze([...byCode.values()].sort((left, right) => left.code.localeCompare(right.code)));
}
function diagnosticForCode(code) {
    return Object.freeze({
        code: /^ROSTER_[A-Z0-9_]+$/u.test(code) ? code : 'ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID',
        severity: severityForCode(code),
        message: messageForCode(code),
        remediation: 'Keep the custom roster as a draft until package validation and an exact trusted custom_roster W3 certification manifest approve the exact roster hash.',
        secret_free: true,
    });
}
function severityForCode(code) {
    if (code === 'ROSTER_QUALIFICATION_REQUIRED')
        return 'warning';
    if (code === 'ROSTER_CUSTOM_REQUEST_SCHEMA_INVALID' || code === 'ROSTER_CUSTOM_DRAFT_SCHEMA_INVALID')
        return 'fatal';
    return 'error';
}
function messageForCode(code) {
    switch (code) {
        case 'ROSTER_CUSTOM_REQUEST_SCHEMA_INVALID':
            return 'Custom roster setup request must match the closed package custom request schema.';
        case 'ROSTER_CUSTOM_DRAFT_SCHEMA_INVALID':
            return 'Custom roster draft must be a closed autopilot.roster.v1 object with exact canonical hashes.';
        case 'ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID':
            return 'Custom roster draft structure, role coverage, summaries, package binding, or custom identity is invalid.';
        case 'ROSTER_CUSTOM_MODEL_UNREGISTERED':
            return 'Custom roster references a provider/model/API tuple absent from the current model registry inventory.';
        case 'ROSTER_CUSTOM_THINKING_UNREGISTERED':
            return 'Custom roster requests a thinking level not advertised by the registered model.';
        case 'ROSTER_CUSTOM_CONTEXT_UNREGISTERED':
            return 'Custom roster context, output, modality, or reasoning request exceeds the registered model capability.';
        case 'ROSTER_CUSTOM_TOOL_UNREGISTERED':
            return 'Custom roster tool capability is not advertised by the registered model.';
        case 'ROSTER_CUSTOM_ROUTE_FORBIDDEN':
            return 'Custom roster route, auth class/source, billing, service, cache, prompt, provider, or route policy binding is forbidden.';
        case 'ROSTER_CUSTOM_MANIFEST_SCHEMA_INVALID':
            return 'Custom roster qualification manifest fails the closed certification manifest schema.';
        case 'ROSTER_CUSTOM_MANIFEST_HASH_UNTRUSTED':
            return 'Custom roster qualification manifest is shaped but not pinned by the current package trust registry.';
        case 'ROSTER_CUSTOM_MANIFEST_BINDING_MISMATCH':
            return 'Custom roster qualification manifest does not bind to the exact custom_roster subject id and roster hash.';
        case 'ROSTER_CUSTOM_MANIFEST_TIME_INVALID':
            return 'Custom roster qualification manifest time window is invalid or stale.';
        case 'ROSTER_CUSTOM_MANIFEST_NOT_READY':
            return 'Custom roster qualification manifest is not w4-certified-ready.';
        case 'ROSTER_CUSTOM_MANIFEST_REQUIRED_EVIDENCE_MISMATCH':
            return 'Custom roster qualification manifest required evidence set does not match the roster-specific W3 evidence requirements.';
        case 'ROSTER_CUSTOM_MANIFEST_ROLE_COVERAGE_MISMATCH':
            return 'Custom roster qualification manifest does not pass every Autopilot role with exact role-specific W3 execution evidence.';
        case 'ROSTER_CUSTOM_MANIFEST_LIVE_EVIDENCE_UNTRUSTED':
            return 'Custom roster qualification manifest live evidence is not trusted authenticated no-fallback W3 evidence.';
        case 'ROSTER_QUALIFICATION_REQUIRED':
            return 'Custom roster remains a draft until an exact trusted custom_roster certification manifest is pinned by the package registry.';
        case 'ROSTER_PROJECT_UNTRUSTED':
            return 'Trusted-project custom roster setup requires project trust.';
        default:
            return `${code} custom roster validation diagnostic`;
    }
}
function materializeValidationResult(preimage) {
    const normalized = {
        ...preimage,
        provider_ids: uniqueSortedStrings(preimage.provider_ids),
        route_policy_ids: uniqueSortedStrings(preimage.route_policy_ids),
        diagnostics: diagnosticsFromCodes(preimage.diagnostics.map((diagnostic) => diagnostic.code)),
        files_touched: [],
    };
    return Object.freeze({ ...normalized, result_sha256: canonicalSha256(normalized) });
}
function sortAssignmentsByRole(assignments) {
    return [...assignments].sort((left, right) => ROSTER_ROLE_ORDER.indexOf(left.role) - ROSTER_ROLE_ORDER.indexOf(right.role));
}
function summarizeCapabilities(assignments) {
    const sorted = sortAssignmentsByRole(assignments);
    const inputIntersection = sorted.reduce((current, assignment) => {
        if (current === null)
            return assignment.input_modalities;
        return current.filter((modality) => assignment.input_modalities.includes(modality));
    }, null);
    const outputIntersection = sorted.reduce((current, assignment) => {
        if (current === null)
            return assignment.output_modalities;
        return current.filter((modality) => assignment.output_modalities.includes(modality));
    }, null);
    return {
        min_context_window: Math.min(...sorted.map((assignment) => assignment.context_window)),
        min_max_output_tokens: Math.min(...sorted.map((assignment) => assignment.max_output_tokens)),
        input_modalities: uniqueSortedStrings(inputIntersection ?? []),
        output_modalities: uniqueSortedStrings(outputIntersection ?? []),
        reasoning_capability: sorted.every((assignment) => assignment.reasoning_capability === 'reasoning-supported') ? 'reasoning-supported' : 'reasoning-unsupported',
        tool_capability: sorted.every((assignment) => assignment.tool_capability === 'tool-use-supported') ? 'tool-use-supported' : 'tool-use-unsupported',
    };
}
function summarizeBilling(assignments) {
    const summary = safeSummarizeBilling(assignments);
    if (summary === null)
        throw new Error('custom roster cannot summarize mixed billing route classes in frozen roster.v1');
    return summary;
}
function safeSummarizeBilling(assignments) {
    const sorted = sortAssignmentsByRole(assignments);
    const first = sorted[0];
    if (first === undefined)
        return null;
    if (!sorted.every((assignment) => assignment.billing_class === first.billing_class && assignment.billing_route_class === first.billing_route_class))
        return null;
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
function normalizeCustomSlug(slug) {
    const normalized = slug.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').replace(/-{2,}/gu, '-');
    const bounded = (normalized.length === 0 ? 'roster' : normalized).slice(0, 48).replace(/-+$/u, '');
    return bounded.length === 0 ? 'roster' : bounded;
}
function normalizeProfileId(profileId) {
    return profileId === 'precision' || profileId === 'cruise' || profileId === 'afterburner' ? profileId : 'precision';
}
function uniqueSortedStrings(values) {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function uniqueSortedServiceTiers(values) {
    return [...new Set(values)].sort((left, right) => {
        if (left === right)
            return 0;
        if (left === null)
            return -1;
        if (right === null)
            return 1;
        return left.localeCompare(right);
    });
}
function sameStrings(left, right) {
    return left.length === right.length && left.every((entry, index) => right[index] === entry);
}
function jsonEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
