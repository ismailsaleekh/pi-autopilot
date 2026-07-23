const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
/**
 * Production launch accepts only candidates that were promoted by the central
 * W4 provider registry. Synthetic fixture readiness remains historical fixture
 * data and is never launch authority for setup/materialization.
 */
export function isLaunchableRosterCandidate(candidate) {
    return candidate.candidate_state === 'w4-certified-ready' &&
        candidate.launch_readiness === 'w4-certified-ready' &&
        candidate.qualification_state === 'w4-certified-ready' &&
        candidate.non_certifying_seed === false &&
        candidate.synthetic_fixture_ready_only === false &&
        candidate.readiness_authority === 'w4-provider-registry.v1' &&
        isNonEmptyBinding(candidate.provider_pack_id) &&
        isNonEmptyBinding(candidate.certification_manifest_id) &&
        isDigestBinding(candidate.certification_manifest_sha256) &&
        isDigestBinding(candidate.recipe_sha256) &&
        isDigestBinding(candidate.route_policy_sha256) &&
        isDigestBinding(candidate.roster_sha256);
}
function isNonEmptyBinding(value) {
    return typeof value === 'string' && value.length > 0;
}
function isDigestBinding(value) {
    return typeof value === 'string' && DIGEST_PATTERN.test(value);
}
export function launchabilityBlockCodesForCandidates(candidates) {
    const codes = new Set();
    for (const candidate of candidates) {
        if (isLaunchableRosterCandidate(candidate))
            continue;
        for (const code of candidate.diagnostic_codes)
            codes.add(code);
        codes.add('ROSTER_QUALIFICATION_REQUIRED');
    }
    return [...codes].sort((left, right) => left.localeCompare(right));
}
