import {
  parseAutopilotRosterContract,
} from './contracts.ts';
import {
  assignmentSetSha256,
  requestProfileFromAssignment,
  validateRequestProfileForAssignment,
  type Assignment,
  type AuthSummary,
  type BillingSummary,
  type CapabilitySummary,
  type EvidenceRef,
  type QualificationManifest,
  type Roster,
} from './provider-recipes.ts';
import {
  PHASE37_PACKAGE_VERSION,
  PHASE37_PI_VERSION,
  ROSTER_ROLE_ORDER,
  ROUTE_POLICIES,
  authClassForRoute,
  authSourceForRoute,
  canonicalSha256,
  findInventoryModel,
  findInventoryProvider,
  findRoutePolicy,
  normalizeRosterInventory,
  validateRouteConformance,
  type Digest,
  type Modality,
  type RosterInventory,
  type RosterRole,
  type RosterScope,
  type ServiceTier,
} from './route-policies.ts';

export const CUSTOM_ROSTER_REQUEST_SCHEMA = 'autopilot.custom_roster_request.v1' as const;
export const CUSTOM_ROSTER_VALIDATION_RESULT_SCHEMA = 'autopilot.custom_roster_validation_result.v1' as const;
export const CUSTOM_ROSTER_RECIPE_ID = 'custom-roster' as const;
export const CUSTOM_ROSTER_RECIPE_REVISION = 1 as const;
export const CUSTOM_ROSTER_TOOL_UNSUPPORTED_DIAGNOSTIC = 'ROSTER_CUSTOM_ROSTER_UNSUPPORTED' as const;

const CUSTOM_ROSTER_LIVE_W3_URI_PREFIX = 'w3-evidence://phase37/custom-roster/' as const;
const CUSTOM_REQUEST_ID_PATTERN = /^[a-z][a-z0-9-]{0,95}$/u;
const CUSTOM_ROSTER_ID_PATTERN = /^custom-[a-z0-9][a-z0-9-]{0,83}-[a-f0-9]{12}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_CUSTOM_NATURAL_LANGUAGE_BYTES = 16_000;

export interface CustomRosterTrustRegistry {
  readonly schema_version: 'autopilot.custom_roster_trust_registry.v1';
  readonly live_w3_uri_prefix: typeof CUSTOM_ROSTER_LIVE_W3_URI_PREFIX;
  readonly trusted_manifest_ids: readonly string[];
  readonly trusted_manifest_sha256s: readonly Digest[];
  readonly trusted_roster_sha256s: readonly Digest[];
}

export const CURRENT_CUSTOM_ROSTER_TRUST_REGISTRY: CustomRosterTrustRegistry = deepFreezeCustomRosterAuthority({
  schema_version: 'autopilot.custom_roster_trust_registry.v1',
  live_w3_uri_prefix: CUSTOM_ROSTER_LIVE_W3_URI_PREFIX,
  trusted_manifest_ids: Object.freeze([]),
  trusted_manifest_sha256s: Object.freeze([]),
  trusted_roster_sha256s: Object.freeze([]),
});

export interface CustomRosterSetupRequest {
  readonly schema_version: typeof CUSTOM_ROSTER_REQUEST_SCHEMA;
  readonly request_id: string;
  readonly scope: RosterScope;
  readonly natural_language_request: string;
  readonly roster: unknown;
  readonly qualification_manifest: QualificationManifest | null;
}

export type CustomRosterStructuralStatus = 'invalid' | 'structurally-valid-draft';
export type CustomRosterCertificationStatus = 'absent' | 'invalid' | 'untrusted' | 'autopilot-certified';
export type CustomRosterValidationStatus = 'failed' | 'blocked' | 'certified';

export interface CustomRosterDiagnostic {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error' | 'fatal';
  readonly message: string;
  readonly remediation: string;
  readonly secret_free: true;
}

export interface CustomRosterSetupValidationResult {
  readonly schema_version: typeof CUSTOM_ROSTER_VALIDATION_RESULT_SCHEMA;
  readonly ok: boolean;
  readonly status: CustomRosterValidationStatus;
  readonly structural_status: CustomRosterStructuralStatus;
  readonly certification_status: CustomRosterCertificationStatus;
  readonly request_sha256: Digest | null;
  readonly roster_id: string | null;
  readonly roster_revision: number | null;
  readonly roster_sha256: Digest | null;
  readonly assignment_set_sha256: Digest | null;
  readonly provider_ids: readonly string[];
  readonly route_policy_ids: readonly string[];
  readonly mixed_provider_roster: boolean;
  readonly diagnostics: readonly CustomRosterDiagnostic[];
  readonly write_count: 0;
  readonly lock_count: 0;
  readonly files_touched: readonly [];
  readonly result_sha256: Digest;
}

export type W5CustomRosterIssueCode =
  | 'W5_CUSTOM_MANIFEST_ABSENT'
  | 'W5_CUSTOM_MANIFEST_SCHEMA_INVALID'
  | 'W5_CUSTOM_MANIFEST_HASH_UNTRUSTED'
  | 'W5_CUSTOM_MANIFEST_BINDING_MISMATCH'
  | 'W5_CUSTOM_MANIFEST_TIME_INVALID'
  | 'W5_CUSTOM_MANIFEST_NOT_READY'
  | 'W5_CUSTOM_MANIFEST_REQUIRED_EVIDENCE_MISMATCH'
  | 'W5_CUSTOM_MANIFEST_ROLE_COVERAGE_MISMATCH'
  | 'W5_CUSTOM_MANIFEST_LIVE_EVIDENCE_UNTRUSTED';

export interface W5CustomRosterIssue {
  readonly code: W5CustomRosterIssueCode;
  readonly message: string;
}

export interface CustomRosterManifestVerificationResult {
  readonly ok: boolean;
  readonly certification_status: CustomRosterCertificationStatus;
  readonly manifest: QualificationManifest | null;
  readonly required_evidence: readonly EvidenceRef[];
  readonly issues: readonly W5CustomRosterIssue[];
}

export interface ValidateCustomRosterSetupRequestInput {
  readonly request: unknown;
  readonly inventory: RosterInventory;
  readonly now?: Date | undefined;
}

export interface BuildUserCustomRosterInput {
  readonly slug: string;
  readonly display_name: string;
  readonly scope: RosterScope;
  readonly assignments: readonly Assignment[];
  readonly created_at: string;
  readonly profile_id?: string | undefined;
}

function deepFreezeCustomRosterAuthority<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return value;
  }
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    deepFreezeCustomRosterAuthority((objectValue as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(objectValue) as T;
}

export function isCustomRosterUnsupportedToolPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const action = value['action'];
  if (typeof action === 'string' && /custom/u.test(action)) return true;
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

export function buildUserCustomRosterFromAssignments(input: BuildUserCustomRosterInput): Roster {
  const assignments = sortAssignmentsByRole(input.assignments);
  const assignment_set_sha256 = assignmentSetSha256(assignments);
  const slug = normalizeCustomSlug(input.slug);
  const roster_id = `custom-${slug}-${assignment_set_sha256.slice('sha256:'.length, 'sha256:'.length + 12)}`;
  const withoutHash = {
    schema_version: 'autopilot.roster.v1' as const,
    roster_id,
    roster_revision: CUSTOM_ROSTER_RECIPE_REVISION,
    display_name: input.display_name.slice(0, 120),
    scope: input.scope,
    selected_scope: input.scope,
    profile_id: normalizeProfileId(input.profile_id ?? 'precision'),
    recipe_id: CUSTOM_ROSTER_RECIPE_ID,
    recipe_revision: CUSTOM_ROSTER_RECIPE_REVISION,
    generation_source: 'user-custom' as const,
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
  } satisfies Omit<Roster, 'roster_sha256'>;
  return { ...withoutHash, roster_sha256: canonicalSha256(withoutHash) };
}

export function validateCustomRosterSetupRequest(input: ValidateCustomRosterSetupRequestInput): CustomRosterSetupValidationResult {
  const parsed = parseCustomRosterRequest(input.request);
  if (!parsed.ok) {
    return materializeValidationResult({
      schema_version: CUSTOM_ROSTER_VALIDATION_RESULT_SCHEMA,
      ok: false,
      status: 'failed',
      structural_status: 'invalid',
      certification_status: 'invalid',
      request_sha256: null,
      roster_id: null,
      roster_revision: null,
      roster_sha256: null,
      assignment_set_sha256: null,
      provider_ids: [],
      route_policy_ids: [],
      mixed_provider_roster: false,
      diagnostics: diagnosticsFromCodes(['ROSTER_CUSTOM_REQUEST_SCHEMA_INVALID']),
      write_count: 0,
      lock_count: 0,
      files_touched: [],
    });
  }

  const request = parsed.request;
  const request_sha256 = parsed.request_sha256;
  const rosterParsed = parseCustomRoster(request.roster);
  if (!rosterParsed.ok) {
    return materializeValidationResult({
      schema_version: CUSTOM_ROSTER_VALIDATION_RESULT_SCHEMA,
      ok: false,
      status: 'failed',
      structural_status: 'invalid',
      certification_status: 'invalid',
      request_sha256,
      roster_id: null,
      roster_revision: null,
      roster_sha256: null,
      assignment_set_sha256: null,
      provider_ids: [],
      route_policy_ids: [],
      mixed_provider_roster: false,
      diagnostics: diagnosticsFromCodes(['ROSTER_CUSTOM_DRAFT_SCHEMA_INVALID']),
      write_count: 0,
      lock_count: 0,
      files_touched: [],
    });
  }

  const roster = rosterParsed.roster;
  const structuralCodes = validateCustomRosterStructure({ roster, inventory: input.inventory, scope: request.scope });
  const structuralValid = structuralCodes.length === 0;
  const manifestVerification = structuralValid
    ? verifyCustomRosterManifestForRoster({ roster, manifest: request.qualification_manifest, now: input.now })
    : null;
  const certificationStatus = manifestVerification?.certification_status ?? (structuralValid ? 'absent' : 'invalid');
  const certificationOk = manifestVerification?.ok === true;
  const providerIds = uniqueSortedStrings(roster.assignments.map((assignment) => assignment.provider_id));
  const routePolicyIds = uniqueSortedStrings(roster.assignments.map((assignment) => assignment.route_policy_id));
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
    request_sha256,
    roster_id: roster.roster_id,
    roster_revision: roster.roster_revision,
    roster_sha256: roster.roster_sha256,
    assignment_set_sha256: roster.assignment_set_sha256,
    provider_ids: providerIds,
    route_policy_ids: routePolicyIds,
    mixed_provider_roster: providerIds.length > 1,
    diagnostics,
    write_count: 0,
    lock_count: 0,
    files_touched: [],
  });
}

export function verifyCustomRosterManifestForRoster(input: {
  readonly roster: Roster;
  readonly manifest?: QualificationManifest | null | undefined;
  readonly now?: Date | undefined;
}): CustomRosterManifestVerificationResult {
  const requiredEvidence = requiredCustomRosterEvidenceRefs(input.roster);
  const issues: W5CustomRosterIssue[] = [];
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
  if (
    !trusted.trusted_manifest_ids.includes(manifest.manifest_id) ||
    !trusted.trusted_manifest_sha256s.includes(manifest.manifest_sha256) ||
    !trusted.trusted_roster_sha256s.includes(input.roster.roster_sha256)
  ) {
    issues.push(issue('W5_CUSTOM_MANIFEST_HASH_UNTRUSTED', 'custom roster manifest and roster hash are not pinned by the current package trust registry'));
  }
  if (
    manifest.subject_kind !== 'custom_roster' ||
    manifest.subject_id !== input.roster.roster_id ||
    manifest.subject_sha256 !== input.roster.roster_sha256 ||
    manifest.package_version !== PHASE37_PACKAGE_VERSION ||
    manifest.pi_version !== PHASE37_PI_VERSION
  ) {
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

export function requiredCustomRosterEvidenceRefs(roster: Pick<Roster, 'roster_id' | 'roster_sha256'>): readonly EvidenceRef[] {
  const prefix = `custom-${roster.roster_sha256.slice('sha256:'.length, 'sha256:'.length + 12)}`;
  return deepFreezeCustomRosterAuthority(sortEvidenceRefs([
    evidenceRef(`${prefix}-billing-proof`, 'billing-proof', `witness-required://phase37/custom-roster/${roster.roster_id}/billing`, null, null),
    evidenceRef(`${prefix}-cache-proof`, 'cache-proof', `witness-required://phase37/custom-roster/${roster.roster_id}/cache`, null, null),
    evidenceRef(`${prefix}-prompt-proof`, 'prompt-proof', `witness-required://phase37/custom-roster/${roster.roster_id}/prompt`, null, null),
    evidenceRef(`${prefix}-route-proof`, 'route-proof', `witness-required://phase37/custom-roster/${roster.roster_id}/route`, null, null),
    ...ROSTER_ROLE_ORDER.map((role) => evidenceRef(
      `${prefix}-exec-${role}-proof`,
      'execution-proof',
      `witness-required://phase37/custom-roster/${roster.roster_id}/execution/${role}`,
      null,
      null,
    )),
  ]));
}

function parseCustomRosterRequest(value: unknown):
  | { readonly ok: true; readonly request: CustomRosterSetupRequest; readonly request_sha256: Digest }
  | { readonly ok: false } {
  if (!isRecord(value)) return { ok: false };
  const expected = new Set(['schema_version', 'request_id', 'scope', 'natural_language_request', 'roster', 'qualification_manifest']);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || !keys.every((key) => expected.has(key))) return { ok: false };
  const schemaVersion = value['schema_version'];
  const requestId = value['request_id'];
  const scope = value['scope'];
  const natural = value['natural_language_request'];
  const manifest = value['qualification_manifest'];
  if (
    schemaVersion !== CUSTOM_ROSTER_REQUEST_SCHEMA ||
    typeof requestId !== 'string' || !CUSTOM_REQUEST_ID_PATTERN.test(requestId) ||
    (scope !== 'user' && scope !== 'trusted-project') ||
    typeof natural !== 'string' || natural.length === 0 || natural.includes('\u0000') ||
    Buffer.byteLength(natural, 'utf8') > MAX_CUSTOM_NATURAL_LANGUAGE_BYTES ||
    (manifest !== null && !isRecord(manifest))
  ) {
    return { ok: false };
  }
  const request: CustomRosterSetupRequest = Object.freeze({
    schema_version: CUSTOM_ROSTER_REQUEST_SCHEMA,
    request_id: requestId,
    scope,
    natural_language_request: natural,
    roster: value['roster'],
    qualification_manifest: manifest as QualificationManifest | null,
  });
  return { ok: true, request, request_sha256: customRequestSha256(request) };
}

function customRequestSha256(request: CustomRosterSetupRequest): Digest {
  return canonicalSha256({
    schema_version: request.schema_version,
    request_id: request.request_id,
    scope: request.scope,
    natural_language_request_sha256: canonicalSha256({ natural_language_request: request.natural_language_request }),
    roster_sha256: safeValueDigest(request.roster),
    qualification_manifest_sha256: request.qualification_manifest === null ? null : safeValueDigest(request.qualification_manifest),
  });
}

function safeValueDigest(value: unknown): Digest {
  try {
    return canonicalSha256(value);
  } catch {
    return canonicalSha256({ invalid_canonical_value: true });
  }
}

function parseCustomRoster(value: unknown): { readonly ok: true; readonly roster: Roster } | { readonly ok: false } {
  try {
    return { ok: true, roster: parseAutopilotRosterContract('autopilot.roster.v1', value) as unknown as Roster };
  } catch {
    return { ok: false };
  }
}

function validateCustomRosterStructure(input: {
  readonly roster: Roster;
  readonly inventory: RosterInventory;
  readonly scope: RosterScope;
}): readonly string[] {
  const codes = new Set<string>();
  const roster = input.roster;
  const inventory = normalizeRosterInventory(input.inventory);
  if (input.scope === 'trusted-project' && !inventory.project_trusted) codes.add('ROSTER_PROJECT_UNTRUSTED');
  if (roster.scope !== input.scope || roster.selected_scope !== input.scope) codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
  if (roster.generation_source !== 'user-custom') codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
  if (roster.recipe_id !== CUSTOM_ROSTER_RECIPE_ID || roster.recipe_revision !== CUSTOM_ROSTER_RECIPE_REVISION) codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
  if (!CUSTOM_ROSTER_ID_PATTERN.test(roster.roster_id)) codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
  if (roster.package_version !== PHASE37_PACKAGE_VERSION || roster.pi_version !== PHASE37_PI_VERSION) codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');

  const sortedAssignments = sortAssignmentsByRole(roster.assignments);
  if (!sameStrings(sortedAssignments.map((assignment) => assignment.role), ROSTER_ROLE_ORDER)) codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
  try {
    if (assignmentSetSha256(sortedAssignments) !== roster.assignment_set_sha256) codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
  } catch {
    codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
  }
  if (!sameStrings(roster.route_policy_ids, uniqueSortedStrings(sortedAssignments.map((assignment) => assignment.route_policy_id)))) {
    codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
  }
  if (!jsonEqual(roster.capability_summary, summarizeCapabilities(sortedAssignments))) codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
  const billing = safeSummarizeBilling(sortedAssignments);
  if (billing === null || !jsonEqual(roster.billing_summary, billing)) codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');
  if (!jsonEqual(roster.auth_summary, summarizeAuth(sortedAssignments))) codes.add('ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID');

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
    } else {
      if (!model.thinking_values.includes(assignment.thinking)) codes.add('ROSTER_CUSTOM_THINKING_UNREGISTERED');
      if (!model.service_tiers.some((tier) => tier === assignment.service_tier)) codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
      if (!model.cache_policies.includes(assignment.cache_policy)) codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
      if (!model.system_prompt_profiles.includes(assignment.system_prompt_profile)) codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
      if (assignment.context_window > model.context_window || assignment.max_output_tokens > model.max_output_tokens) codes.add('ROSTER_CUSTOM_CONTEXT_UNREGISTERED');
      if (!assignment.input_modalities.every((modality) => model.input_modalities.includes(modality))) codes.add('ROSTER_CUSTOM_CONTEXT_UNREGISTERED');
      if (!assignment.output_modalities.every((modality) => model.output_modalities.includes(modality))) codes.add('ROSTER_CUSTOM_CONTEXT_UNREGISTERED');
      if (assignment.reasoning_capability === 'reasoning-supported' && model.reasoning_capability !== 'reasoning-supported') codes.add('ROSTER_CUSTOM_CONTEXT_UNREGISTERED');
      if (assignment.tool_capability === 'tool-use-supported' && model.tool_capability !== 'tool-use-supported') codes.add('ROSTER_CUSTOM_TOOL_UNREGISTERED');
    }
    const routePolicy = findRoutePolicy(assignment.route_policy_id, assignment.route_policy_revision, ROUTE_POLICIES);
    if (routePolicy === null || routePolicy.provider_id !== assignment.provider_id) codes.add('ROSTER_CUSTOM_ROUTE_FORBIDDEN');
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
    } catch {
      codes.add('ROSTER_REQUEST_PROFILE_DRIFT');
    }
    for (const diagnostic of validateRequestProfileForAssignment(requestProfile, assignment)) codes.add(diagnostic.code);
  }
  return [...codes].sort((left, right) => left.localeCompare(right));
}

function parseManifest(value: QualificationManifest): QualificationManifest | null {
  try {
    return parseAutopilotRosterContract('autopilot.certification_manifest.v1', value) as unknown as QualificationManifest;
  } catch {
    return null;
  }
}

function issue(code: W5CustomRosterIssueCode, message: string): W5CustomRosterIssue {
  return Object.freeze({ code, message });
}

function uniqueIssuesByCode(issues: readonly W5CustomRosterIssue[]): readonly W5CustomRosterIssue[] {
  return [...new Map(issues.map((entry) => [entry.code, entry])).values()].sort((left, right) => left.code.localeCompare(right.code));
}

function manifestTimeIsValid(manifest: QualificationManifest, now: Date): boolean {
  const issued = Date.parse(manifest.issued_at);
  const expires = Date.parse(manifest.expires_at);
  const current = now.getTime();
  return Number.isFinite(issued) && Number.isFinite(expires) && expires > issued && current >= issued && current < expires;
}

function sameEvidenceRefs(left: readonly EvidenceRef[], right: readonly EvidenceRef[]): boolean {
  return JSON.stringify(sortEvidenceRefs(left)) === JSON.stringify(sortEvidenceRefs(right));
}

function sortEvidenceRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  return [...refs].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
}

function evidenceRef(
  evidence_id: string,
  kind: EvidenceRef['kind'],
  uri: string,
  sha256: Digest | null,
  byte_count: number | null,
): EvidenceRef {
  return Object.freeze({ evidence_id, kind, uri, sha256, byte_count, secret_free: true as const });
}

function evidenceIdentity(ref: EvidenceRef): Digest {
  return canonicalSha256(ref);
}

function requiredExecutionEvidenceRefForRole(requiredEvidence: readonly EvidenceRef[], role: RosterRole): EvidenceRef | null {
  return requiredEvidence.find((ref) => ref.kind === 'execution-proof' && ref.evidence_id.endsWith(`-${role}-proof`)) ?? null;
}

function requiredEvidenceRefForKind(requiredEvidence: readonly EvidenceRef[], kind: EvidenceRef['kind']): EvidenceRef | null {
  return requiredEvidence.find((ref) => ref.kind === kind) ?? null;
}

function roleResultsCoverCustomRoster(
  manifest: QualificationManifest,
  roster: Roster,
  requiredEvidence: readonly EvidenceRef[],
): boolean {
  const liveEvidenceKeys = new Set(manifest.live_evidence.map(evidenceIdentity));
  for (const role of ROSTER_ROLE_ORDER) {
    const required = requiredExecutionEvidenceRefForRole(requiredEvidence, role);
    const result = manifest.role_results.find((entry) => entry.role === role);
    if (required === null || result === undefined || result.state !== 'pass') return false;
    if (result.evidence_refs.length !== 1) return false;
    const ref = result.evidence_refs[0];
    if (ref === undefined || ref.evidence_id !== required.evidence_id || ref.kind !== 'execution-proof') return false;
    if (!isTrustedCustomLiveW3EvidenceRef(ref, roster)) return false;
    if (!liveEvidenceKeys.has(evidenceIdentity(ref))) return false;
  }
  return true;
}

function liveEvidenceCoversCustomRoster(
  manifest: QualificationManifest,
  roster: Roster,
  requiredEvidence: readonly EvidenceRef[],
): boolean {
  const requiredIds = new Set(requiredEvidence.map((ref) => ref.evidence_id));
  for (const kind of ['route-proof', 'billing-proof', 'prompt-proof', 'cache-proof'] as const) {
    const required = requiredEvidenceRefForKind(requiredEvidence, kind);
    if (required === null) return false;
    const live = manifest.live_evidence.find((ref) => ref.evidence_id === required.evidence_id && ref.kind === required.kind);
    if (live === undefined || !isTrustedCustomLiveW3EvidenceRef(live, roster)) return false;
  }
  for (const role of ROSTER_ROLE_ORDER) {
    const required = requiredExecutionEvidenceRefForRole(requiredEvidence, role);
    if (required === null) return false;
    const live = manifest.live_evidence.find((ref) => ref.evidence_id === required.evidence_id && ref.kind === 'execution-proof');
    if (live === undefined || !isTrustedCustomLiveW3EvidenceRef(live, roster)) return false;
  }
  return manifest.live_evidence.every((ref) => requiredIds.has(ref.evidence_id) && isTrustedCustomLiveW3EvidenceRef(ref, roster));
}

function isTrustedCustomLiveW3EvidenceRef(ref: EvidenceRef, roster: Pick<Roster, 'roster_id'>): boolean {
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

function rosterDiagnosticsForManifestIssues(issues: readonly W5CustomRosterIssue[]): readonly string[] {
  const codes: string[] = [];
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

function diagnosticsFromCodes(codes: readonly string[]): readonly CustomRosterDiagnostic[] {
  const byCode = new Map<string, CustomRosterDiagnostic>();
  for (const code of codes) byCode.set(code, diagnosticForCode(code));
  return Object.freeze([...byCode.values()].sort((left, right) => left.code.localeCompare(right.code)));
}

function diagnosticForCode(code: string): CustomRosterDiagnostic {
  return Object.freeze({
    code: /^ROSTER_[A-Z0-9_]+$/u.test(code) ? code : 'ROSTER_CUSTOM_DRAFT_STRUCTURE_INVALID',
    severity: severityForCode(code),
    message: messageForCode(code),
    remediation: 'Keep the custom roster as a draft until package validation and an exact trusted custom_roster W3 certification manifest approve the exact roster hash.',
    secret_free: true as const,
  });
}

function severityForCode(code: string): CustomRosterDiagnostic['severity'] {
  if (code === 'ROSTER_QUALIFICATION_REQUIRED') return 'warning';
  if (code === 'ROSTER_CUSTOM_REQUEST_SCHEMA_INVALID' || code === 'ROSTER_CUSTOM_DRAFT_SCHEMA_INVALID') return 'fatal';
  return 'error';
}

function messageForCode(code: string): string {
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

function materializeValidationResult(
  preimage: Omit<CustomRosterSetupValidationResult, 'result_sha256'>,
): CustomRosterSetupValidationResult {
  const normalized = {
    ...preimage,
    provider_ids: uniqueSortedStrings(preimage.provider_ids),
    route_policy_ids: uniqueSortedStrings(preimage.route_policy_ids),
    diagnostics: diagnosticsFromCodes(preimage.diagnostics.map((diagnostic) => diagnostic.code)),
    files_touched: [] as readonly [],
  };
  return Object.freeze({ ...normalized, result_sha256: canonicalSha256(normalized) });
}

function sortAssignmentsByRole(assignments: readonly Assignment[]): readonly Assignment[] {
  return [...assignments].sort((left, right) => ROSTER_ROLE_ORDER.indexOf(left.role) - ROSTER_ROLE_ORDER.indexOf(right.role));
}

function summarizeCapabilities(assignments: readonly Assignment[]): CapabilitySummary {
  const sorted = sortAssignmentsByRole(assignments);
  const inputIntersection = sorted.reduce<readonly Modality[] | null>((current, assignment) => {
    if (current === null) return assignment.input_modalities;
    return current.filter((modality) => assignment.input_modalities.includes(modality));
  }, null);
  const outputIntersection = sorted.reduce<readonly Modality[] | null>((current, assignment) => {
    if (current === null) return assignment.output_modalities;
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

function summarizeBilling(assignments: readonly Assignment[]): BillingSummary {
  const summary = safeSummarizeBilling(assignments);
  if (summary === null) throw new Error('custom roster cannot summarize mixed billing route classes in frozen roster.v1');
  return summary;
}

function safeSummarizeBilling(assignments: readonly Assignment[]): BillingSummary | null {
  const sorted = sortAssignmentsByRole(assignments);
  const first = sorted[0];
  if (first === undefined) return null;
  if (!sorted.every((assignment) => assignment.billing_class === first.billing_class && assignment.billing_route_class === first.billing_route_class)) return null;
  return {
    billing_class: first.billing_class,
    billing_route_class: first.billing_route_class,
    route_policy_ids: uniqueSortedStrings(sorted.map((assignment) => assignment.route_policy_id)),
    service_tiers: uniqueSortedServiceTiers(sorted.map((assignment) => assignment.service_tier)),
  };
}

function summarizeAuth(assignments: readonly Assignment[]): AuthSummary {
  const sorted = sortAssignmentsByRole(assignments);
  return {
    auth_classes: uniqueSortedStrings(sorted.map((assignment) => assignment.auth_class)),
    auth_sources: uniqueSortedStrings(sorted.map((assignment) => assignment.auth_source)),
    secret_fields_present: false,
  };
}

function normalizeCustomSlug(slug: string): string {
  const normalized = slug.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').replace(/-{2,}/gu, '-');
  const bounded = (normalized.length === 0 ? 'roster' : normalized).slice(0, 48).replace(/-+$/u, '');
  return bounded.length === 0 ? 'roster' : bounded;
}

function normalizeProfileId(profileId: string): Roster['profile_id'] {
  return profileId === 'precision' || profileId === 'cruise' || profileId === 'afterburner' ? profileId : 'precision';
}

function uniqueSortedStrings<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueSortedServiceTiers(values: readonly ServiceTier[]): readonly ServiceTier[] {
  return [...new Set(values)].sort((left, right) => {
    if (left === right) return 0;
    if (left === null) return -1;
    if (right === null) return 1;
    return left.localeCompare(right);
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => right[index] === entry);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

