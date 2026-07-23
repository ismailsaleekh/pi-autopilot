import {
  type ApiId,
  type CachePolicy,
  type Digest,
  type RosterDiagnostic,
  type RosterDiagnosticCode,
  type RosterScope,
  type ServiceTier,
  type SystemPromptProfile,
  type ThinkingValue,
  canonicalSha256,
  dedupeDiagnostics,
} from './route-policies.ts';

export type NewRunResolutionSource = 'explicit-roster' | 'trusted-project-default' | 'user-default' | 'agent-first-onboarding';
export type AuthorityState = 'absent' | 'present' | 'missing' | 'hash-mismatch' | 'corrupt';

export interface SavedRosterAuthority {
  readonly source: Exclude<NewRunResolutionSource, 'agent-first-onboarding'>;
  readonly state: AuthorityState;
  readonly scope: RosterScope;
  readonly roster_id: string | null;
  readonly roster_revision: number | null;
  readonly roster_sha256: Digest | null;
  readonly assignment_set_sha256: Digest | null;
  readonly trusted?: boolean;
}

export interface NewRunResolutionRequest {
  readonly explicit_roster?: SavedRosterAuthority | null;
  readonly trusted_project_default?: SavedRosterAuthority | null;
  readonly user_default?: SavedRosterAuthority | null;
}

export interface NewRunResolutionResult {
  readonly schema_version: 'autopilot.new_run_resolution_result.v1';
  readonly ok: boolean;
  readonly status: 'resolved' | 'onboarding-required' | 'blocked';
  readonly source: NewRunResolutionSource;
  readonly selected_scope: RosterScope | null;
  readonly selected_roster_id: string | null;
  readonly selected_roster_revision: number | null;
  readonly selected_roster_sha256: Digest | null;
  readonly assignment_set_sha256: Digest | null;
  readonly diagnostics: readonly RosterDiagnostic[];
  readonly write_count: 0;
  readonly lock_count: 0;
  readonly files_touched: readonly [];
  readonly result_sha256: Digest;
}

export interface PreRunSelection {
  readonly schema_version: 'autopilot.pre_run_selection.v1';
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly scope: RosterScope;
  readonly roster_id: string;
  readonly roster_revision: number;
  readonly roster_sha256: Digest;
  readonly assignment_set_sha256: Digest;
  readonly config_sha256: Digest;
  readonly selected_at: string;
  readonly selection_sha256: Digest;
}

export interface ExistingRunResolutionRequest {
  readonly schema_version: 'autopilot.existing_run_resolution_request.v1';
  readonly action: 'resolve-existing-run';
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly scope: RosterScope;
  readonly selection_sha256: Digest;
  readonly runtime_mirror_sha256: Digest | null;
  readonly current_default_roster_id: string | null;
  readonly current_default_roster_revision: number | null;
  readonly current_default_roster_sha256: Digest | null;
  readonly roster_file_state: 'present' | 'missing' | 'hash-mismatch';
  readonly request_sha256: Digest;
}

export interface ExistingRunResolutionResult {
  readonly schema_version: 'autopilot.existing_run_resolution_result.v1';
  readonly action: 'resolve-existing-run';
  readonly ok: boolean;
  readonly status: 'inspected' | 'blocked' | 'failed';
  readonly selected_scope: RosterScope | null;
  readonly selected_roster_id: string | null;
  readonly selected_roster_revision: number | null;
  readonly selected_roster_sha256: Digest | null;
  readonly assignment_set_sha256: Digest | null;
  readonly selection_sha256: Digest;
  readonly diagnostics: readonly RosterDiagnostic[];
  readonly write_count: 0;
  readonly lock_count: 0;
  readonly files_touched: readonly [];
  readonly result_sha256: Digest;
}

export interface ReceiptValidationRequest {
  readonly schema_version: 'autopilot.receipt_validation_request.v1';
  readonly action: 'validate-receipt';
  readonly requested_profile_sha256: Digest | null;
  readonly observed_request_profile_sha256: Digest | null;
  readonly requested_model_id: string | null;
  readonly observed_requested_model_id: string | null;
  readonly executed_model_id: string | null;
  readonly requested_thinking: ThinkingValue | null;
  readonly observed_thinking: ThinkingValue | null;
  readonly requested_api: ApiId | null;
  readonly observed_api: ApiId | null;
  readonly requested_service_tier: ServiceTier;
  readonly observed_service_tier: ServiceTier;
  readonly requested_cache_policy: CachePolicy | null;
  readonly observed_cache_policy: CachePolicy | null;
  readonly requested_system_prompt_profile: SystemPromptProfile | null;
  readonly observed_system_prompt_profile: SystemPromptProfile | null;
  readonly request_sha256: Digest;
}

export interface ReceiptValidationResult {
  readonly schema_version: 'autopilot.receipt_validation_result.v1';
  readonly action: 'validate-receipt';
  readonly ok: boolean;
  readonly status: 'inspected' | 'blocked' | 'failed';
  readonly diagnostics: readonly RosterDiagnostic[];
  readonly write_count: 0;
  readonly lock_count: 0;
  readonly files_touched: readonly [];
  readonly result_sha256: Digest;
}

export interface PreRunSelectionPublishRequest {
  readonly schema_version: 'autopilot.pre_run_selection_publish_request.v1';
  readonly action: 'publish-pre-run-selection';
  readonly selection: PreRunSelection;
  readonly selection_path: string;
  readonly existing_selection_sha256: Digest | null;
  readonly request_sha256: Digest;
}

export interface PreRunSelectionPublishResult {
  readonly schema_version: 'autopilot.pre_run_selection_publish_result.v1';
  readonly action: 'publish-pre-run-selection';
  readonly ok: boolean;
  readonly status: 'published' | 'inspected' | 'blocked' | 'failed';
  readonly selection_sha256: Digest;
  readonly idempotent_replay: boolean;
  readonly diagnostics: readonly RosterDiagnostic[];
  readonly write_count: 0 | 1;
  readonly lock_count: 0;
  readonly files_touched: readonly string[];
  readonly result_sha256: Digest;
}

function materializeNewRunResult(
  input: Omit<NewRunResolutionResult, 'schema_version' | 'write_count' | 'lock_count' | 'files_touched' | 'result_sha256'>,
): NewRunResolutionResult {
  const preimage = {
    schema_version: 'autopilot.new_run_resolution_result.v1' as const,
    ...input,
    diagnostics: input.diagnostics,
    write_count: 0 as const,
    lock_count: 0 as const,
    files_touched: [] as readonly [],
  };
  return { ...preimage, result_sha256: canonicalSha256(preimage) };
}

function authorityDiagnostics(authority: SavedRosterAuthority): readonly RosterDiagnostic[] {
  const codes: RosterDiagnosticCode[] = [];
  if (authority.source === 'trusted-project-default' && authority.trusted === false) {
    codes.push('ROSTER_PROJECT_UNTRUSTED');
  }
  if (authority.state === 'corrupt' || authority.state === 'hash-mismatch') {
    codes.push('ROSTER_READBACK_MISMATCH');
  }
  if (authority.state === 'missing') {
    codes.push('ROSTER_PINNED_SELECTION_UNAVAILABLE');
  }
  return dedupeDiagnostics(codes);
}

function authorityIsSelectable(authority: SavedRosterAuthority): boolean {
  return (
    authority.state === 'present' &&
    authority.roster_id !== null &&
    authority.roster_revision !== null &&
    authority.roster_sha256 !== null &&
    authority.assignment_set_sha256 !== null &&
    !(authority.source === 'trusted-project-default' && authority.trusted === false)
  );
}

export function resolveNewRun(request: NewRunResolutionRequest): NewRunResolutionResult {
  const precedence: readonly (SavedRosterAuthority | null | undefined)[] = [
    request.explicit_roster,
    request.trusted_project_default,
    request.user_default,
  ];
  for (const authority of precedence) {
    if (authority === null || authority === undefined || authority.state === 'absent') {
      continue;
    }
    const diagnostics = authorityDiagnostics(authority);
    if (diagnostics.length > 0 || !authorityIsSelectable(authority)) {
      return materializeNewRunResult({
        ok: false,
        status: 'blocked',
        source: authority.source,
        selected_scope: null,
        selected_roster_id: null,
        selected_roster_revision: null,
        selected_roster_sha256: null,
        assignment_set_sha256: null,
        diagnostics,
      });
    }
    return materializeNewRunResult({
      ok: true,
      status: 'resolved',
      source: authority.source,
      selected_scope: authority.scope,
      selected_roster_id: authority.roster_id,
      selected_roster_revision: authority.roster_revision,
      selected_roster_sha256: authority.roster_sha256,
      assignment_set_sha256: authority.assignment_set_sha256,
      diagnostics: [],
    });
  }
  return materializeNewRunResult({
    ok: false,
    status: 'onboarding-required',
    source: 'agent-first-onboarding',
    selected_scope: null,
    selected_roster_id: null,
    selected_roster_revision: null,
    selected_roster_sha256: null,
    assignment_set_sha256: null,
    diagnostics: [],
  });
}

function materializeExistingRunResult(
  input: Omit<ExistingRunResolutionResult, 'schema_version' | 'action' | 'write_count' | 'lock_count' | 'files_touched' | 'result_sha256'>,
): ExistingRunResolutionResult {
  const preimage = {
    schema_version: 'autopilot.existing_run_resolution_result.v1' as const,
    action: 'resolve-existing-run' as const,
    ...input,
    diagnostics: input.diagnostics,
    write_count: 0 as const,
    lock_count: 0 as const,
    files_touched: [] as readonly [],
  };
  return { ...preimage, result_sha256: canonicalSha256(preimage) };
}

export function resolveExistingRun(
  request: ExistingRunResolutionRequest,
  selection: PreRunSelection | null,
): ExistingRunResolutionResult {
  const explicitSelection = selection as PreRunSelection | null | undefined;
  const diagnostics: RosterDiagnosticCode[] = [];
  if (request.runtime_mirror_sha256 !== request.selection_sha256) {
    diagnostics.push('ROSTER_PINNED_SELECTION_UNAVAILABLE', 'ROSTER_TRANSITION_REQUIRED');
  }
  if (request.roster_file_state === 'missing' || request.roster_file_state === 'hash-mismatch') {
    diagnostics.push('ROSTER_PINNED_SELECTION_UNAVAILABLE', 'ROSTER_TRANSITION_REQUIRED');
  }
  if (explicitSelection === null || explicitSelection === undefined || explicitSelection.selection_sha256 !== request.selection_sha256) {
    diagnostics.push('ROSTER_PINNED_SELECTION_UNAVAILABLE', 'ROSTER_TRANSITION_REQUIRED');
  }
  const materializedDiagnostics = dedupeDiagnostics(diagnostics);
  if (materializedDiagnostics.length > 0 || explicitSelection === null || explicitSelection === undefined) {
    return materializeExistingRunResult({
      ok: false,
      status: 'blocked',
      selected_scope: null,
      selected_roster_id: null,
      selected_roster_revision: null,
      selected_roster_sha256: null,
      assignment_set_sha256: null,
      selection_sha256: request.selection_sha256,
      diagnostics: materializedDiagnostics,
    });
  }
  return materializeExistingRunResult({
    ok: true,
    status: 'inspected',
    selected_scope: explicitSelection.scope,
    selected_roster_id: explicitSelection.roster_id,
    selected_roster_revision: explicitSelection.roster_revision,
    selected_roster_sha256: explicitSelection.roster_sha256,
    assignment_set_sha256: explicitSelection.assignment_set_sha256,
    selection_sha256: request.selection_sha256,
    diagnostics: [],
  });
}

function materializeReceiptValidationResult(
  ok: boolean,
  status: ReceiptValidationResult['status'],
  diagnostics: readonly RosterDiagnostic[],
): ReceiptValidationResult {
  const preimage = {
    schema_version: 'autopilot.receipt_validation_result.v1' as const,
    action: 'validate-receipt' as const,
    ok,
    status,
    diagnostics,
    write_count: 0 as const,
    lock_count: 0 as const,
    files_touched: [] as readonly [],
  };
  return { ...preimage, result_sha256: canonicalSha256(preimage) };
}

function factsMatch<T>(requested: T | null | undefined, observed: T | null | undefined): boolean {
  return requested !== null && requested !== undefined && observed !== null && observed !== undefined && requested === observed;
}

function nullableFactsMatch<T>(requested: T | null | undefined, observed: T | null | undefined): boolean {
  return requested !== undefined && observed !== undefined && requested === observed;
}

export function validateReceipt(request: ReceiptValidationRequest): ReceiptValidationResult {
  const codes: RosterDiagnosticCode[] = [];
  if (!factsMatch(request.requested_profile_sha256, request.observed_request_profile_sha256)) {
    codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
  }
  if (!factsMatch(request.requested_model_id, request.observed_requested_model_id)) {
    codes.push('ROSTER_OBSERVED_MODEL_MISMATCH');
  }
  if (!factsMatch(request.requested_model_id, request.executed_model_id)) {
    codes.push('ROSTER_OBSERVED_MODEL_MISMATCH');
  }
  if (!factsMatch(request.requested_thinking, request.observed_thinking)) {
    codes.push('ROSTER_OBSERVED_THINKING_MISMATCH');
  }
  if (!factsMatch(request.requested_api, request.observed_api)) {
    codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
  }
  if (!nullableFactsMatch(request.requested_service_tier, request.observed_service_tier)) {
    codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
  }
  if (!factsMatch(request.requested_cache_policy, request.observed_cache_policy)) {
    codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
  }
  if (!factsMatch(request.requested_system_prompt_profile, request.observed_system_prompt_profile)) {
    codes.push('ROSTER_REQUEST_PROFILE_DRIFT');
  }
  const diagnostics = dedupeDiagnostics(codes);
  return materializeReceiptValidationResult(diagnostics.length === 0, diagnostics.length === 0 ? 'inspected' : 'failed', diagnostics);
}

export function publishPreRunSelection(request: PreRunSelectionPublishRequest): PreRunSelectionPublishResult {
  const codes: RosterDiagnosticCode[] = [];
  let ok = true;
  let status: PreRunSelectionPublishResult['status'] = 'published';
  let idempotent_replay = false;
  let write_count: 0 | 1 = 1;
  let files_touched: readonly string[] = [request.selection_path];

  if (request.existing_selection_sha256 !== null) {
    write_count = 0;
    files_touched = [];
    if (request.existing_selection_sha256 === request.selection.selection_sha256) {
      status = 'inspected';
      idempotent_replay = true;
      codes.push('ROSTER_SELECTION_IDEMPOTENT_REPLAY');
    } else {
      ok = false;
      status = 'blocked';
      codes.push('ROSTER_CREATE_ONLY_CONFLICT');
    }
  }

  const preimage = {
    schema_version: 'autopilot.pre_run_selection_publish_result.v1' as const,
    action: 'publish-pre-run-selection' as const,
    ok,
    status,
    selection_sha256: request.selection.selection_sha256,
    idempotent_replay,
    diagnostics: dedupeDiagnostics(codes),
    write_count,
    lock_count: 0 as const,
    files_touched,
  };
  return { ...preimage, result_sha256: canonicalSha256(preimage) };
}
