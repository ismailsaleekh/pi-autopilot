import {
  parseAutopilotRosterContract,
} from '../contracts.ts';
export {
  CURRENT_CUSTOM_ROSTER_TRUST_REGISTRY,
  CUSTOM_ROSTER_REQUEST_SCHEMA,
  CUSTOM_ROSTER_VALIDATION_RESULT_SCHEMA,
  CUSTOM_ROSTER_TOOL_UNSUPPORTED_DIAGNOSTIC,
  buildUserCustomRosterFromAssignments,
  requiredCustomRosterEvidenceRefs,
  validateCustomRosterSetupRequest,
  verifyCustomRosterManifestForRoster,
} from '../custom-certification.ts';
export type {
  CustomRosterManifestVerificationResult,
  CustomRosterSetupRequest,
  CustomRosterSetupValidationResult,
  W5CustomRosterIssue,
} from '../custom-certification.ts';
import {
  buildW4CertifiedRosterForCandidate,
  getProviderRecipe,
  sortRosterCandidates,
  type EvidenceRef,
  type QualificationManifest,
  type RosterCandidate,
  type RosterCandidateSet,
} from '../provider-recipes.ts';
import {
  PHASE37_PACKAGE_VERSION,
  PHASE37_PI_VERSION,
  ROSTER_ROLE_ORDER,
  canonicalSha256,
  findRoutePolicy,
  type Digest,
  type RosterRole,
} from '../route-policies.ts';

import {
  ANTHROPIC_PROVIDER_ID,
  ANTHROPIC_PROVIDER_PACK_ID,
  ANTHROPIC_ROUTE_POLICY_ID,
  ANTHROPIC_ROUTE_POLICY_REVISION,
} from './anthropic.ts';
import {
  CODEX_PROVIDER_ID,
  CODEX_PROVIDER_PACK_ID,
  CODEX_RECIPE_ID,
  CODEX_RECIPE_REVISION,
  CODEX_ROUTE_POLICY_ID,
  CODEX_ROUTE_POLICY_REVISION,
} from './codex.ts';
import {
  KIMI_CODING_PROVIDER_ID,
  KIMI_CODING_RECIPE_ID,
  KIMI_CODING_RECIPE_REVISION,
  KIMI_CODING_REQUIRED_EVIDENCE_REFS,
  KIMI_CODING_ROUTE_POLICY_ID,
  KIMI_CODING_ROUTE_POLICY_REVISION,
} from './kimi-coding.ts';
import {
  OPENCODE_GO_PROVIDER_ID,
  OPENCODE_GO_RECIPE_ID,
  OPENCODE_GO_RECIPE_REVISION,
  OPENCODE_GO_REQUIRED_EVIDENCE_REFS,
  OPENCODE_GO_ROUTE_POLICY_ID,
  OPENCODE_GO_ROUTE_POLICY_REVISION,
} from './opencode-go.ts';
import {
  ZAI_PROVIDER_ID,
  ZAI_RECIPE_ID,
  ZAI_RECIPE_REVISION,
  ZAI_REQUIRED_EVIDENCE_REFS,
  ZAI_ROUTE_POLICY_ID,
  ZAI_ROUTE_POLICY_REVISION,
} from './zai.ts';

export type W4ProviderRegistryIssueCode =
  | 'W4_PROVIDER_PACK_BLOCKED'
  | 'W4_PROVIDER_PACK_UNKNOWN'
  | 'W4_MANIFEST_HASH_UNTRUSTED'
  | 'W4_MANIFEST_SCHEMA_INVALID'
  | 'W4_MANIFEST_BINDING_MISMATCH'
  | 'W4_MANIFEST_TIME_INVALID'
  | 'W4_MANIFEST_NOT_READY'
  | 'W4_MANIFEST_REQUIRED_EVIDENCE_MISMATCH'
  | 'W4_MANIFEST_ROLE_COVERAGE_MISMATCH'
  | 'W4_MANIFEST_LIVE_EVIDENCE_UNTRUSTED'
  | 'W4_CERTIFIED_ROSTER_HASH_MISMATCH';

export interface W4ProviderRegistryIssue {
  readonly code: W4ProviderRegistryIssueCode;
  readonly message: string;
}

export interface W4ProviderPackRegistryEntry {
  readonly provider_pack_id: string;
  readonly provider_id: string;
  readonly recipe_id: string;
  readonly recipe_revision: number;
  readonly route_policy_id: string;
  readonly route_policy_revision: number;
  readonly ready_profiles: readonly string[];
  readonly required_evidence: readonly EvidenceRef[];
  readonly trusted_manifest_ids: readonly string[];
  readonly trusted_manifest_sha256s: readonly Digest[];
  readonly trusted_certified_roster_sha256s: readonly Digest[];
  readonly live_w3_uri_prefix: string;
  readonly readiness: 'blocked-current-pack' | 'strict-w3-manifest';
}

export interface W4ProviderManifestVerificationResult {
  readonly ok: boolean;
  readonly entry: W4ProviderPackRegistryEntry | null;
  readonly manifest: QualificationManifest | null;
  readonly certified_roster_sha256: Digest | null;
  readonly issues: readonly W4ProviderRegistryIssue[];
}

export interface W4ProviderRegistryVerificationOptions {
  readonly now?: Date | undefined;
}

const EMPTY_REFS: readonly EvidenceRef[] = Object.freeze([]);
const EMPTY_DIGESTS: readonly Digest[] = Object.freeze([]);
const EMPTY_IDS: readonly string[] = Object.freeze([]);

export const W4_PROVIDER_PACK_REGISTRY: readonly W4ProviderPackRegistryEntry[] = Object.freeze([
  Object.freeze({
    provider_pack_id: String(ANTHROPIC_PROVIDER_PACK_ID),
    provider_id: ANTHROPIC_PROVIDER_ID,
    recipe_id: 'anthropic-sanitized',
    recipe_revision: 1,
    route_policy_id: ANTHROPIC_ROUTE_POLICY_ID,
    route_policy_revision: ANTHROPIC_ROUTE_POLICY_REVISION,
    ready_profiles: Object.freeze([]),
    required_evidence: EMPTY_REFS,
    trusted_manifest_ids: EMPTY_IDS,
    trusted_manifest_sha256s: EMPTY_DIGESTS,
    trusted_certified_roster_sha256s: EMPTY_DIGESTS,
    live_w3_uri_prefix: 'w3-evidence://phase37/anthropic/',
    readiness: 'blocked-current-pack' as const,
  }),
  Object.freeze({
    provider_pack_id: CODEX_PROVIDER_PACK_ID,
    provider_id: CODEX_PROVIDER_ID,
    recipe_id: CODEX_RECIPE_ID,
    recipe_revision: CODEX_RECIPE_REVISION,
    route_policy_id: CODEX_ROUTE_POLICY_ID,
    route_policy_revision: CODEX_ROUTE_POLICY_REVISION,
    ready_profiles: Object.freeze([]),
    required_evidence: EMPTY_REFS,
    trusted_manifest_ids: EMPTY_IDS,
    trusted_manifest_sha256s: EMPTY_DIGESTS,
    trusted_certified_roster_sha256s: EMPTY_DIGESTS,
    live_w3_uri_prefix: 'w3-evidence://phase37/openai-codex/',
    readiness: 'blocked-current-pack' as const,
  }),
  Object.freeze({
    provider_pack_id: 'kimi-coding-plan-w4-provider-pack',
    provider_id: KIMI_CODING_PROVIDER_ID,
    recipe_id: KIMI_CODING_RECIPE_ID,
    recipe_revision: KIMI_CODING_RECIPE_REVISION,
    route_policy_id: KIMI_CODING_ROUTE_POLICY_ID,
    route_policy_revision: KIMI_CODING_ROUTE_POLICY_REVISION,
    ready_profiles: Object.freeze(['precision']),
    required_evidence: KIMI_CODING_REQUIRED_EVIDENCE_REFS,
    trusted_manifest_ids: EMPTY_IDS,
    trusted_manifest_sha256s: EMPTY_DIGESTS,
    trusted_certified_roster_sha256s: EMPTY_DIGESTS,
    live_w3_uri_prefix: 'w3-evidence://phase37/kimi-coding/',
    readiness: 'strict-w3-manifest' as const,
  }),
  Object.freeze({
    provider_pack_id: 'opencode-go-plan-w4-provider-pack',
    provider_id: OPENCODE_GO_PROVIDER_ID,
    recipe_id: OPENCODE_GO_RECIPE_ID,
    recipe_revision: OPENCODE_GO_RECIPE_REVISION,
    route_policy_id: OPENCODE_GO_ROUTE_POLICY_ID,
    route_policy_revision: OPENCODE_GO_ROUTE_POLICY_REVISION,
    ready_profiles: Object.freeze(['precision']),
    required_evidence: OPENCODE_GO_REQUIRED_EVIDENCE_REFS,
    trusted_manifest_ids: EMPTY_IDS,
    trusted_manifest_sha256s: EMPTY_DIGESTS,
    trusted_certified_roster_sha256s: EMPTY_DIGESTS,
    live_w3_uri_prefix: 'w3-evidence://phase37/opencode-go/',
    readiness: 'strict-w3-manifest' as const,
  }),
  Object.freeze({
    provider_pack_id: 'zai-coding-plan-w4-provider-pack',
    provider_id: ZAI_PROVIDER_ID,
    recipe_id: ZAI_RECIPE_ID,
    recipe_revision: ZAI_RECIPE_REVISION,
    route_policy_id: ZAI_ROUTE_POLICY_ID,
    route_policy_revision: ZAI_ROUTE_POLICY_REVISION,
    ready_profiles: Object.freeze(['precision']),
    required_evidence: ZAI_REQUIRED_EVIDENCE_REFS,
    trusted_manifest_ids: EMPTY_IDS,
    trusted_manifest_sha256s: EMPTY_DIGESTS,
    trusted_certified_roster_sha256s: EMPTY_DIGESTS,
    live_w3_uri_prefix: 'w3-evidence://phase37/zai/',
    readiness: 'strict-w3-manifest' as const,
  }),
]);

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function issue(code: W4ProviderRegistryIssueCode, message: string): W4ProviderRegistryIssue {
  return Object.freeze({ code, message });
}

function registryEntryForCandidate(candidate: Pick<RosterCandidate, 'recipe_id' | 'recipe_revision' | 'route_policy_id' | 'route_policy_revision'>): W4ProviderPackRegistryEntry | null {
  return W4_PROVIDER_PACK_REGISTRY.find((entry) =>
    entry.recipe_id === candidate.recipe_id &&
    entry.recipe_revision === candidate.recipe_revision &&
    entry.route_policy_id === candidate.route_policy_id &&
    entry.route_policy_revision === candidate.route_policy_revision,
  ) ?? null;
}

function sameEvidenceRefs(left: readonly EvidenceRef[], right: readonly EvidenceRef[]): boolean {
  return JSON.stringify(sortEvidenceRefs(left)) === JSON.stringify(sortEvidenceRefs(right));
}

function sortEvidenceRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  return [...refs].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
}

function evidenceKey(ref: EvidenceRef): string {
  return `${ref.evidence_id}\0${ref.kind}\0${ref.sha256 ?? ''}`;
}

function isTrustedLiveW3EvidenceRef(ref: EvidenceRef, entry: W4ProviderPackRegistryEntry): boolean {
  const lowerUri = ref.uri.toLowerCase();
  const lowerId = ref.evidence_id.toLowerCase();
  return ref.secret_free === true &&
    ref.kind !== 'synthetic-fixture' &&
    ref.uri.startsWith(entry.live_w3_uri_prefix) &&
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

function parseManifest(value: QualificationManifest): QualificationManifest | null {
  try {
    return parseAutopilotRosterContract('autopilot.certification_manifest.v1', value) as QualificationManifest;
  } catch {
    return null;
  }
}

function roleResultsCoverAllRoles(manifest: QualificationManifest, entry: W4ProviderPackRegistryEntry): boolean {
  const liveEvidenceKeys = new Set(manifest.live_evidence.map(evidenceKey));
  for (const role of ROSTER_ROLE_ORDER) {
    const required = requiredExecutionEvidenceRefForRole(entry, role);
    const result = manifest.role_results.find((candidate) => candidate.role === role);
    if (required === null || result === undefined || result.state !== 'pass') return false;
    if (!result.evidence_refs.some((ref) => ref.kind === 'execution-proof' && ref.evidence_id === required.evidence_id)) return false;
    for (const ref of result.evidence_refs) {
      if (ref.evidence_id !== required.evidence_id || ref.kind !== required.kind) return false;
      if (!isTrustedLiveW3EvidenceRef(ref, entry)) return false;
      if (!liveEvidenceKeys.has(evidenceKey(ref))) return false;
    }
  }
  return true;
}

function liveEvidenceCoversGlobalProofs(manifest: QualificationManifest, entry: W4ProviderPackRegistryEntry): boolean {
  const routeRequired = requiredEvidenceRefForKind(entry, 'route-proof');
  const billingRequired = requiredEvidenceRefForKind(entry, 'billing-proof');
  if (routeRequired === null || billingRequired === null) return false;
  const hasRoute = manifest.live_evidence.some((ref) => ref.kind === routeRequired.kind && ref.evidence_id === routeRequired.evidence_id && isTrustedLiveW3EvidenceRef(ref, entry));
  const hasBilling = manifest.live_evidence.some((ref) => ref.kind === billingRequired.kind && ref.evidence_id === billingRequired.evidence_id && isTrustedLiveW3EvidenceRef(ref, entry));
  return hasRoute && hasBilling && manifest.live_evidence.every((ref) => isTrustedLiveW3EvidenceRef(ref, entry));
}

function requiredEvidenceRefForKind(entry: W4ProviderPackRegistryEntry, kind: EvidenceRef['kind']): EvidenceRef | null {
  return entry.required_evidence.find((ref) => ref.kind === kind) ?? null;
}

function requiredExecutionEvidenceRefForRole(entry: W4ProviderPackRegistryEntry, role: RosterRole): EvidenceRef | null {
  return entry.required_evidence.find((ref) => ref.kind === 'execution-proof' && ref.evidence_id.endsWith(`-${role}-proof`)) ?? null;
}

function manifestTimeIsValid(manifest: QualificationManifest, now: Date): boolean {
  const issued = Date.parse(manifest.issued_at);
  const expires = Date.parse(manifest.expires_at);
  const current = now.getTime();
  return Number.isFinite(issued) && Number.isFinite(expires) && expires > issued && current >= issued && current < expires;
}

function trustedManifestHashes(entry: W4ProviderPackRegistryEntry): ReadonlySet<Digest> {
  return new Set(entry.trusted_manifest_sha256s);
}

export function verifyW4ProviderManifestForCandidate(input: {
  readonly candidate: RosterCandidate;
  readonly manifest: QualificationManifest | null | undefined;
  readonly options?: W4ProviderRegistryVerificationOptions | undefined;
}): W4ProviderManifestVerificationResult {
  const issues: W4ProviderRegistryIssue[] = [];
  const entry = registryEntryForCandidate(input.candidate);
  if (entry === null) {
    return { ok: false, entry: null, manifest: null, certified_roster_sha256: null, issues: [issue('W4_PROVIDER_PACK_UNKNOWN', 'candidate is not owned by a registered W4 provider pack')] };
  }
  if (entry.readiness !== 'strict-w3-manifest') {
    return { ok: false, entry, manifest: null, certified_roster_sha256: null, issues: [issue('W4_PROVIDER_PACK_BLOCKED', 'registered provider pack is present but not readiness authority')] };
  }
  if (!entry.ready_profiles.includes(input.candidate.profile_id)) {
    issues.push(issue('W4_MANIFEST_BINDING_MISMATCH', 'provider pack manifest does not certify this profile'));
  }
  const manifest = input.manifest === null || input.manifest === undefined ? null : parseManifest(input.manifest);
  if (manifest === null) {
    return { ok: false, entry, manifest: null, certified_roster_sha256: null, issues: [issue('W4_MANIFEST_SCHEMA_INVALID', 'provider pack manifest is absent or fails the certification_manifest.v1 schema')] };
  }
  if (!entry.trusted_manifest_ids.includes(manifest.manifest_id) || !trustedManifestHashes(entry).has(manifest.manifest_sha256)) {
    issues.push(issue('W4_MANIFEST_HASH_UNTRUSTED', 'manifest id/hash is not pinned by the central trusted W4 provider registry'));
  }
  const routePolicy = findRoutePolicy(entry.route_policy_id, entry.route_policy_revision);
  const recipe = getProviderRecipe(entry.recipe_id, entry.recipe_revision);
  if (
    manifest.subject_kind !== 'provider_recipe' ||
    manifest.subject_id !== entry.recipe_id ||
    recipe === null ||
    manifest.subject_sha256 !== recipe.recipe_sha256 ||
    input.candidate.recipe_id !== entry.recipe_id ||
    input.candidate.recipe_revision !== entry.recipe_revision ||
    input.candidate.route_policy_id !== entry.route_policy_id ||
    input.candidate.route_policy_revision !== entry.route_policy_revision ||
    input.candidate.provider_pack_id !== undefined && input.candidate.provider_pack_id !== null && input.candidate.provider_pack_id !== entry.provider_pack_id ||
    input.candidate.certification_manifest_id !== undefined && input.candidate.certification_manifest_id !== null && input.candidate.certification_manifest_id !== manifest.manifest_id ||
    input.candidate.certification_manifest_sha256 !== undefined && input.candidate.certification_manifest_sha256 !== null && input.candidate.certification_manifest_sha256 !== manifest.manifest_sha256 ||
    input.candidate.recipe_sha256 !== undefined && input.candidate.recipe_sha256 !== null && input.candidate.recipe_sha256 !== manifest.subject_sha256 ||
    routePolicy === null ||
    input.candidate.route_policy_sha256 !== undefined && input.candidate.route_policy_sha256 !== null && input.candidate.route_policy_sha256 !== routePolicy.route_policy_sha256
  ) {
    issues.push(issue('W4_MANIFEST_BINDING_MISMATCH', 'manifest subject, recipe, route, or candidate binding does not match the central registry'));
  }
  if (manifest.package_version !== PHASE37_PACKAGE_VERSION || manifest.pi_version !== PHASE37_PI_VERSION) {
    issues.push(issue('W4_MANIFEST_BINDING_MISMATCH', 'manifest package or Pi version does not match the package registry'));
  }
  if (!manifestTimeIsValid(manifest, input.options?.now ?? new Date())) {
    issues.push(issue('W4_MANIFEST_TIME_INVALID', 'manifest issued_at/expires_at window is invalid or stale'));
  }
  if (manifest.qualification_state !== 'w4-certified-ready') {
    issues.push(issue('W4_MANIFEST_NOT_READY', 'manifest qualification_state is not w4-certified-ready'));
  }
  if (!sameEvidenceRefs(manifest.required_evidence, entry.required_evidence)) {
    issues.push(issue('W4_MANIFEST_REQUIRED_EVIDENCE_MISMATCH', 'manifest required evidence set does not exactly match the provider pack'));
  }
  if (!roleResultsCoverAllRoles(manifest, entry)) {
    issues.push(issue('W4_MANIFEST_ROLE_COVERAGE_MISMATCH', 'manifest role results must pass all roles with trusted W3 execution refs'));
  }
  if (!liveEvidenceCoversGlobalProofs(manifest, entry)) {
    issues.push(issue('W4_MANIFEST_LIVE_EVIDENCE_UNTRUSTED', 'manifest live evidence must be trusted W3 route, billing, and execution refs with digests and byte counts'));
  }
  const certifiedRoster = buildW4CertifiedRosterForCandidate({
    candidate: input.candidate,
    certification_manifest_id: manifest.manifest_id,
    certification_manifest_sha256: manifest.manifest_sha256,
  });
  if (certifiedRoster === null || !entry.trusted_certified_roster_sha256s.includes(certifiedRoster.roster_sha256)) {
    issues.push(issue('W4_CERTIFIED_ROSTER_HASH_MISMATCH', 'registry could not derive the exact trusted certified roster for this candidate'));
  }
  const uniqueIssues = [...new Map(issues.map((entryIssue) => [entryIssue.code, entryIssue])).values()];
  return {
    ok: uniqueIssues.length === 0,
    entry,
    manifest,
    certified_roster_sha256: certifiedRoster?.roster_sha256 ?? null,
    issues: Object.freeze(uniqueIssues.sort((left, right) => left.code.localeCompare(right.code))),
  };
}

function candidateWithW4Readiness(input: {
  readonly candidate: RosterCandidate;
  readonly entry: W4ProviderPackRegistryEntry;
  readonly manifest: QualificationManifest;
  readonly route_policy_sha256: Digest;
}): RosterCandidate | null {
  const certifiedRoster = buildW4CertifiedRosterForCandidate({
    candidate: input.candidate,
    certification_manifest_id: input.manifest.manifest_id,
    certification_manifest_sha256: input.manifest.manifest_sha256,
  });
  if (certifiedRoster === null) return null;
  const diagnostic_codes = input.candidate.diagnostic_codes.filter((code) => code !== 'ROSTER_QUALIFICATION_REQUIRED' && code !== 'ROSTER_PRIORITY_PROOF_REQUIRED');
  const withoutHash = {
    schema_version: input.candidate.schema_version,
    candidate_id: input.candidate.candidate_id,
    candidate_sort_key: input.candidate.candidate_sort_key,
    scope: input.candidate.scope,
    profile_id: input.candidate.profile_id,
    recipe_id: input.candidate.recipe_id,
    recipe_revision: input.candidate.recipe_revision,
    route_policy_id: input.candidate.route_policy_id,
    route_policy_revision: input.candidate.route_policy_revision,
    roster_id: certifiedRoster.roster_id,
    roster_revision: certifiedRoster.roster_revision,
    assignment_set_sha256: certifiedRoster.assignment_set_sha256,
    roster_sha256: certifiedRoster.roster_sha256,
    candidate_state: 'w4-certified-ready' as const,
    launch_readiness: 'w4-certified-ready' as const,
    qualification_state: 'w4-certified-ready' as const,
    non_certifying_seed: false,
    synthetic_fixture_ready_only: false,
    converges_with: input.candidate.converges_with,
    diagnostic_codes,
    readiness_authority: 'w4-provider-registry.v1' as const,
    provider_pack_id: input.entry.provider_pack_id,
    certification_manifest_id: input.manifest.manifest_id,
    certification_manifest_sha256: input.manifest.manifest_sha256,
    recipe_sha256: input.manifest.subject_sha256,
    route_policy_sha256: input.route_policy_sha256,
  } satisfies Omit<RosterCandidate, 'candidate_sha256'>;
  return { ...withoutHash, candidate_sha256: canonicalSha256(withoutHash) };
}

export function applyW4ProviderRegistryReadinessToCandidateSet(input: {
  readonly candidateSet: RosterCandidateSet;
  readonly manifests?: readonly QualificationManifest[] | undefined;
  readonly options?: W4ProviderRegistryVerificationOptions | undefined;
}): RosterCandidateSet {
  const manifests = input.manifests ?? [];
  if (manifests.length === 0) return input.candidateSet;
  const candidates = input.candidateSet.candidates.map((candidate) => {
    const manifest = manifests.find((entry) => entry.subject_id === candidate.recipe_id) ?? null;
    const verification = verifyW4ProviderManifestForCandidate({ candidate, manifest, options: input.options });
    if (!verification.ok || verification.entry === null || verification.manifest === null) return candidate;
    const routePolicy = findRoutePolicy(verification.entry.route_policy_id, verification.entry.route_policy_revision);
    if (routePolicy === null) return candidate;
    return candidateWithW4Readiness({ candidate, entry: verification.entry, manifest: verification.manifest, route_policy_sha256: routePolicy.route_policy_sha256 }) ?? candidate;
  });
  const sortedCandidates = sortRosterCandidates(candidates);
  const withoutIdAndHash = {
    schema_version: input.candidateSet.schema_version,
    scope: input.candidateSet.scope,
    inventory_sha256: input.candidateSet.inventory_sha256,
    recipe_registry_sha256: input.candidateSet.recipe_registry_sha256,
    candidates: sortedCandidates,
    recommended_profile_id: input.candidateSet.recommended_profile_id,
    created_at: input.candidateSet.created_at,
  };
  const candidateSetIdHash = canonicalSha256(withoutIdAndHash).slice('sha256:'.length, 'sha256:'.length + 16);
  const withoutHash = {
    schema_version: input.candidateSet.schema_version,
    candidate_set_id: `candidate-set-${candidateSetIdHash}`,
    scope: input.candidateSet.scope,
    inventory_sha256: input.candidateSet.inventory_sha256,
    recipe_registry_sha256: input.candidateSet.recipe_registry_sha256,
    candidates: sortedCandidates,
    recommended_profile_id: input.candidateSet.recommended_profile_id,
    created_at: input.candidateSet.created_at,
  };
  return { ...withoutHash, candidate_set_sha256: canonicalSha256(withoutHash) };
}
