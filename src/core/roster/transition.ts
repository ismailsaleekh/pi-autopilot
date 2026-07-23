import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { AutopilotRosterContractBySchemaVersion } from '../contracts/types.ts';
import {
  autopilotRosterContractCanonicalJson,
  computeAutopilotRosterContractObjectHash,
  parseAutopilotRosterContract,
  parseAutopilotRosterContractJson,
} from './contracts.ts';
import {
  assertValidRepoId,
  assertValidWorkstreamRun,
  formatAuthorityPath,
  preRunSelectionPath,
  resolveRosterScopePaths,
  rosterRevisionPath,
  type RosterSha256,
  type RosterStorageScope,
} from './paths.ts';
import {
  publishCreateOnlyAtomic,
  readAuthorityFileIfPresent,
  RosterStorageError,
  type RosterTransactionStageEvent,
} from './transaction.ts';
import type { PreRunSelection } from './resolve.ts';
import type { SavedRosterRef } from './storage.ts';

export type AutopilotRosterTransitionV1 = AutopilotRosterContractBySchemaVersion['autopilot.roster_transition.v1'];
export type AutopilotSavedRosterRefV1 = AutopilotRosterContractBySchemaVersion['autopilot.saved_roster_ref.v1'];

export type RosterTransitionStatus = 'prepared' | 'committed' | 'inspected' | 'blocked' | 'failed';

export interface RosterTransitionDiagnostic {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error' | 'fatal';
  readonly message: string;
  readonly remediation: string;
  readonly secret_free: true;
}

export interface ExistingRunRosterTransitionRunRef {
  readonly repo_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly main_worktree_path: string;
  readonly runtime_root: string;
  readonly source_repo: string;
}

export interface ExistingRunRosterTransitionProposalInput {
  readonly stateRoot?: string | undefined;
  readonly run: ExistingRunRosterTransitionRunRef;
  readonly from_roster: AutopilotSavedRosterRefV1;
  readonly to_roster: AutopilotSavedRosterRefV1;
  readonly reason: string;
  readonly approved_at: string;
}

export interface ExistingRunRosterTransitionProposal {
  readonly schema_version: 'autopilot.existing_run_roster_transition_proposal.v1';
  readonly repo_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly transition: AutopilotRosterTransitionV1;
  readonly transition_bytes: Uint8Array;
  readonly transition_path: string;
  readonly transition_display_path: string;
  readonly approval_phrase: string;
  readonly presentation_sha256: RosterSha256;
  readonly presentation: string;
}

export interface ExistingRunRosterTransitionApproval {
  readonly schema_version: 'autopilot.existing_run_roster_transition_approval.v1';
  readonly approval_token: string;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly transition_id: string;
  readonly transition_sha256: RosterSha256;
  readonly presentation_sha256: RosterSha256;
  readonly approved_at: string;
  readonly source: 'user';
}

export interface ExistingRunRosterTransitionAuthorizationResult {
  readonly ok: boolean;
  readonly approval: ExistingRunRosterTransitionApproval | null;
  readonly reason: string;
}

export interface ExistingRunRosterTransitionCommitInput {
  readonly stateRoot?: string | undefined;
  readonly run: ExistingRunRosterTransitionRunRef;
  readonly proposal: ExistingRunRosterTransitionProposal;
  readonly approval: ExistingRunRosterTransitionApproval;
  readonly expected_active_run?: Pick<ExistingRunRosterTransitionRunRef, 'repo_id' | 'workstream_run' | 'main_worktree_path' | 'runtime_root'> | undefined;
  readonly hooks?: { readonly onTransactionStage?: (event: RosterTransactionStageEvent) => void | Promise<void> } | undefined;
}

export interface ExistingRunRosterTransitionCommitResult {
  readonly schema_version: 'autopilot.existing_run_roster_transition_commit_result.v1';
  readonly ok: boolean;
  readonly status: 'committed' | 'inspected' | 'blocked' | 'failed';
  readonly transition: AutopilotRosterTransitionV1 | null;
  readonly transition_path: string;
  readonly transition_display_path: string;
  readonly runtime_transition_path: string;
  readonly runtime_transition_ref: string;
  readonly transition_artifact_sha256: RosterSha256 | null;
  readonly idempotent_replay: boolean;
  readonly successor_attempt_authority: ExistingRunRosterSuccessorAttemptAuthority | null;
  readonly diagnostics: readonly RosterTransitionDiagnostic[];
  readonly write_count: 0 | 1;
  readonly lock_count: 0;
  readonly files_touched: readonly string[];
}

export interface ExistingRunRosterTransitionConsumptionInput {
  readonly stateRoot?: string | undefined;
  readonly run: ExistingRunRosterTransitionRunRef;
  readonly from_roster: AutopilotSavedRosterRefV1;
  readonly to_roster: AutopilotSavedRosterRefV1;
}

export interface ExistingRunRosterTransitionConsumptionResult {
  readonly schema_version: 'autopilot.existing_run_roster_transition_consumption_result.v1';
  readonly ok: boolean;
  readonly status: 'inspected' | 'blocked' | 'failed';
  readonly transition: AutopilotRosterTransitionV1 | null;
  readonly transition_path: string | null;
  readonly transition_display_path: string | null;
  readonly runtime_transition_path: string | null;
  readonly runtime_transition_ref: string | null;
  readonly transition_artifact_sha256: RosterSha256 | null;
  readonly successor_attempt_authority: ExistingRunRosterSuccessorAttemptAuthority | null;
  readonly diagnostics: readonly RosterTransitionDiagnostic[];
  readonly write_count: 0;
  readonly lock_count: 0;
  readonly files_touched: readonly [];
}

export interface ExistingRunRosterTransitionChainResult {
  readonly schema_version: 'autopilot.existing_run_roster_transition_chain_result.v1';
  readonly ok: boolean;
  readonly status: 'inspected' | 'blocked' | 'failed';
  readonly transitions: readonly AutopilotRosterTransitionV1[];
  readonly terminal_roster: AutopilotSavedRosterRefV1;
  readonly terminal_successor_attempt_authority: ExistingRunRosterSuccessorAttemptAuthority | null;
  readonly diagnostics: readonly RosterTransitionDiagnostic[];
}

export interface ExistingRunRosterSuccessorAttemptAuthority {
  readonly schema_version: 'autopilot.existing_run_roster_successor_attempt_authority.v1';
  readonly repo_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly transition_id: string;
  readonly transition_sha256: RosterSha256;
  readonly transition_artifact_sha256: RosterSha256;
  readonly transition_path: string;
  readonly transition_display_path: string;
  readonly runtime_transition_path: string;
  readonly runtime_transition_ref: string;
  readonly from_roster: AutopilotSavedRosterRefV1;
  readonly to_roster: AutopilotSavedRosterRefV1;
  readonly creates_new_attempts: true;
  readonly preserves_external_selection: true;
  readonly preserves_runtime_mirror: true;
  readonly invalidates_prior_validation: true;
  readonly requires_fresh_independent_validation_before_closure: true;
}

export interface ExistingRunRosterTransitionPaths {
  readonly transitionsRoot: string;
  readonly transitionPath: string;
  readonly transitionDisplayPath: string;
  readonly runtimeTransitionPath: string;
  readonly runtimeTransitionRef: string;
  readonly authorityRoot: string;
  readonly authorityDisplayRoot: string;
}

const ZERO_SHA: RosterSha256 = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const UTC_MS_Z_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const TRANSITION_ID_PATTERN = /^[a-z][a-z0-9-]{0,119}$/u;

export function savedRosterRefForSelection(input: {
  readonly selection: Pick<PreRunSelection, 'scope' | 'roster_id' | 'roster_revision' | 'roster_sha256' | 'assignment_set_sha256'>;
  readonly stateRoot?: string | undefined;
  readonly trustedProjectRoot?: string | undefined;
}): AutopilotSavedRosterRefV1 {
  const scope = input.selection.scope as RosterStorageScope;
  const paths = scope === 'trusted-project'
    ? resolveRosterScopePaths({ scope, ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }), trustedProjectRoot: requireTrustedProjectRoot(input.trustedProjectRoot) })
    : resolveRosterScopePaths({ scope: 'user', ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }) });
  const ref = {
    roster_id: input.selection.roster_id,
    roster_revision: input.selection.roster_revision,
    roster_sha256: input.selection.roster_sha256,
    assignment_set_sha256: input.selection.assignment_set_sha256,
    path: formatAuthorityPath(rosterRevisionPath(paths, input.selection), paths.authorityRoot, paths.authorityDisplayRoot),
  };
  return parseAutopilotRosterContract('autopilot.saved_roster_ref.v1', ref);
}

export function savedRosterRefFromSavedRef(input: {
  readonly scope: RosterStorageScope;
  readonly ref: SavedRosterRef;
  readonly stateRoot?: string | undefined;
  readonly trustedProjectRoot?: string | undefined;
}): AutopilotSavedRosterRefV1 {
  const paths = input.scope === 'trusted-project'
    ? resolveRosterScopePaths({ scope: input.scope, ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }), trustedProjectRoot: requireTrustedProjectRoot(input.trustedProjectRoot) })
    : resolveRosterScopePaths({ scope: 'user', ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }) });
  const path = input.ref.path ?? formatAuthorityPath(rosterRevisionPath(paths, input.ref), paths.authorityRoot, paths.authorityDisplayRoot);
  return parseAutopilotRosterContract('autopilot.saved_roster_ref.v1', {
    roster_id: input.ref.roster_id,
    roster_revision: input.ref.roster_revision,
    roster_sha256: input.ref.roster_sha256,
    assignment_set_sha256: input.ref.assignment_set_sha256,
    path,
  });
}

export function transitionPathForExistingRun(input: {
  readonly stateRoot?: string | undefined;
  readonly repo_id: string;
  readonly workstream_run: string;
  readonly transition_id: string;
  readonly runtime_root?: string | undefined;
}): ExistingRunRosterTransitionPaths {
  assertValidRepoId(input.repo_id);
  assertValidWorkstreamRun(input.workstream_run);
  assertTransitionId(input.transition_id);
  const user = resolveRosterScopePaths({ scope: 'user', ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }) });
  const transitionsRoot = join(user.userStateRoot, 'roster-transitions', input.repo_id, input.workstream_run);
  const transitionPath = join(transitionsRoot, `${input.transition_id}.json`);
  const runtimeRoot = input.runtime_root ?? '<unresolved-runtime-root>';
  const runtimeTransitionRef = join('roster-transitions', `${input.transition_id}.json`).replace(/\\/gu, '/');
  const runtimeTransitionPath = join(runtimeRoot, runtimeTransitionRef);
  return Object.freeze({
    transitionsRoot,
    transitionPath,
    transitionDisplayPath: formatAuthorityPath(transitionPath, user.userStateRoot, user.userStateDisplayRoot),
    runtimeTransitionPath,
    runtimeTransitionRef,
    authorityRoot: user.userStateRoot,
    authorityDisplayRoot: user.userStateDisplayRoot,
  });
}

export function buildExistingRunRosterTransitionProposal(
  input: ExistingRunRosterTransitionProposalInput,
): ExistingRunRosterTransitionProposal {
  assertRunRef(input.run);
  assertUtcMsZ(input.approved_at, 'approved_at');
  const fromRoster = parseAutopilotRosterContract('autopilot.saved_roster_ref.v1', input.from_roster);
  const toRoster = parseAutopilotRosterContract('autopilot.saved_roster_ref.v1', input.to_roster);
  if (sameSavedRosterRef(fromRoster, toRoster)) {
    throw new RosterStorageError('ROSTER_TRANSITION_REQUIRED', 'from_roster and to_roster must be different saved roster refs');
  }
  const reason = sanitizeReason(input.reason);
  const transitionId = transitionIdForExactRefs({ repo_id: input.run.repo_id, workstream: input.run.workstream, workstream_run: input.run.workstream_run, from_roster: fromRoster, to_roster: toRoster });
  const transition = buildCanonicalRosterTransition({ transition_id: transitionId, from_roster: fromRoster, to_roster: toRoster, reason, approved_at: input.approved_at });
  const bytes = Buffer.from(autopilotRosterContractCanonicalJson(transition), 'utf8');
  const paths = transitionPathForExistingRun({ stateRoot: input.stateRoot, repo_id: input.run.repo_id, workstream_run: input.run.workstream_run, transition_id: transition.transition_id, runtime_root: input.run.runtime_root });
  const approvalPhrase = `APPROVE AUTOPILOT ROSTER TRANSITION ${transition.transition_id} ${transition.transition_sha256}`;
  const presentation = rosterTransitionApprovalPresentation({ run: input.run, transition, transition_display_path: paths.transitionDisplayPath, approval_phrase: approvalPhrase });
  return Object.freeze({
    schema_version: 'autopilot.existing_run_roster_transition_proposal.v1' as const,
    repo_id: input.run.repo_id,
    workstream: input.run.workstream,
    workstream_run: input.run.workstream_run,
    transition,
    transition_bytes: bytes,
    transition_path: paths.transitionPath,
    transition_display_path: paths.transitionDisplayPath,
    approval_phrase: approvalPhrase,
    presentation_sha256: sha256Text(presentation),
    presentation,
  });
}

export function authorizeExistingRunRosterTransitionInput(input: {
  readonly proposal: ExistingRunRosterTransitionProposal;
  readonly source?: string | undefined;
  readonly text: string;
}): ExistingRunRosterTransitionAuthorizationResult {
  if (input.source !== 'user') return Object.freeze({ ok: false, approval: null, reason: 'approval must come directly from user input' });
  if (input.text !== input.proposal.approval_phrase) {
    return Object.freeze({ ok: false, approval: null, reason: 'approval phrase did not exactly match the current transition presentation bytes' });
  }
  const approval: ExistingRunRosterTransitionApproval = Object.freeze({
    schema_version: 'autopilot.existing_run_roster_transition_approval.v1' as const,
    approval_token: approvalToken(input.proposal),
    repo_id: input.proposal.repo_id,
    workstream_run: input.proposal.workstream_run,
    transition_id: input.proposal.transition.transition_id,
    transition_sha256: input.proposal.transition.transition_sha256 as RosterSha256,
    presentation_sha256: input.proposal.presentation_sha256,
    approved_at: input.proposal.transition.approved_at,
    source: 'user' as const,
  });
  return Object.freeze({ ok: true, approval, reason: 'approved' });
}

export async function commitApprovedExistingRunRosterTransition(
  input: ExistingRunRosterTransitionCommitInput,
): Promise<ExistingRunRosterTransitionCommitResult> {
  const paths = transitionPathForExistingRun({ stateRoot: input.stateRoot, repo_id: input.run.repo_id, workstream_run: input.run.workstream_run, transition_id: input.proposal.transition.transition_id, runtime_root: input.run.runtime_root });
  let externalLinked = false;
  let runtimeLinked = false;
  try {
    assertRunRef(input.run);
    assertProposalMatchesRun(input.proposal, input.run);
    assertApprovalMatchesProposal(input.approval, input.proposal);
    if (input.expected_active_run !== undefined) assertExpectedActiveRun(input.expected_active_run, input.run);
    const expectedTransitionId = transitionIdForExactRefs({ repo_id: input.run.repo_id, workstream: input.run.workstream, workstream_run: input.run.workstream_run, from_roster: input.proposal.transition.from_roster, to_roster: input.proposal.transition.to_roster });
    if (input.proposal.transition.transition_id !== expectedTransitionId) {
      return transitionCommitResult(false, 'blocked', null, paths, false, [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal')], 0, []);
    }
    if (paths.transitionPath !== input.proposal.transition_path || paths.transitionDisplayPath !== input.proposal.transition_display_path) {
      return transitionCommitResult(false, 'blocked', null, paths, false, [diagnostic('ROSTER_STORAGE_PATH_INVALID', 'fatal')], 0, []);
    }
    const reparsed = parseAutopilotRosterContractJson('autopilot.roster_transition.v1', Buffer.from(input.proposal.transition_bytes).toString('utf8'));
    if (!sameTransition(reparsed, input.proposal.transition)) {
      return transitionCommitResult(false, 'blocked', null, paths, false, [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal')], 0, []);
    }
    const external = await publishCreateOnlyAtomic({
      path: paths.transitionPath,
      authorityRoot: paths.authorityRoot,
      bytes: input.proposal.transition_bytes,
      hooks: transactionHooks(input.hooks, (event) => { if (event.stage === 'after-link') externalLinked = true; }),
    });
    if (external.status === 'conflict') {
      return transitionCommitResult(false, 'blocked', null, paths, false, [diagnostic('ROSTER_CREATE_ONLY_CONFLICT')], 0, []);
    }
    const externalFilesTouched = external.status === 'created' || externalLinked ? [paths.transitionDisplayPath] : [];

    let runtime: Awaited<ReturnType<typeof publishCreateOnlyAtomic>>;
    try {
      runtime = await publishCreateOnlyAtomic({
        path: paths.runtimeTransitionPath,
        authorityRoot: dirname(paths.runtimeTransitionPath),
        bytes: input.proposal.transition_bytes,
        hooks: transactionHooks(input.hooks, (event) => { if (event.stage === 'after-link') runtimeLinked = true; }),
      });
    } catch (error) {
      const touched = [...externalFilesTouched, ...(runtimeLinked ? [paths.runtimeTransitionPath] : [])];
      return transitionCommitResult(false, 'failed', null, paths, false, [diagnosticFromError(error)], touched.length > 0 ? 1 : 0, touched);
    }
    if (runtime.status === 'conflict') {
      return transitionCommitResult(false, 'blocked', null, paths, false, [diagnostic('ROSTER_CREATE_ONLY_CONFLICT')], external.status === 'created' ? 1 : 0, externalFilesTouched);
    }

    const writeCount: 0 | 1 = external.status === 'created' || runtime.status === 'created' ? 1 : 0;
    const filesTouched = [
      ...externalFilesTouched,
      ...(runtime.status === 'created' ? [paths.runtimeTransitionPath] : []),
    ];
    let authenticated: Awaited<ReturnType<typeof authenticateTransitionCopies>>;
    try {
      authenticated = await authenticateTransitionCopies(paths, input.proposal.transition_bytes, input.proposal.transition);
    } catch {
      authenticated = null;
    }
    if (authenticated === null) {
      return transitionCommitResult(false, 'failed', null, paths, external.status === 'idempotent' && runtime.status === 'idempotent', [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal')], writeCount, filesTouched);
    }
    const idempotent = external.status === 'idempotent' && runtime.status === 'idempotent';
    return transitionCommitResult(true, idempotent ? 'inspected' : 'committed', authenticated.transition, paths, idempotent, [], writeCount, filesTouched, successorAuthority(input.run, authenticated.transition, paths, authenticated.artifactSha256));
  } catch (error) {
    const touched = [
      ...(externalLinked ? [paths.transitionDisplayPath] : []),
      ...(runtimeLinked ? [paths.runtimeTransitionPath] : []),
    ];
    return transitionCommitResult(false, 'failed', null, paths, false, [diagnosticFromError(error)], touched.length > 0 ? 1 : 0, touched);
  }
}

export async function consumeCommittedExistingRunRosterTransition(
  input: ExistingRunRosterTransitionConsumptionInput,
): Promise<ExistingRunRosterTransitionConsumptionResult> {
  try {
    assertRunRef(input.run);
    const expectedId = transitionIdForExactRefs({ repo_id: input.run.repo_id, workstream: input.run.workstream, workstream_run: input.run.workstream_run, from_roster: input.from_roster, to_roster: input.to_roster });
    const paths = transitionPathForExistingRun({ stateRoot: input.stateRoot, repo_id: input.run.repo_id, workstream_run: input.run.workstream_run, transition_id: expectedId, runtime_root: input.run.runtime_root });
    const externalRead = await readAuthorityFileIfPresent(paths.transitionPath, paths.authorityRoot);
    if (externalRead === null) return transitionConsumptionResult(false, 'blocked', null, null, null, null, null, null, [diagnostic('ROSTER_TRANSITION_REQUIRED')]);
    let transition: AutopilotRosterTransitionV1;
    try {
      transition = parseAutopilotRosterContractJson('autopilot.roster_transition.v1', Buffer.from(externalRead.bytes).toString('utf8'));
    } catch {
      return transitionConsumptionResult(false, 'failed', null, paths.transitionPath, paths.transitionDisplayPath, paths.runtimeTransitionPath, paths.runtimeTransitionRef, null, [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal')]);
    }
    const authenticated = await authenticateTransitionCopies(paths, externalRead.bytes, transition);
    if (authenticated === null || transition.transition_id !== expectedId || basename(paths.transitionPath) !== `${transition.transition_id}.json`) {
      return transitionConsumptionResult(false, 'failed', null, paths.transitionPath, paths.transitionDisplayPath, paths.runtimeTransitionPath, paths.runtimeTransitionRef, null, [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal')]);
    }
    if (!sameSavedRosterRef(transition.from_roster, input.from_roster) || !sameSavedRosterRef(transition.to_roster, input.to_roster) || transition.requires_explicit_user_approval !== true) {
      return transitionConsumptionResult(false, 'blocked', null, paths.transitionPath, paths.transitionDisplayPath, paths.runtimeTransitionPath, paths.runtimeTransitionRef, authenticated.artifactSha256, [diagnostic('ROSTER_TRANSITION_REQUIRED')]);
    }
    return transitionConsumptionResult(true, 'inspected', transition, paths.transitionPath, paths.transitionDisplayPath, paths.runtimeTransitionPath, paths.runtimeTransitionRef, authenticated.artifactSha256, [], successorAuthority(input.run, transition, paths, authenticated.artifactSha256));
  } catch (error) {
    return transitionConsumptionResult(false, 'failed', null, null, null, null, null, null, [diagnosticFromError(error)]);
  }
}

export async function resolveCommittedExistingRunRosterTransitionChain(input: {
  readonly stateRoot?: string | undefined;
  readonly run: ExistingRunRosterTransitionRunRef;
  readonly initial_from_roster: AutopilotSavedRosterRefV1;
}): Promise<ExistingRunRosterTransitionChainResult> {
  try {
    assertRunRef(input.run);
    const initial = parseAutopilotRosterContract('autopilot.saved_roster_ref.v1', input.initial_from_roster);
    const listed = await listCommittedExistingRunRosterTransitions({ stateRoot: input.stateRoot, repo_id: input.run.repo_id, workstream_run: input.run.workstream_run });
    const authenticated: { readonly transition: AutopilotRosterTransitionV1; readonly authority: ExistingRunRosterSuccessorAttemptAuthority }[] = [];
    for (const row of listed) {
      const expectedId = transitionIdForExactRefs({ repo_id: input.run.repo_id, workstream: input.run.workstream, workstream_run: input.run.workstream_run, from_roster: row.transition.from_roster, to_roster: row.transition.to_roster });
      const paths = transitionPathForExistingRun({ stateRoot: input.stateRoot, repo_id: input.run.repo_id, workstream_run: input.run.workstream_run, transition_id: row.transition.transition_id, runtime_root: input.run.runtime_root });
      const bytes = Buffer.from(autopilotRosterContractCanonicalJson(row.transition), 'utf8');
      const copy = await authenticateTransitionCopies(paths, bytes, row.transition);
      if (copy === null || row.transition.transition_id !== expectedId || row.transition.transition_id !== copy.transition.transition_id) {
        return transitionChainResult(false, 'failed', [], initial, null, [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal')]);
      }
      authenticated.push({ transition: copy.transition, authority: successorAuthority(input.run, copy.transition, paths, copy.artifactSha256) });
    }
    const byFrom = new Map<string, typeof authenticated>();
    for (const row of authenticated) {
      const key = savedRosterKey(row.transition.from_roster);
      byFrom.set(key, [...(byFrom.get(key) ?? []), row]);
    }
    const chain: AutopilotRosterTransitionV1[] = [];
    const visited = new Set<string>();
    let current = initial;
    let terminalAuthority: ExistingRunRosterSuccessorAttemptAuthority | null = null;
    for (;;) {
      const outgoing = byFrom.get(savedRosterKey(current)) ?? [];
      if (outgoing.length === 0) break;
      if (outgoing.length !== 1) return transitionChainResult(false, 'blocked', chain, current, null, [diagnostic('ROSTER_TRANSITION_REQUIRED')]);
      const next = outgoing[0];
      if (next === undefined) return transitionChainResult(false, 'failed', chain, current, null, [diagnostic('ROSTER_READBACK_MISMATCH', 'fatal')]);
      if (visited.has(next.transition.transition_id)) return transitionChainResult(false, 'blocked', chain, current, null, [diagnostic('ROSTER_TRANSITION_REQUIRED')]);
      visited.add(next.transition.transition_id);
      chain.push(next.transition);
      current = next.transition.to_roster;
      terminalAuthority = next.authority;
    }
    if (visited.size !== authenticated.length) return transitionChainResult(false, 'blocked', chain, current, null, [diagnostic('ROSTER_TRANSITION_REQUIRED')]);
    return transitionChainResult(true, 'inspected', chain, current, terminalAuthority, []);
  } catch (error) {
    return transitionChainResult(false, 'failed', [], input.initial_from_roster, null, [diagnosticFromError(error)]);
  }
}

export async function listCommittedExistingRunRosterTransitions(input: {
  readonly stateRoot?: string | undefined;
  readonly repo_id: string;
  readonly workstream_run: string;
}): Promise<readonly { readonly transition: AutopilotRosterTransitionV1; readonly path: string; readonly display_path: string }[]> {
  assertValidRepoId(input.repo_id);
  assertValidWorkstreamRun(input.workstream_run);
  const user = resolveRosterScopePaths({ scope: 'user', ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }) });
  const root = join(user.userStateRoot, 'roster-transitions', input.repo_id, input.workstream_run);
  let names: readonly string[];
  try {
    names = await readdir(root);
  } catch {
    return Object.freeze([]);
  }
  const rows: { readonly transition: AutopilotRosterTransitionV1; readonly path: string; readonly display_path: string }[] = [];
  for (const name of [...names].sort()) {
    if (!name.endsWith('.json')) continue;
    const transitionId = name.slice(0, -'.json'.length);
    if (!TRANSITION_ID_PATTERN.test(transitionId)) throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `invalid transition filename ${name}`);
    const paths = transitionPathForExistingRun({ stateRoot: input.stateRoot, repo_id: input.repo_id, workstream_run: input.workstream_run, transition_id: transitionId });
    const readback = await readAuthorityFileIfPresent(paths.transitionPath, user.userStateRoot);
    if (readback === null) continue;
    const transition = parseAutopilotRosterContractJson('autopilot.roster_transition.v1', Buffer.from(readback.bytes).toString('utf8'));
    if (transition.transition_id !== transitionId) throw new RosterStorageError('ROSTER_READBACK_MISMATCH', `transition id does not match filename ${name}`);
    rows.push(Object.freeze({ transition, path: paths.transitionPath, display_path: paths.transitionDisplayPath }));
  }
  return Object.freeze(rows);
}

function transitionIdForExactRefs(input: {
  readonly repo_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly from_roster: AutopilotSavedRosterRefV1;
  readonly to_roster: AutopilotSavedRosterRefV1;
}): string {
  const hash = createHash('sha256').update(autopilotRosterContractCanonicalJson({
    schema_version: 'autopilot.roster_transition_identity.v1',
    repo_id: input.repo_id,
    workstream: input.workstream,
    workstream_run: input.workstream_run,
    from_roster: input.from_roster,
    to_roster: input.to_roster,
  }), 'utf8').digest('hex');
  return `transition-${hash}`;
}

function buildCanonicalRosterTransition(input: {
  readonly transition_id: string;
  readonly from_roster: AutopilotSavedRosterRefV1;
  readonly to_roster: AutopilotSavedRosterRefV1;
  readonly reason: string;
  readonly approved_at: string;
}): AutopilotRosterTransitionV1 {
  const withPlaceholder = {
    schema_version: 'autopilot.roster_transition.v1' as const,
    transition_id: input.transition_id,
    from_roster: input.from_roster,
    to_roster: input.to_roster,
    reason: input.reason,
    requires_explicit_user_approval: true,
    approved_at: input.approved_at,
    transition_sha256: ZERO_SHA,
  };
  return parseAutopilotRosterContract('autopilot.roster_transition.v1', {
    ...withPlaceholder,
    transition_sha256: computeAutopilotRosterContractObjectHash('autopilot.roster_transition.v1', withPlaceholder),
  });
}

function rosterTransitionApprovalPresentation(input: {
  readonly run: ExistingRunRosterTransitionRunRef;
  readonly transition: AutopilotRosterTransitionV1;
  readonly transition_display_path: string;
  readonly approval_phrase: string;
}): string {
  const from = input.transition.from_roster;
  const to = input.transition.to_roster;
  return [
    'Autopilot existing-run roster transition approval required.',
    '',
    `Run: ${input.run.repo_id}/${input.run.workstream_run}`,
    `Workstream: ${input.run.workstream}`,
    `Transition id: ${input.transition.transition_id}`,
    `Transition sha256: ${input.transition.transition_sha256}`,
    `Transition path: ${input.transition_display_path}`,
    '',
    `FROM roster_id: ${from.roster_id}`,
    `FROM roster_revision: ${String(from.roster_revision)}`,
    `FROM roster_sha256: ${from.roster_sha256}`,
    `FROM assignment_set_sha256: ${from.assignment_set_sha256}`,
    `FROM path: ${from.path}`,
    '',
    `TO roster_id: ${to.roster_id}`,
    `TO roster_revision: ${String(to.roster_revision)}`,
    `TO roster_sha256: ${to.roster_sha256}`,
    `TO assignment_set_sha256: ${to.assignment_set_sha256}`,
    `TO path: ${to.path}`,
    '',
    `Reason: ${input.transition.reason}`,
    '',
    'This does not rewrite the existing external selection, runtime mirror, unit specs, receipts, observed identity, or historical validation. It records create-only transition history and authorizes only successor attempts; prior validation must be redone independently before closure.',
    '',
    'Approve by replying with exactly this single line:',
    input.approval_phrase,
  ].join('\n');
}

async function authenticateTransitionCopies(
  paths: Pick<ExistingRunRosterTransitionPaths, 'transitionPath' | 'runtimeTransitionPath' | 'authorityRoot'>,
  expectedBytes: Uint8Array,
  expectedTransition: AutopilotRosterTransitionV1,
): Promise<{ readonly transition: AutopilotRosterTransitionV1; readonly artifactSha256: RosterSha256 } | null> {
  const external = await readAuthorityFileIfPresent(paths.transitionPath, paths.authorityRoot);
  const runtime = await readAuthorityFileIfPresent(paths.runtimeTransitionPath, dirname(paths.runtimeTransitionPath));
  if (external === null || runtime === null) return null;
  if (!bytesEqual(external.bytes, expectedBytes) || !bytesEqual(runtime.bytes, expectedBytes) || !bytesEqual(external.bytes, runtime.bytes)) return null;
  const externalTransition = parseAutopilotRosterContractJson('autopilot.roster_transition.v1', Buffer.from(external.bytes).toString('utf8'));
  const runtimeTransition = parseAutopilotRosterContractJson('autopilot.roster_transition.v1', Buffer.from(runtime.bytes).toString('utf8'));
  if (!sameTransition(externalTransition, expectedTransition) || !sameTransition(runtimeTransition, expectedTransition)) return null;
  return Object.freeze({ transition: externalTransition, artifactSha256: sha256Bytes(external.bytes) });
}

function savedRosterKey(ref: AutopilotSavedRosterRefV1): string {
  return autopilotRosterContractCanonicalJson(ref);
}

function approvalToken(proposal: ExistingRunRosterTransitionProposal): string {
  const digest = createHash('sha256').update(autopilotRosterContractCanonicalJson({
    schema_version: 'autopilot.existing_run_roster_transition_approval_preimage.v1',
    repo_id: proposal.repo_id,
    workstream_run: proposal.workstream_run,
    transition_id: proposal.transition.transition_id,
    transition_sha256: proposal.transition.transition_sha256,
    presentation_sha256: proposal.presentation_sha256,
  }), 'utf8').digest('hex');
  return `transition-approval-${digest}`;
}

function successorAuthority(
  run: ExistingRunRosterTransitionRunRef,
  transition: AutopilotRosterTransitionV1,
  paths: ExistingRunRosterTransitionPaths,
  artifactSha256: RosterSha256,
): ExistingRunRosterSuccessorAttemptAuthority {
  return Object.freeze({
    schema_version: 'autopilot.existing_run_roster_successor_attempt_authority.v1' as const,
    repo_id: run.repo_id,
    workstream: run.workstream,
    workstream_run: run.workstream_run,
    transition_id: transition.transition_id,
    transition_sha256: transition.transition_sha256 as RosterSha256,
    transition_artifact_sha256: artifactSha256,
    transition_path: paths.transitionPath,
    transition_display_path: paths.transitionDisplayPath,
    runtime_transition_path: paths.runtimeTransitionPath,
    runtime_transition_ref: paths.runtimeTransitionRef,
    from_roster: transition.from_roster,
    to_roster: transition.to_roster,
    creates_new_attempts: true as const,
    preserves_external_selection: true as const,
    preserves_runtime_mirror: true as const,
    invalidates_prior_validation: true as const,
    requires_fresh_independent_validation_before_closure: true as const,
  });
}

function transitionCommitResult(
  ok: boolean,
  status: ExistingRunRosterTransitionCommitResult['status'],
  transition: AutopilotRosterTransitionV1 | null,
  paths: Pick<ExistingRunRosterTransitionPaths, 'transitionPath' | 'transitionDisplayPath' | 'runtimeTransitionPath' | 'runtimeTransitionRef'>,
  idempotentReplay: boolean,
  diagnostics: readonly RosterTransitionDiagnostic[],
  writeCount: 0 | 1,
  filesTouched: readonly string[],
  successor: ExistingRunRosterSuccessorAttemptAuthority | null = null,
): ExistingRunRosterTransitionCommitResult {
  return Object.freeze({
    schema_version: 'autopilot.existing_run_roster_transition_commit_result.v1' as const,
    ok,
    status,
    transition,
    transition_path: paths.transitionPath,
    transition_display_path: paths.transitionDisplayPath,
    runtime_transition_path: paths.runtimeTransitionPath,
    runtime_transition_ref: paths.runtimeTransitionRef,
    transition_artifact_sha256: successor?.transition_artifact_sha256 ?? null,
    idempotent_replay: idempotentReplay,
    successor_attempt_authority: successor,
    diagnostics: sortDiagnostics(diagnostics),
    write_count: writeCount,
    lock_count: 0 as const,
    files_touched: Object.freeze([...filesTouched]),
  });
}

function transitionChainResult(
  ok: boolean,
  status: ExistingRunRosterTransitionChainResult['status'],
  transitions: readonly AutopilotRosterTransitionV1[],
  terminalRoster: AutopilotSavedRosterRefV1,
  authority: ExistingRunRosterSuccessorAttemptAuthority | null,
  diagnostics: readonly RosterTransitionDiagnostic[],
): ExistingRunRosterTransitionChainResult {
  return Object.freeze({
    schema_version: 'autopilot.existing_run_roster_transition_chain_result.v1' as const,
    ok,
    status,
    transitions: Object.freeze([...transitions]),
    terminal_roster: terminalRoster,
    terminal_successor_attempt_authority: authority,
    diagnostics: sortDiagnostics(diagnostics),
  });
}

function transitionConsumptionResult(
  ok: boolean,
  status: ExistingRunRosterTransitionConsumptionResult['status'],
  transition: AutopilotRosterTransitionV1 | null,
  path: string | null,
  displayPath: string | null,
  runtimePath: string | null,
  runtimeRef: string | null,
  artifactSha256: RosterSha256 | null,
  diagnostics: readonly RosterTransitionDiagnostic[],
  successor: ExistingRunRosterSuccessorAttemptAuthority | null = null,
): ExistingRunRosterTransitionConsumptionResult {
  return Object.freeze({
    schema_version: 'autopilot.existing_run_roster_transition_consumption_result.v1' as const,
    ok,
    status,
    transition,
    transition_path: path,
    transition_display_path: displayPath,
    runtime_transition_path: runtimePath,
    runtime_transition_ref: runtimeRef,
    transition_artifact_sha256: artifactSha256,
    successor_attempt_authority: successor,
    diagnostics: sortDiagnostics(diagnostics),
    write_count: 0 as const,
    lock_count: 0 as const,
    files_touched: [] as readonly [],
  });
}

function assertRunRef(run: ExistingRunRosterTransitionRunRef): void {
  assertValidRepoId(run.repo_id);
  assertValidWorkstreamRun(run.workstream, 'workstream');
  assertValidWorkstreamRun(run.workstream_run);
  if (run.main_worktree_path.length === 0 || run.runtime_root.length === 0 || run.source_repo.length === 0) {
    throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', 'run transition identity is incomplete');
  }
}

function assertProposalMatchesRun(proposal: ExistingRunRosterTransitionProposal, run: ExistingRunRosterTransitionRunRef): void {
  if (proposal.repo_id !== run.repo_id || proposal.workstream_run !== run.workstream_run || proposal.workstream !== run.workstream) {
    throw new RosterStorageError('ROSTER_TRANSITION_REQUIRED', 'transition proposal belongs to a foreign run');
  }
}

function assertExpectedActiveRun(expected: Pick<ExistingRunRosterTransitionRunRef, 'repo_id' | 'workstream_run' | 'main_worktree_path' | 'runtime_root'>, run: ExistingRunRosterTransitionRunRef): void {
  if (expected.repo_id !== run.repo_id || expected.workstream_run !== run.workstream_run || expected.main_worktree_path !== run.main_worktree_path || expected.runtime_root !== run.runtime_root) {
    throw new RosterStorageError('ROSTER_TRANSITION_REQUIRED', 'active run identity drifted before transition commit');
  }
}

function assertApprovalMatchesProposal(approval: ExistingRunRosterTransitionApproval, proposal: ExistingRunRosterTransitionProposal): void {
  if (
    approval.source !== 'user' ||
    approval.repo_id !== proposal.repo_id ||
    approval.workstream_run !== proposal.workstream_run ||
    approval.transition_id !== proposal.transition.transition_id ||
    approval.transition_sha256 !== proposal.transition.transition_sha256 ||
    approval.presentation_sha256 !== proposal.presentation_sha256 ||
    approval.approved_at !== proposal.transition.approved_at ||
    approval.approval_token !== approvalToken(proposal)
  ) {
    throw new RosterStorageError('ROSTER_TRANSITION_REQUIRED', 'transition approval token is not bound to the exact proposal');
  }
}

function assertTransitionId(value: string): void {
  if (!TRANSITION_ID_PATTERN.test(value)) throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `invalid transition_id: ${value}`);
}

function assertUtcMsZ(value: string, label: string): void {
  if (!UTC_MS_Z_PATTERN.test(value)) throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', `${label} must be UTC milliseconds with Z suffix`);
}

function sanitizeReason(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new RosterStorageError('ROSTER_TRANSITION_REQUIRED', 'transition reason is required');
  if (trimmed.length > 1000) throw new RosterStorageError('ROSTER_STORAGE_PATH_INVALID', 'transition reason exceeds schema bound');
  return trimmed;
}

function requireTrustedProjectRoot(value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new RosterStorageError('ROSTER_STORAGE_TRUST_REQUIRED', 'trusted project root is required for trusted-project roster refs');
  return value;
}

function sameSavedRosterRef(left: AutopilotSavedRosterRefV1, right: AutopilotSavedRosterRefV1): boolean {
  return left.roster_id === right.roster_id &&
    left.roster_revision === right.roster_revision &&
    left.roster_sha256 === right.roster_sha256 &&
    left.assignment_set_sha256 === right.assignment_set_sha256 &&
    left.path === right.path;
}

function sameTransition(left: AutopilotRosterTransitionV1, right: AutopilotRosterTransitionV1): boolean {
  return autopilotRosterContractCanonicalJson(left) === autopilotRosterContractCanonicalJson(right);
}

function diagnostic(code: string, severity?: RosterTransitionDiagnostic['severity']): RosterTransitionDiagnostic {
  const normalized = normalizeCode(code);
  return Object.freeze({
    code: normalized,
    severity: severity ?? severityForCode(normalized),
    message: messageForCode(normalized),
    remediation: 'Use an explicit user-approved existing-run roster transition, then retry without changing historical selection bytes.',
    secret_free: true as const,
  });
}

function diagnosticFromError(error: unknown): RosterTransitionDiagnostic {
  if (error instanceof RosterStorageError) return diagnostic(error.code, severityForCode(normalizeCode(error.code)));
  if (error instanceof SyntaxError) return diagnostic('ROSTER_READBACK_MISMATCH', 'fatal');
  return diagnostic('ROSTER_READBACK_MISMATCH', 'fatal');
}

function normalizeCode(code: string): string {
  switch (code) {
    case 'ROSTER_TRANSITION_REQUIRED':
    case 'ROSTER_PINNED_SELECTION_UNAVAILABLE':
    case 'ROSTER_CREATE_ONLY_CONFLICT':
    case 'ROSTER_READBACK_MISMATCH':
    case 'ROSTER_STORAGE_AUTHORITY_UNSAFE':
    case 'ROSTER_STORAGE_PATH_INVALID':
    case 'ROSTER_STORAGE_PERMISSION_DENIED':
    case 'ROSTER_STORAGE_TRUST_REQUIRED':
    case 'ROSTER_STORAGE_UNSUPPORTED_PLATFORM':
      return code;
    default:
      return 'ROSTER_READBACK_MISMATCH';
  }
}

function severityForCode(code: string): RosterTransitionDiagnostic['severity'] {
  if (code === 'ROSTER_READBACK_MISMATCH' || code === 'ROSTER_STORAGE_AUTHORITY_UNSAFE' || code === 'ROSTER_STORAGE_UNSUPPORTED_PLATFORM') return 'fatal';
  return 'error';
}

function messageForCode(code: string): string {
  switch (code) {
    case 'ROSTER_CREATE_ONLY_CONFLICT':
      return 'A roster transition authority file already exists with different bytes.';
    case 'ROSTER_TRANSITION_REQUIRED':
      return 'An explicit committed existing-run roster transition is required.';
    case 'ROSTER_PINNED_SELECTION_UNAVAILABLE':
      return 'The existing run pinned roster authority is unavailable.';
    case 'ROSTER_READBACK_MISMATCH':
      return 'Roster transition readback or canonical validation failed closed.';
    case 'ROSTER_STORAGE_AUTHORITY_UNSAFE':
      return 'Roster transition storage authority failed no-follow/private-file safety checks.';
    case 'ROSTER_STORAGE_PATH_INVALID':
      return 'Roster transition storage rejected an invalid path or identity.';
    case 'ROSTER_STORAGE_PERMISSION_DENIED':
      return 'Roster transition storage is not private to the current user.';
    case 'ROSTER_STORAGE_TRUST_REQUIRED':
      return 'Trusted-project transition refs require the exact trusted project root.';
    default:
      return `${code} roster transition diagnostic`;
  }
}

function sortDiagnostics(diagnostics: readonly RosterTransitionDiagnostic[]): readonly RosterTransitionDiagnostic[] {
  const byCode = new Map<string, RosterTransitionDiagnostic>();
  for (const item of diagnostics) byCode.set(item.code, item);
  return Object.freeze([...byCode.values()].sort((a, b) => a.code.localeCompare(b.code)));
}

function transactionHooks(
  hooks: ExistingRunRosterTransitionCommitInput['hooks'],
  observe?: ((event: RosterTransactionStageEvent) => void) | undefined,
): { readonly onStage?: (event: RosterTransactionStageEvent) => void | Promise<void> } | undefined {
  if (hooks?.onTransactionStage === undefined && observe === undefined) return undefined;
  return { onStage: async (event) => { observe?.(event); await hooks?.onTransactionStage?.(event); } };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return diff === 0;
}

function sha256Text(text: string): RosterSha256 {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function sha256Bytes(bytes: Uint8Array): RosterSha256 {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
