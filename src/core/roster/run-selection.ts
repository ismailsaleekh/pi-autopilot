import { randomUUID } from 'node:crypto';

import {
  canonicalRosterJson,
  rosterCanonicalSha256OmittingOwnField,
  type RosterSha256Digest,
} from './canonical.ts';
import {
  computeAutopilotRosterContractObjectHash,
  parseAutopilotRosterContractJson,
} from './contracts.ts';
import {
  resolveNewRun,
  type AuthorityState,
  type NewRunResolutionResult,
  type NewRunResolutionSource,
  type PreRunSelection,
  type SavedRosterAuthority,
} from './resolve.ts';
import {
  assertRosterSha256,
  assertValidRepoId,
  assertValidRosterId,
  assertValidRosterRevision,
  assertValidWorkstreamRun,
  formatAuthorityPath,
  preRunSelectionPath,
  resolveRosterScopePaths,
  type RosterSha256,
  type RosterStorageScope,
} from './paths.ts';
import {
  RosterStorage,
  type PreRunSelectionAuthorityProjection,
  type RosterAuthorityProjection,
  type RosterConfigAuthorityProjection,
  type RosterStorageCodec,
} from './storage.ts';
import {
  readAuthorityFileIfPresent,
  type RosterTransactionStageEvent,
} from './transaction.ts';

export type RunSelectionAuthoritySource = Exclude<NewRunResolutionSource, 'agent-first-onboarding'>;
export type RunSelectionCommitStatus = 'committed' | 'setup-required' | 'blocked' | 'failed';
export type RunSelectionOrderingStage =
  | 'before-resolution'
  | 'after-resolution'
  | 'before-selection-publish'
  | 'after-selection-publish'
  | 'after-selection-readback'
  | 'before-worktree-mutation-gate'
  | 'after-worktree-mutation-gate'
  | 'before-spend-gate'
  | 'after-spend-gate'
  | 'after-launch-fence';

export interface RunSelectionAuthority {
  readonly source: RunSelectionAuthoritySource;
  readonly state: AuthorityState;
  readonly scope: RosterStorageScope;
  readonly roster_id: string | null;
  readonly roster_revision: number | null;
  readonly roster_sha256: RosterSha256 | null;
  readonly assignment_set_sha256: RosterSha256 | null;
  readonly config_sha256: RosterSha256 | null;
  readonly trusted?: boolean | undefined;
}

export interface CanonicalPreRunSelectionPublication {
  readonly selection: PreRunSelection;
  readonly selection_bytes: Uint8Array;
  readonly selection_path: string;
  readonly selection_display_path: string;
}

export interface RunSelectionLaunchFenceToken {
  readonly schema_version: 'autopilot.run_selection_launch_fence.v1';
  readonly token_id: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly selection_sha256: RosterSha256;
  readonly selection_path: string;
  readonly issued_at: string;
  readonly readback_verified: true;
}

export interface RunSelectionOrderingEvent {
  readonly stage: RunSelectionOrderingStage;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly selection_sha256?: RosterSha256 | undefined;
  readonly selection_path?: string | undefined;
}

export interface RunSelectionGateContext {
  readonly token: RunSelectionLaunchFenceToken;
  readonly selection: PreRunSelection;
  readonly selection_bytes: Uint8Array;
  readonly selection_path: string;
}

export interface RunSelectionOrderingHooks {
  readonly onOrderingStage?: ((event: RunSelectionOrderingEvent) => void | Promise<void>) | undefined;
  readonly onTransactionStage?: ((event: RosterTransactionStageEvent) => void | Promise<void>) | undefined;
  /** Test/consumer gate for the first operation that could mutate a worktree. Called only after selection fsync/readback. */
  readonly beforeWorktreeMutation?: ((context: RunSelectionGateContext) => void | Promise<void>) | undefined;
  /** Test/consumer gate for the first operation that could spend model budget. Called only after selection fsync/readback. */
  readonly beforeModelSpend?: ((context: RunSelectionGateContext) => void | Promise<void>) | undefined;
}

export interface ResolveAndCommitPreRunSelectionInput {
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly explicit_roster?: RunSelectionAuthority | null | undefined;
  readonly trusted_project_default?: RunSelectionAuthority | null | undefined;
  readonly user_default?: RunSelectionAuthority | null | undefined;
  /** Absolute test-only state-root override. Production default remains exactly ~/.pi/agent/autopilot/. */
  readonly stateRoot?: string | undefined;
  readonly selected_at?: string | undefined;
  readonly issued_at?: string | undefined;
  readonly hooks?: RunSelectionOrderingHooks | undefined;
}

export interface ResolveAndCommitPreRunSelectionResult {
  readonly schema_version: 'autopilot.run_selection_commit_result.v1';
  readonly ok: boolean;
  readonly status: RunSelectionCommitStatus;
  readonly source: NewRunResolutionSource;
  readonly resolution: NewRunResolutionResult;
  readonly selection: PreRunSelection | null;
  readonly selection_bytes: Uint8Array | null;
  readonly selection_path: string | null;
  readonly launch_fence: RunSelectionLaunchFenceToken | null;
  readonly publish_result: Awaited<ReturnType<RosterStorage['publishPreRunSelection']>> | null;
  readonly diagnostics: readonly RunSelectionDiagnostic[];
  readonly write_count: 0 | 1;
  readonly lock_count: 0;
  readonly files_touched: readonly string[];
}

export interface RunSelectionDiagnostic {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error' | 'fatal';
  readonly message: string;
  readonly remediation: string;
  readonly secret_free: true;
}

const ZERO_SHA: RosterSha256 = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const UTC_MS_Z_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

const SELECTION_ONLY_CODEC: RosterStorageCodec<never> = Object.freeze({
  hashBytes(bytes: Uint8Array): RosterSha256 {
    const selection = parseCanonicalPreRunSelectionBytes(bytes);
    return selection.selection_sha256 as RosterSha256;
  },
  decodeSelection(bytes: Uint8Array): PreRunSelectionAuthorityProjection {
    const selection = parseCanonicalPreRunSelectionBytes(bytes);
    return Object.freeze({
      repo_id: selection.repo_id,
      workstream_run: selection.workstream_run,
      scope: selection.scope,
      roster_id: selection.roster_id,
      roster_revision: selection.roster_revision,
      roster_sha256: selection.roster_sha256 as RosterSha256,
      assignment_set_sha256: selection.assignment_set_sha256 as RosterSha256,
      config_sha256: selection.config_sha256 as RosterSha256,
      selection_sha256: selection.selection_sha256 as RosterSha256,
    });
  },
  decodeRoster(_bytes: Uint8Array): RosterAuthorityProjection {
    throw new Error('selection-only codec cannot decode roster authority');
  },
  decodeConfig(_bytes: Uint8Array): RosterConfigAuthorityProjection {
    throw new Error('selection-only codec cannot decode config authority');
  },
});

export function buildCanonicalPreRunSelection(input: {
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly selected: Pick<RunSelectionAuthority, 'scope' | 'roster_id' | 'roster_revision' | 'roster_sha256' | 'assignment_set_sha256' | 'config_sha256'>;
  readonly stateRoot?: string | undefined;
  readonly selected_at?: string | undefined;
}): CanonicalPreRunSelectionPublication {
  assertValidRepoId(input.repo_id);
  assertValidWorkstreamRun(input.workstream_run);
  const selectedAt = input.selected_at ?? new Date().toISOString();
  assertUtcMsZ(selectedAt, 'selected_at');
  const rosterId = requireString(input.selected.roster_id, 'roster_id');
  const rosterRevision = requireNumber(input.selected.roster_revision, 'roster_revision');
  const rosterSha256 = requireSha(input.selected.roster_sha256, 'roster_sha256');
  const assignmentSetSha256 = requireSha(input.selected.assignment_set_sha256, 'assignment_set_sha256');
  const configSha256 = requireSha(input.selected.config_sha256, 'config_sha256');
  assertValidRosterId(rosterId);
  assertValidRosterRevision(rosterRevision);

  const withPlaceholder: PreRunSelection = {
    schema_version: 'autopilot.pre_run_selection.v1',
    repo_id: input.repo_id,
    workstream_run: input.workstream_run,
    scope: input.selected.scope,
    roster_id: rosterId,
    roster_revision: rosterRevision,
    roster_sha256: rosterSha256,
    assignment_set_sha256: assignmentSetSha256,
    config_sha256: configSha256,
    selected_at: selectedAt,
    selection_sha256: ZERO_SHA,
  };
  const selectionSha256 = rosterCanonicalSha256OmittingOwnField(withPlaceholder, 'selection_sha256') as RosterSha256;
  const selection: PreRunSelection = Object.freeze({ ...withPlaceholder, selection_sha256: selectionSha256 });
  parseAutopilotRosterContractJson('autopilot.pre_run_selection.v1', canonicalRosterJson(selection));
  const selectionBytes = Buffer.from(canonicalRosterJson(selection), 'utf8');
  const roundTrip = parseCanonicalPreRunSelectionBytes(selectionBytes);
  if (roundTrip.selection_sha256 !== selection.selection_sha256) {
    throw new Error('canonical pre-run selection hash drifted during roundtrip');
  }
  const paths = resolveRosterScopePaths(stateRootInput(input.stateRoot));
  const selectionPath = preRunSelectionPath(paths, selection);
  return Object.freeze({
    selection,
    selection_bytes: Buffer.from(selectionBytes),
    selection_path: selectionPath,
    selection_display_path: formatAuthorityPath(selectionPath, paths.userStateRoot, paths.userStateDisplayRoot),
  });
}

export function parseCanonicalPreRunSelectionBytes(bytes: Uint8Array): PreRunSelection {
  const text = Buffer.from(bytes).toString('utf8');
  const parsed = parseAutopilotRosterContractJson('autopilot.pre_run_selection.v1', text) as PreRunSelection;
  const expectedHash = computeAutopilotRosterContractObjectHash('autopilot.pre_run_selection.v1', parsed) as RosterSha256Digest | null;
  if (expectedHash === null || parsed.selection_sha256 !== expectedHash) {
    throw new Error('pre-run selection hash mismatch');
  }
  const canonical = Buffer.from(canonicalRosterJson(parsed), 'utf8');
  if (!bytesEqual(canonical, bytes)) {
    throw new Error('pre-run selection bytes are not canonical');
  }
  return Object.freeze({ ...parsed });
}

export function preRunSelectionStorageCodec(): RosterStorageCodec<never> {
  return SELECTION_ONLY_CODEC;
}

export async function resolveAndCommitPreRunSelection(
  input: ResolveAndCommitPreRunSelectionInput,
): Promise<ResolveAndCommitPreRunSelectionResult> {
  let resolution: NewRunResolutionResult | null = null;
  try {
    assertValidRepoId(input.repo_id);
    assertValidWorkstreamRun(input.workstream_run);
    if (input.selected_at !== undefined) assertUtcMsZ(input.selected_at, 'selected_at');
    if (input.issued_at !== undefined) assertUtcMsZ(input.issued_at, 'issued_at');

    await emitOrderingStage(input, 'before-resolution');
    const authorities = normalizeAuthorities(input);
    resolution = resolveNewRun({
      explicit_roster: authorityToSaved(authorities.explicit_roster),
      trusted_project_default: authorityToSaved(authorities.trusted_project_default),
      user_default: authorityToSaved(authorities.user_default),
    });
    await emitOrderingStage(input, 'after-resolution');

    if (resolution.status === 'onboarding-required') {
      return commitResult({
        ok: false,
        status: 'setup-required',
        source: resolution.source,
        resolution,
        selection: null,
        selectionBytes: null,
        selectionPath: null,
        launchFence: null,
        publishResult: null,
        diagnostics: resolution.diagnostics,
        writeCount: 0,
        filesTouched: [],
      });
    }

    if (!resolution.ok) {
      return commitResult({
        ok: false,
        status: 'blocked',
        source: resolution.source,
        resolution,
        selection: null,
        selectionBytes: null,
        selectionPath: null,
        launchFence: null,
        publishResult: null,
        diagnostics: resolution.diagnostics,
        writeCount: 0,
        filesTouched: [],
      });
    }

    const selectedAuthority = requireResolvedAuthority(resolution, authorities);
    const canonical = buildCanonicalPreRunSelection({
      repo_id: input.repo_id,
      workstream_run: input.workstream_run,
      selected: selectedAuthority,
      ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }),
      ...(input.selected_at === undefined ? {} : { selected_at: input.selected_at }),
    });
    await emitOrderingStage(input, 'before-selection-publish', canonical);

    const storage = new RosterStorage({
      codec: SELECTION_ONLY_CODEC,
      ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }),
    });
    const publishResult = await storage.publishPreRunSelection({
      selection_bytes: canonical.selection_bytes,
      selection_path: canonical.selection_path,
      faults: transactionFaults(input.hooks),
    });
    await emitOrderingStage(input, 'after-selection-publish', canonical);

    if (!publishResult.ok || publishResult.selection_sha256 !== canonical.selection.selection_sha256) {
      return commitResult({
        ok: false,
        status: publishResult.status === 'failed' ? 'failed' : 'blocked',
        source: resolution.source,
        resolution,
        selection: canonical.selection,
        selectionBytes: canonical.selection_bytes,
        selectionPath: canonical.selection_path,
        launchFence: null,
        publishResult,
        diagnostics: publishResult.diagnostics,
        writeCount: boundedWriteCount(publishResult.write_count),
        filesTouched: publishResult.files_touched,
      });
    }

    const paths = resolveRosterScopePaths(stateRootInput(input.stateRoot));
    const readback = await readAuthorityFileIfPresent(canonical.selection_path, paths.userStateRoot);
    if (readback === null || !bytesEqual(readback.bytes, canonical.selection_bytes)) {
      return commitResult({
        ok: false,
        status: 'failed',
        source: resolution.source,
        resolution,
        selection: canonical.selection,
        selectionBytes: canonical.selection_bytes,
        selectionPath: canonical.selection_path,
        launchFence: null,
        publishResult,
        diagnostics: [diagnostic('ROSTER_READBACK_MISMATCH')],
        writeCount: boundedWriteCount(publishResult.write_count),
        filesTouched: publishResult.files_touched,
      });
    }
    parseCanonicalPreRunSelectionBytes(readback.bytes);
    await emitOrderingStage(input, 'after-selection-readback', canonical);

    const launchFence = Object.freeze({
      schema_version: 'autopilot.run_selection_launch_fence.v1' as const,
      token_id: randomUUID(),
      repo_id: canonical.selection.repo_id,
      workstream_run: canonical.selection.workstream_run,
      selection_sha256: canonical.selection.selection_sha256 as RosterSha256,
      selection_path: canonical.selection_path,
      issued_at: input.issued_at ?? new Date().toISOString(),
      readback_verified: true as const,
    });
    assertUtcMsZ(launchFence.issued_at, 'launch fence issued_at');

    await emitOrderingStage(input, 'before-worktree-mutation-gate', canonical);
    await input.hooks?.beforeWorktreeMutation?.(gateContext(launchFence, canonical));
    await emitOrderingStage(input, 'after-worktree-mutation-gate', canonical);
    await emitOrderingStage(input, 'before-spend-gate', canonical);
    await input.hooks?.beforeModelSpend?.(gateContext(launchFence, canonical));
    await emitOrderingStage(input, 'after-spend-gate', canonical);
    await emitOrderingStage(input, 'after-launch-fence', canonical);

    return commitResult({
      ok: true,
      status: 'committed',
      source: resolution.source,
      resolution,
      selection: canonical.selection,
      selectionBytes: canonical.selection_bytes,
      selectionPath: canonical.selection_path,
      launchFence,
      publishResult,
      diagnostics: publishResult.diagnostics,
      writeCount: boundedWriteCount(publishResult.write_count),
      filesTouched: publishResult.files_touched,
    });
  } catch (error) {
    const errorResolution = resolution ?? resolveNewRun({});
    return commitResult({
      ok: false,
      status: 'failed',
      source: errorResolution.source,
      resolution: errorResolution,
      selection: null,
      selectionBytes: null,
      selectionPath: null,
      launchFence: null,
      publishResult: null,
      diagnostics: [diagnosticFromError(error)],
      writeCount: 0,
      filesTouched: [],
    });
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

export function runSelectionDiagnosticsFrom(
  diagnostics: readonly { readonly code: string; readonly severity?: string; readonly message?: string; readonly remediation?: string; readonly secret_free?: boolean }[],
): readonly RunSelectionDiagnostic[] {
  const byCode = new Map<string, RunSelectionDiagnostic>();
  for (const item of diagnostics) {
    const code = item.code;
    byCode.set(code, Object.freeze({
      code,
      severity: normalizeSeverity(item.severity, code),
      message: sanitizeMessage(item.message, code),
      remediation: sanitizeRemediation(item.remediation),
      secret_free: true as const,
    }));
  }
  return Object.freeze([...byCode.values()].sort((left, right) => left.code.localeCompare(right.code)));
}

export function runSelectionDiagnostic(code: string): RunSelectionDiagnostic {
  return diagnostic(code);
}

function normalizeAuthorities(input: ResolveAndCommitPreRunSelectionInput): {
  readonly explicit_roster: RunSelectionAuthority | null;
  readonly trusted_project_default: RunSelectionAuthority | null;
  readonly user_default: RunSelectionAuthority | null;
} {
  return Object.freeze({
    explicit_roster: normalizeAuthority('explicit-roster', input.explicit_roster),
    trusted_project_default: normalizeAuthority('trusted-project-default', input.trusted_project_default),
    user_default: normalizeAuthority('user-default', input.user_default),
  });
}

function normalizeAuthority(expectedSource: RunSelectionAuthoritySource, authority: RunSelectionAuthority | null | undefined): RunSelectionAuthority | null {
  if (authority === undefined || authority === null) return null;
  if (authority.source !== expectedSource) {
    throw new Error(`${expectedSource} authority input carried source ${authority.source}`);
  }
  const normalized: RunSelectionAuthority = expectedSource === 'trusted-project-default' && authority.trusted !== true
    ? { ...authority, trusted: false }
    : authority;
  if (expectedSource === 'trusted-project-default' && normalized.scope !== 'trusted-project') {
    throw new Error('trusted-project-default authority must use trusted-project scope');
  }
  if (expectedSource === 'user-default' && normalized.scope !== 'user') {
    throw new Error('user-default authority must use user scope');
  }
  if (normalized.state === 'present') {
    requireString(normalized.roster_id, `${expectedSource}.roster_id`);
    requireNumber(normalized.roster_revision, `${expectedSource}.roster_revision`);
    requireSha(normalized.roster_sha256, `${expectedSource}.roster_sha256`);
    requireSha(normalized.assignment_set_sha256, `${expectedSource}.assignment_set_sha256`);
    requireSha(normalized.config_sha256, `${expectedSource}.config_sha256`);
  }
  return normalized;
}

function authorityToSaved(authority: RunSelectionAuthority | null): SavedRosterAuthority | null {
  if (authority === null) return null;
  const savedBase = {
    source: authority.source,
    state: authority.state,
    scope: authority.scope,
    roster_id: authority.roster_id,
    roster_revision: authority.roster_revision,
    roster_sha256: authority.roster_sha256,
    assignment_set_sha256: authority.assignment_set_sha256,
  } satisfies Omit<SavedRosterAuthority, 'trusted'>;
  return authority.trusted === undefined ? savedBase : { ...savedBase, trusted: authority.trusted };
}

function requireResolvedAuthority(
  resolution: NewRunResolutionResult,
  authorities: {
    readonly explicit_roster: RunSelectionAuthority | null;
    readonly trusted_project_default: RunSelectionAuthority | null;
    readonly user_default: RunSelectionAuthority | null;
  },
): RunSelectionAuthority {
  const authority = resolution.source === 'explicit-roster'
    ? authorities.explicit_roster
    : resolution.source === 'trusted-project-default'
      ? authorities.trusted_project_default
      : resolution.source === 'user-default'
        ? authorities.user_default
        : null;
  if (authority === null) throw new Error(`resolved source ${resolution.source} has no authority input`);
  if (authority.state !== 'present') throw new Error(`resolved source ${resolution.source} was not present`);
  if (
    authority.roster_id !== resolution.selected_roster_id ||
    authority.roster_revision !== resolution.selected_roster_revision ||
    authority.roster_sha256 !== resolution.selected_roster_sha256 ||
    authority.assignment_set_sha256 !== resolution.assignment_set_sha256
  ) {
    throw new Error('resolved authority tuple drifted after resolution');
  }
  return authority;
}

function commitResult(input: {
  readonly ok: boolean;
  readonly status: RunSelectionCommitStatus;
  readonly source: NewRunResolutionSource;
  readonly resolution: NewRunResolutionResult;
  readonly selection: PreRunSelection | null;
  readonly selectionBytes: Uint8Array | null;
  readonly selectionPath: string | null;
  readonly launchFence: RunSelectionLaunchFenceToken | null;
  readonly publishResult: Awaited<ReturnType<RosterStorage['publishPreRunSelection']>> | null;
  readonly diagnostics: readonly { readonly code: string; readonly severity?: string; readonly message?: string; readonly remediation?: string; readonly secret_free?: boolean }[];
  readonly writeCount: 0 | 1;
  readonly filesTouched: readonly string[];
}): ResolveAndCommitPreRunSelectionResult {
  return Object.freeze({
    schema_version: 'autopilot.run_selection_commit_result.v1' as const,
    ok: input.ok,
    status: input.status,
    source: input.source,
    resolution: input.resolution,
    selection: input.selection,
    selection_bytes: input.selectionBytes === null ? null : Buffer.from(input.selectionBytes),
    selection_path: input.selectionPath,
    launch_fence: input.launchFence,
    publish_result: input.publishResult,
    diagnostics: runSelectionDiagnosticsFrom(input.diagnostics),
    write_count: input.writeCount,
    lock_count: 0 as const,
    files_touched: Object.freeze([...input.filesTouched]),
  });
}

function gateContext(
  token: RunSelectionLaunchFenceToken,
  canonical: CanonicalPreRunSelectionPublication,
): RunSelectionGateContext {
  return Object.freeze({
    token,
    selection: canonical.selection,
    selection_bytes: Buffer.from(canonical.selection_bytes),
    selection_path: canonical.selection_path,
  });
}

async function emitOrderingStage(
  input: ResolveAndCommitPreRunSelectionInput,
  stage: RunSelectionOrderingStage,
  canonical?: CanonicalPreRunSelectionPublication,
): Promise<void> {
  if (input.hooks?.onOrderingStage === undefined) return;
  const eventBase = {
    stage,
    repo_id: input.repo_id,
    workstream_run: input.workstream_run,
  };
  const event: RunSelectionOrderingEvent = canonical === undefined
    ? eventBase
    : {
        ...eventBase,
        selection_sha256: canonical.selection.selection_sha256 as RosterSha256,
        selection_path: canonical.selection_path,
      };
  await input.hooks.onOrderingStage(event);
}

function transactionFaults(hooks: RunSelectionOrderingHooks | undefined): { readonly onTransactionStage?: (event: RosterTransactionStageEvent) => void | Promise<void> } | undefined {
  if (hooks?.onTransactionStage === undefined) return undefined;
  return { onTransactionStage: hooks.onTransactionStage };
}

function stateRootInput(stateRoot: string | undefined): { readonly scope: 'user'; readonly stateRoot?: string } {
  return stateRoot === undefined ? { scope: 'user' } : { scope: 'user', stateRoot };
}

function requireString(value: string | null | undefined, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required`);
  return value;
}

function requireNumber(value: number | null | undefined, label: string): number {
  if (typeof value !== 'number') throw new Error(`${label} is required`);
  return value;
}

function requireSha(value: RosterSha256 | null | undefined, label: string): RosterSha256 {
  if (typeof value !== 'string') throw new Error(`${label} is required`);
  assertRosterSha256(value, label);
  return value;
}

function assertUtcMsZ(value: string, label: string): void {
  if (!UTC_MS_Z_PATTERN.test(value)) throw new Error(`${label} must be UTC milliseconds with Z suffix`);
}

function boundedWriteCount(value: number): 0 | 1 {
  return value === 0 ? 0 : 1;
}

function diagnostic(code: string): RunSelectionDiagnostic {
  return Object.freeze({
    code,
    severity: normalizeSeverity(undefined, code),
    message: `${code} run selection diagnostic`,
    remediation: 'Follow the Phase 37 immutable pre-run selection authority and repair state before retrying.',
    secret_free: true as const,
  });
}

function diagnosticFromError(error: unknown): RunSelectionDiagnostic {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { readonly code?: unknown }).code === 'string') {
    return diagnostic((error as { readonly code: string }).code);
  }
  if (error instanceof SyntaxError) return diagnostic('ROSTER_READBACK_MISMATCH');
  return diagnostic('ROSTER_READBACK_MISMATCH');
}

function normalizeSeverity(value: string | undefined, code: string): RunSelectionDiagnostic['severity'] {
  if (value === 'info' || value === 'warning' || value === 'error' || value === 'fatal') return value;
  if (code === 'ROSTER_SELECTION_IDEMPOTENT_REPLAY') return 'info';
  if (code === 'ROSTER_READBACK_MISMATCH' || code === 'ROSTER_PUBLICATION_INTERRUPTED_CONFIG_MISSING') return 'fatal';
  return 'error';
}

function sanitizeMessage(value: string | undefined, code: string): string {
  if (value === undefined || value.length === 0 || value.length > 180) return `${code} run selection diagnostic`;
  return value;
}

function sanitizeRemediation(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.length > 220) {
    return 'Follow the Phase 37 immutable pre-run selection authority and repair state before retrying.';
  }
  return value;
}
