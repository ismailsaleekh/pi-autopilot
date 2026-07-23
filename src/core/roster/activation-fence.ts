import type { RosterCandidate } from './provider-recipes.ts';
import type { RosterDiagnosticCode } from './route-policies.ts';

/**
 * Phase 37 W0 contains only non-certifying seeds. A candidate is materializable
 * only when the candidate itself carries the exact synthetic fixture launch
 * authority tuple. W4 live certification will need an explicit schema authority
 * update before production launch can accept certified-live candidates.
 */
export function isLaunchableRosterCandidate(candidate: Pick<RosterCandidate,
  'candidate_state' |
  'launch_readiness' |
  'qualification_state' |
  'non_certifying_seed' |
  'synthetic_fixture_ready_only'
>): boolean {
  return candidate.candidate_state === 'synthetic-fixture-ready' &&
    candidate.launch_readiness === 'synthetic-fixture-only' &&
    candidate.qualification_state === 'synthetic-test-ready' &&
    candidate.non_certifying_seed === true &&
    candidate.synthetic_fixture_ready_only === true;
}

export function launchabilityBlockCodesForCandidates(
  candidates: readonly Pick<RosterCandidate,
    'candidate_state' |
    'launch_readiness' |
    'qualification_state' |
    'non_certifying_seed' |
    'synthetic_fixture_ready_only' |
    'diagnostic_codes'
  >[],
): readonly RosterDiagnosticCode[] {
  const codes = new Set<RosterDiagnosticCode>();
  for (const candidate of candidates) {
    if (isLaunchableRosterCandidate(candidate)) continue;
    for (const code of candidate.diagnostic_codes) codes.add(code);
    codes.add('ROSTER_QUALIFICATION_REQUIRED');
  }
  return [...codes].sort((left, right) => left.localeCompare(right));
}
