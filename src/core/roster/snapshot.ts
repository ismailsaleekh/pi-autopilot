import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { rosterCanonicalSha256OmittingOwnField } from './canonical.ts';
import {
  resolveExistingRun,
  type ExistingRunResolutionRequest,
  type ExistingRunResolutionResult,
  type PreRunSelection,
} from './resolve.ts';
import {
  bytesEqual,
  parseCanonicalPreRunSelectionBytes,
  runSelectionDiagnostic,
  runSelectionDiagnosticsFrom,
  type RunSelectionDiagnostic,
} from './run-selection.ts';
import {
  assertValidRepoId,
  assertValidRosterId,
  assertValidRosterRevision,
  assertValidWorkstreamRun,
  preRunSelectionPath,
  resolveRosterScopePaths,
  type RosterSha256,
} from './paths.ts';
import {
  publishCreateOnlyAtomic,
  readAuthorityFileIfPresent,
  RosterStorageError,
  type RosterTransactionStageEvent,
} from './transaction.ts';

export type RuntimeRosterSnapshotStatus = 'published' | 'inspected' | 'blocked' | 'failed';
export type RuntimeRosterSnapshotStage =
  | 'before-main-worktree-check'
  | 'after-main-worktree-check'
  | 'before-mirror-publish'
  | 'after-mirror-publish'
  | 'after-mirror-readback';

export interface RuntimeRosterSnapshotStageEvent {
  readonly stage: RuntimeRosterSnapshotStage;
  readonly path?: string | undefined;
  readonly selection_sha256?: RosterSha256 | undefined;
}

export interface RuntimeRosterSnapshotHooks {
  readonly onStage?: ((event: RuntimeRosterSnapshotStageEvent) => void | Promise<void>) | undefined;
  readonly onTransactionStage?: ((event: RosterTransactionStageEvent) => void | Promise<void>) | undefined;
}

export interface PublishRuntimeRosterSnapshotInput {
  readonly mainWorktreeRoot: string;
  readonly workstream: string;
  readonly selection_bytes: Uint8Array;
  readonly expected_selection_sha256?: RosterSha256 | undefined;
  readonly hooks?: RuntimeRosterSnapshotHooks | undefined;
  readonly crashStage?: 'after-mirror-publish-before-readback' | undefined;
}

export interface RuntimeRosterSnapshotPublicationResult {
  readonly schema_version: 'autopilot.runtime_roster_snapshot_publication_result.v1';
  readonly ok: boolean;
  readonly status: RuntimeRosterSnapshotStatus;
  readonly selection_sha256: RosterSha256 | null;
  readonly mirror_path: string;
  readonly idempotent_replay: boolean;
  readonly diagnostics: readonly RunSelectionDiagnostic[];
  readonly write_count: 0 | 1;
  readonly lock_count: 0;
  readonly files_touched: readonly string[];
}

export interface RuntimeSelectionSpecIdentity {
  readonly schema_version?: 'autopilot.unit_spec.v2' | string | undefined;
  readonly workstream?: string | undefined;
  readonly roster_id: string;
  readonly roster_revision: number;
  readonly roster_sha256: RosterSha256;
  readonly pre_run_selection_sha256: RosterSha256;
}

export interface RecoverRuntimeRosterSelectionInput {
  readonly stateRoot?: string | undefined;
  readonly mainWorktreeRoot: string;
  readonly workstream: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly spec_identity?: RuntimeSelectionSpecIdentity | null | undefined;
  readonly current_default?: {
    readonly roster_id: string | null;
    readonly roster_revision: number | null;
    readonly roster_sha256: RosterSha256 | null;
  } | null | undefined;
  readonly roster_file_state?: ExistingRunResolutionRequest['roster_file_state'] | undefined;
}

export interface RuntimeRosterSelectionRecoveryResult {
  readonly schema_version: 'autopilot.runtime_roster_selection_recovery_result.v1';
  readonly ok: boolean;
  readonly status: 'inspected' | 'blocked' | 'failed';
  readonly selection: PreRunSelection | null;
  readonly external_selection_path: string;
  readonly runtime_mirror_path: string;
  readonly existing_resolution: ExistingRunResolutionResult | null;
  readonly diagnostics: readonly RunSelectionDiagnostic[];
  readonly write_count: 0;
  readonly lock_count: 0;
  readonly files_touched: readonly [];
}

const ZERO_SHA: RosterSha256 = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

export function runtimeRosterSnapshotPath(input: { readonly mainWorktreeRoot: string; readonly workstream: string }): string {
  const root = normalizeAbsoluteWorktreeRoot(input.mainWorktreeRoot, { mustExist: false });
  assertValidWorkstreamRun(input.workstream, 'workstream');
  return join(root, '.pi', 'autopilot', input.workstream, 'roster-snapshot.json');
}

export async function publishRuntimeRosterSnapshot(
  input: PublishRuntimeRosterSnapshotInput,
): Promise<RuntimeRosterSnapshotPublicationResult> {
  let mirrorPath = '<unresolved-runtime-mirror-path>';
  try {
    mirrorPath = runtimeRosterSnapshotPath({ mainWorktreeRoot: input.mainWorktreeRoot, workstream: input.workstream });
    const mirrorRoot = dirname(mirrorPath);
    const selection = parseCanonicalPreRunSelectionBytes(input.selection_bytes);
    if (input.expected_selection_sha256 !== undefined && input.expected_selection_sha256 !== selection.selection_sha256) {
      return snapshotPublicationResult(false, 'blocked', mirrorPath, selection.selection_sha256 as RosterSha256, false, [runSelectionDiagnostic('ROSTER_READBACK_MISMATCH')], 0, []);
    }

    await emitSnapshotStage(input.hooks, { stage: 'before-main-worktree-check', path: input.mainWorktreeRoot, selection_sha256: selection.selection_sha256 as RosterSha256 });
    normalizeAbsoluteWorktreeRoot(input.mainWorktreeRoot, { mustExist: true });
    await emitSnapshotStage(input.hooks, { stage: 'after-main-worktree-check', path: input.mainWorktreeRoot, selection_sha256: selection.selection_sha256 as RosterSha256 });

    await emitSnapshotStage(input.hooks, { stage: 'before-mirror-publish', path: mirrorPath, selection_sha256: selection.selection_sha256 as RosterSha256 });
    const publish = await publishCreateOnlyAtomic({
      path: mirrorPath,
      authorityRoot: mirrorRoot,
      bytes: input.selection_bytes,
      hooks: transactionHooks(input.hooks),
    });
    await emitSnapshotStage(input.hooks, { stage: 'after-mirror-publish', path: mirrorPath, selection_sha256: selection.selection_sha256 as RosterSha256 });

    if (publish.status === 'conflict') {
      return snapshotPublicationResult(false, 'blocked', mirrorPath, selection.selection_sha256 as RosterSha256, false, [runSelectionDiagnostic('ROSTER_CREATE_ONLY_CONFLICT')], 0, []);
    }
    const writeCount: 0 | 1 = publish.status === 'created' ? 1 : 0;
    const filesTouched = publish.status === 'created' ? [mirrorPath] : [];
    if (input.crashStage === 'after-mirror-publish-before-readback') {
      return snapshotPublicationResult(false, 'failed', mirrorPath, selection.selection_sha256 as RosterSha256, publish.status === 'idempotent', [runSelectionDiagnostic('ROSTER_READBACK_MISMATCH')], writeCount, filesTouched);
    }

    const readback = await readAuthorityFileIfPresent(mirrorPath, mirrorRoot);
    if (readback === null || !bytesEqual(readback.bytes, input.selection_bytes)) {
      return snapshotPublicationResult(false, 'failed', mirrorPath, selection.selection_sha256 as RosterSha256, publish.status === 'idempotent', [runSelectionDiagnostic('ROSTER_READBACK_MISMATCH')], writeCount, filesTouched);
    }
    const readbackSelection = parseCanonicalPreRunSelectionBytes(readback.bytes);
    if (readbackSelection.selection_sha256 !== selection.selection_sha256) {
      return snapshotPublicationResult(false, 'failed', mirrorPath, selection.selection_sha256 as RosterSha256, publish.status === 'idempotent', [runSelectionDiagnostic('ROSTER_READBACK_MISMATCH')], writeCount, filesTouched);
    }
    await emitSnapshotStage(input.hooks, { stage: 'after-mirror-readback', path: mirrorPath, selection_sha256: selection.selection_sha256 as RosterSha256 });
    return snapshotPublicationResult(true, publish.status === 'idempotent' ? 'inspected' : 'published', mirrorPath, selection.selection_sha256 as RosterSha256, publish.status === 'idempotent', [], writeCount, filesTouched);
  } catch (error) {
    return snapshotPublicationResult(false, 'failed', mirrorPath, null, false, [diagnosticFromSnapshotError(error)], 0, []);
  }
}

export async function recoverRuntimeRosterSelection(
  input: RecoverRuntimeRosterSelectionInput,
): Promise<RuntimeRosterSelectionRecoveryResult> {
  let externalSelectionPath = '';
  let runtimeMirrorPath = '';
  try {
    assertValidRepoId(input.repo_id);
    assertValidWorkstreamRun(input.workstream_run);
    assertValidWorkstreamRun(input.workstream, 'workstream');
    normalizeAbsoluteWorktreeRoot(input.mainWorktreeRoot, { mustExist: true });

    const paths = resolveRosterScopePaths(stateRootInput(input.stateRoot));
    externalSelectionPath = preRunSelectionPath(paths, { repo_id: input.repo_id, workstream_run: input.workstream_run });
    runtimeMirrorPath = runtimeRosterSnapshotPath({ mainWorktreeRoot: input.mainWorktreeRoot, workstream: input.workstream });
    const runtimeMirrorRoot = dirname(runtimeMirrorPath);

    const externalRead = await readAuthorityFileIfPresent(externalSelectionPath, paths.userStateRoot);
    if (externalRead === null) {
      return recoveryResult(false, 'blocked', null, externalSelectionPath, runtimeMirrorPath, null, transitionDiagnostics());
    }
    let externalSelection: PreRunSelection;
    try {
      externalSelection = parseCanonicalPreRunSelectionBytes(externalRead.bytes);
    } catch {
      return recoveryResult(false, 'failed', null, externalSelectionPath, runtimeMirrorPath, null, readbackTransitionDiagnostics());
    }
    if (externalSelection.repo_id !== input.repo_id || externalSelection.workstream_run !== input.workstream_run) {
      return recoveryResult(false, 'failed', null, externalSelectionPath, runtimeMirrorPath, null, readbackTransitionDiagnostics());
    }

    const mirrorRead = await readAuthorityFileIfPresent(runtimeMirrorPath, runtimeMirrorRoot);
    if (mirrorRead === null) {
      return recoveryResult(false, 'blocked', externalSelection, externalSelectionPath, runtimeMirrorPath, null, transitionDiagnostics());
    }
    if (!bytesEqual(externalRead.bytes, mirrorRead.bytes)) {
      return recoveryResult(false, 'failed', externalSelection, externalSelectionPath, runtimeMirrorPath, null, readbackTransitionDiagnostics());
    }
    let mirrorSelection: PreRunSelection;
    try {
      mirrorSelection = parseCanonicalPreRunSelectionBytes(mirrorRead.bytes);
    } catch {
      return recoveryResult(false, 'failed', externalSelection, externalSelectionPath, runtimeMirrorPath, null, readbackTransitionDiagnostics());
    }
    if (mirrorSelection.selection_sha256 !== externalSelection.selection_sha256) {
      return recoveryResult(false, 'failed', externalSelection, externalSelectionPath, runtimeMirrorPath, null, readbackTransitionDiagnostics());
    }

    const specDiagnostics = authenticateSpecIdentity(input.spec_identity, input.workstream, externalSelection);
    if (specDiagnostics.length > 0) {
      return recoveryResult(false, 'blocked', externalSelection, externalSelectionPath, runtimeMirrorPath, null, specDiagnostics);
    }

    const request = existingRunRequestFromSelection({
      selection: externalSelection,
      currentDefault: input.current_default ?? null,
      rosterFileState: input.roster_file_state ?? 'present',
    });
    const existing = resolveExistingRun(request, externalSelection);
    return recoveryResult(
      existing.ok,
      existing.status,
      existing.ok ? externalSelection : null,
      externalSelectionPath,
      runtimeMirrorPath,
      existing,
      existing.diagnostics,
    );
  } catch (error) {
    const external = externalSelectionPath.length === 0 ? '<unresolved-external-selection-path>' : externalSelectionPath;
    const mirror = runtimeMirrorPath.length === 0 ? '<unresolved-runtime-mirror-path>' : runtimeMirrorPath;
    return recoveryResult(false, 'failed', null, external, mirror, null, [diagnosticFromSnapshotError(error)]);
  }
}

function existingRunRequestFromSelection(input: {
  readonly selection: PreRunSelection;
  readonly currentDefault: RecoverRuntimeRosterSelectionInput['current_default'] | null;
  readonly rosterFileState: ExistingRunResolutionRequest['roster_file_state'];
}): ExistingRunResolutionRequest {
  const withPlaceholder: ExistingRunResolutionRequest = {
    schema_version: 'autopilot.existing_run_resolution_request.v1',
    action: 'resolve-existing-run',
    repo_id: input.selection.repo_id,
    workstream_run: input.selection.workstream_run,
    scope: input.selection.scope,
    selection_sha256: input.selection.selection_sha256,
    runtime_mirror_sha256: input.selection.selection_sha256,
    current_default_roster_id: input.currentDefault?.roster_id ?? null,
    current_default_roster_revision: input.currentDefault?.roster_revision ?? null,
    current_default_roster_sha256: input.currentDefault?.roster_sha256 ?? null,
    roster_file_state: input.rosterFileState,
    request_sha256: ZERO_SHA,
  };
  return Object.freeze({
    ...withPlaceholder,
    request_sha256: rosterCanonicalSha256OmittingOwnField(withPlaceholder, 'request_sha256') as RosterSha256,
  });
}

function authenticateSpecIdentity(
  spec: RuntimeSelectionSpecIdentity | null | undefined,
  workstream: string,
  selection: PreRunSelection,
): readonly RunSelectionDiagnostic[] {
  if (spec === null || spec === undefined) return transitionDiagnostics();
  assertValidRosterId(spec.roster_id, 'spec.roster_id');
  assertValidRosterRevision(spec.roster_revision, 'spec.roster_revision');
  if (spec.workstream !== undefined && spec.workstream !== workstream) return readbackTransitionDiagnostics();
  if (
    spec.pre_run_selection_sha256 !== selection.selection_sha256 ||
    spec.roster_id !== selection.roster_id ||
    spec.roster_revision !== selection.roster_revision ||
    spec.roster_sha256 !== selection.roster_sha256
  ) {
    return readbackTransitionDiagnostics();
  }
  return [];
}

function snapshotPublicationResult(
  ok: boolean,
  status: RuntimeRosterSnapshotStatus,
  mirrorPath: string,
  selectionSha256: RosterSha256 | null,
  idempotentReplay: boolean,
  diagnostics: readonly RunSelectionDiagnostic[],
  writeCount: 0 | 1,
  filesTouched: readonly string[],
): RuntimeRosterSnapshotPublicationResult {
  return Object.freeze({
    schema_version: 'autopilot.runtime_roster_snapshot_publication_result.v1' as const,
    ok,
    status,
    selection_sha256: selectionSha256,
    mirror_path: mirrorPath,
    idempotent_replay: idempotentReplay,
    diagnostics: runSelectionDiagnosticsFrom(diagnostics),
    write_count: writeCount,
    lock_count: 0 as const,
    files_touched: Object.freeze([...filesTouched]),
  });
}

function recoveryResult(
  ok: boolean,
  status: RuntimeRosterSelectionRecoveryResult['status'],
  selection: PreRunSelection | null,
  externalSelectionPath: string,
  runtimeMirrorPath: string,
  existingResolution: ExistingRunResolutionResult | null,
  diagnostics: readonly { readonly code: string; readonly severity?: string; readonly message?: string; readonly remediation?: string; readonly secret_free?: boolean }[],
): RuntimeRosterSelectionRecoveryResult {
  return Object.freeze({
    schema_version: 'autopilot.runtime_roster_selection_recovery_result.v1' as const,
    ok,
    status,
    selection,
    external_selection_path: externalSelectionPath,
    runtime_mirror_path: runtimeMirrorPath,
    existing_resolution: existingResolution,
    diagnostics: runSelectionDiagnosticsFrom(diagnostics),
    write_count: 0 as const,
    lock_count: 0 as const,
    files_touched: [] as readonly [],
  });
}

function transitionDiagnostics(): readonly RunSelectionDiagnostic[] {
  return [runSelectionDiagnostic('ROSTER_PINNED_SELECTION_UNAVAILABLE'), runSelectionDiagnostic('ROSTER_TRANSITION_REQUIRED')];
}

function readbackTransitionDiagnostics(): readonly RunSelectionDiagnostic[] {
  return [runSelectionDiagnostic('ROSTER_READBACK_MISMATCH'), runSelectionDiagnostic('ROSTER_TRANSITION_REQUIRED')];
}

function diagnosticFromSnapshotError(error: unknown): RunSelectionDiagnostic {
  if (error instanceof RosterStorageError) return runSelectionDiagnostic(error.code);
  if (error instanceof SyntaxError) return runSelectionDiagnostic('ROSTER_READBACK_MISMATCH');
  return runSelectionDiagnostic('ROSTER_READBACK_MISMATCH');
}

function normalizeAbsoluteWorktreeRoot(value: string, options: { readonly mustExist: boolean }): string {
  if (value.length === 0 || value.includes('\0')) throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', 'mainWorktreeRoot must be non-empty and contain no NUL');
  if (!isAbsolute(value)) throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `mainWorktreeRoot must be absolute: ${value}`);
  const root = resolve(value);
  if (!options.mustExist) return root;
  let stats;
  try {
    stats = lstatSync(root);
  } catch (error) {
    throw new RosterStorageError('ROSTER_PINNED_SELECTION_UNAVAILABLE', `main worktree root is missing: ${root}`, error);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `main worktree root is not an authoritative directory: ${root}`);
  }
  return root;
}

function stateRootInput(stateRoot: string | undefined): { readonly scope: 'user'; readonly stateRoot?: string } {
  return stateRoot === undefined ? { scope: 'user' } : { scope: 'user', stateRoot };
}

function transactionHooks(hooks: RuntimeRosterSnapshotHooks | undefined): { readonly onStage?: (event: RosterTransactionStageEvent) => void | Promise<void> } | undefined {
  if (hooks?.onTransactionStage === undefined) return undefined;
  return { onStage: hooks.onTransactionStage };
}

async function emitSnapshotStage(hooks: RuntimeRosterSnapshotHooks | undefined, event: RuntimeRosterSnapshotStageEvent): Promise<void> {
  if (hooks?.onStage === undefined) return;
  await hooks.onStage(event);
}
