import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { platform } from 'node:os';

import {
  parseAutopilotExecutionAudit,
  parseAutopilotExecutionCommit,
  parseAutopilotMasterPlan,
  parseAutopilotState,
  parseAutopilotStatusEntry,
  parseAutopilotDecisionRow,
  type AutopilotDecisionRow,
  type AutopilotExecutionAudit,
  type AutopilotExecutionCommit,
  type AutopilotMasterPlan,
  type AutopilotState,
  type AutopilotStatusEntry,
} from './contracts/index.ts';
import { evaluateAutopilotClosureGate } from './lifecycle/index.ts';
import { parseAutopilotUnitMerge, type AutopilotUnitMerge } from './unit-merge.ts';
import { cleanupClosedAutopilotRun } from './worktree-cleanup.ts';
import { executeOwnedWorktreeSaga, inspectOwnedWorktreeSpecPostcondition, OwnedWorktreeSagaClient, WorktreeSagaCompensatedError } from './coordination/worktree-saga.ts';
import { AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV, AUTOPILOT_RUNTIME_ROOT_PREFIX } from './names.ts';
import { CoordinatorClient } from './coordination/client.ts';
import { CoordinationRuntimeError } from './coordination/failures.ts';
import { parseCoordinationAuthoritativeArtifact, parseCoordinationReconciliationEvidence, parseCoordinationRun, parseCoordinationRunTerminalIntent, parseCoordinationSessionLease, parseCoordinationWorktree } from './coordination/contracts.ts';
import { assertD65OrdinaryBoundaryFromEnvironment, assertD65RecoveryBoundaryFromEnvironment, ensureD65ProgramHeartbeatForGraphFromEnvironment } from './coordination/d65-runtime-dispatch.ts';
import { publishD65CoordinatorOnlySuccessorFromEnvironment } from './coordination/d65-graph-successor-runtime.ts';
import { DurableRunSupervisorClient, readCoordinatorSessionContext } from './coordination/supervisor.ts';
import { recordCoordinatorReleaseEvidenceFromFile } from './coordination/reconciliation.ts';
import { ReservationCoordinationClient, preparePendingReservationIntegrations, preparedRunTerminalIntent, reconcilePendingReservationResolutions, reservationCloseBlockers, resolvedReservationIntegrations } from './coordination/reservations.ts';
import type { CoordinationRunTerminalIntent } from './coordination/types.ts';
import {
  ACTIVE_AUTOPILOTS_FILE,
  BRANCHES_FILE,
  CLAIM_EVENTS_FILE,
  FOREIGN_MERGE_ACKS_FILE,
  MERGE_LOG_FILE,
  PATH_CLAIMS_FILE,
  TASK_INFO_FILE,
  UNIT_INDEX_FILE,
  WORKTREE_INDEX_FILE,
  appendClaimEvent,
  appendJsonl,
  coordinationRootForRepo,
  gitHead,
  isAutopilotRuntimeRepoPath,
  mainMergeLockPathForRepo,
  matchesRepoPathPattern,
  pathOverlapsOrContains,
  readActiveAutopilots,
  readCoordinatorActiveAutopilots,
  readGitStatus,
  readPathClaims,
  readUnitIndex,
  readWorktreeIndex,
  resolveAutopilotStateRoot,
  resolveRepoIdentity,
  taskRootForActiveAutopilot,
  updateTaskInfoStatus,
  withAutopilotFileLock,
  worktreeRootForRepo,
  writeActiveAutopilots,
  writeJsonAtomic,
  writePathClaims,
  type ActiveAutopilotRow,
  type AutopilotPathClaim,
  type AutopilotParentStatus,
  type ProcessEnvLike,
} from './parallel-runtime.ts';
import { gitQueryNulStrings, gitQueryText, runGitMutation, runGitQuery } from './git-process.ts';
import { assertCoordinationDispatchAllowed, coordinationCutoverCommitted } from './coordination/migration-paths.ts';
import { coordinatorRuntimePaths } from './coordination/runtime-paths.ts';
import { currentBootId } from './coordination/process-identity.ts';
import { enforcePrivateAuthorityPath, ensurePrivateAuthorityDirectory } from './private-path.ts';

export interface AutopilotCloseOptions {
  readonly workstream: string;
  readonly sourceCwd: string;
  readonly workstreamRun?: string | null;
  readonly dryRun?: boolean;
  readonly env?: ProcessEnvLike;
  readonly now?: Date;
  readonly coordinationSessionId?: string;
  readonly observeTerminalCleanupBoundary?: (boundary: AutopilotTerminalCleanupBoundary) => Promise<void> | void;
  /** Deterministic race witness used to prove the durable pre-validation fence. */
  readonly observeCloseRaceBoundary?: (boundary: AutopilotCloseRaceBoundary) => Promise<void> | void;
}

export const AUTOPILOT_CLOSE_RACE_BOUNDARIES = ['after-durable-launch-fence-before-validation', 'after-private-archive-staging-before-terminal-commit'] as const;
export type AutopilotCloseRaceBoundary = (typeof AUTOPILOT_CLOSE_RACE_BOUNDARIES)[number];

export type AutopilotCloseOutcome = 'dry-run' | 'closed' | 'blocked' | 'aborted';

export const AUTOPILOT_TERMINAL_CLEANUP_BOUNDARIES = ['after-terminal-manifest', 'after-terminal-commit', 'after-terminal-projections', 'after-runtime-archive', 'after-result-projection', 'after-archive-ref', 'after-unit-cleanup', 'after-main-cleanup'] as const;
export type AutopilotTerminalCleanupBoundary = (typeof AUTOPILOT_TERMINAL_CLEANUP_BOUNDARIES)[number];

export interface AutopilotCloseResult {
  readonly schema_version: 'autopilot.close_result.v1';
  readonly outcome: AutopilotCloseOutcome;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly autopilot_id: string;
  readonly repo_key: string;
  readonly branch: string;
  readonly target_branch: string | null;
  readonly target_before: string;
  readonly target_after: string | null;
  readonly workstream_before: string;
  readonly workstream_after: string | null;
  readonly integration_commit_sha: string | null;
  readonly changed_paths: readonly string[];
  readonly released_claims: readonly string[];
  readonly archived_runtime_path: string | null;
  readonly archive_ref: string | null;
  readonly merge_id: string | null;
  readonly blockers: readonly string[];
  readonly close_result_path: string | null;
  readonly created_at: string;
}

export interface AutopilotMergeEvent {
  readonly schema_version: 'autopilot.merge_event.v1';
  readonly merge_id: string;
  readonly repo_key: string;
  readonly autopilot_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly branch: string;
  readonly target_branch: string;
  readonly target_before: string;
  readonly target_after: string;
  readonly workstream_before: string;
  readonly workstream_after: string;
  readonly integration_commit_sha: string | null;
  readonly changed_paths: readonly string[];
  readonly merged_at: string;
}

export interface AutopilotForeignMergeAck {
  readonly schema_version: 'autopilot.foreign_merge_ack.v1';
  readonly ack_id: string;
  readonly merge_id: string;
  readonly repo_key: string;
  readonly acknowledging_autopilot_id: string;
  readonly acknowledging_workstream_run: string;
  readonly foreign_autopilot_id: string;
  readonly foreign_workstream_run: string;
  readonly action: 'non-intersecting';
  readonly intersection_paths: readonly string[];
  readonly acked_at: string;
}

interface RuntimeArtifacts {
  readonly state: AutopilotState | null;
  readonly masterPlan: AutopilotMasterPlan | null;
  readonly statuses: readonly AutopilotStatusEntry[];
  readonly audits: readonly AutopilotExecutionAudit[];
  readonly decisions: readonly AutopilotDecisionRow[];
  readonly executionCommits: readonly AutopilotExecutionCommit[];
  readonly unitMerges: readonly AutopilotUnitMerge[];
  readonly validationStalenessRefs: readonly string[];
}

interface PreparedCloseContext {
  readonly repo: ReturnType<typeof resolveRepoIdentity>;
  readonly coordinationRoot: string;
  readonly worktreeRoot: string;
  readonly active: ActiveAutopilotRow;
}

interface TerminalCleanupManifest {
  readonly schema_version: 'autopilot.terminal_cleanup.v1';
  readonly repo_key: string;
  readonly autopilot_id: string;
  readonly workstream: string;
  readonly workstream_run: string;
  readonly outcome: 'closed' | 'aborted';
  readonly terminal_sha: string;
  readonly archive_ref: string;
  readonly archive_runtime_path: string;
  readonly result_path: string;
  readonly result: AutopilotCloseResult;
  readonly prepared_at: string;
}

interface CloseSessionBinding {
  readonly env: ProcessEnvLike;
  readonly supervisor: DurableRunSupervisorClient | null;
  readonly attachment: Awaited<ReturnType<DurableRunSupervisorClient['attach']>> | null;
}

interface TerminalCleanupRecovery {
  readonly context: PreparedCloseContext;
  readonly manifest: TerminalCleanupManifest;
  readonly env: ProcessEnvLike;
}

interface CloseValidationResult {
  readonly retainedClaims: readonly AutopilotPathClaim[];
  readonly retainedWriteClaims: readonly AutopilotPathClaim[];
  readonly executionCommits: readonly AutopilotExecutionCommit[];
  readonly unitMerges: readonly AutopilotUnitMerge[];
  readonly preIntegrationChangedPaths: readonly string[];
  readonly targetDeltaPaths: readonly string[];
  readonly unackedForeignMerges: readonly AutopilotMergeEvent[];
  readonly nonIntersectingForeignMerges: readonly AutopilotMergeEvent[];
  readonly blockers: readonly string[];
}

export class AutopilotCloseError extends Error {
  override readonly name = 'AutopilotCloseError';
  readonly code: string;
  readonly evidence: readonly string[];

  constructor(code: string, message: string, evidence: readonly string[] = []) {
    super(`AutopilotCloseError [${code}]: ${message}`);
    this.code = code;
    this.evidence = Object.freeze([...evidence]);
  }
}

function fail(code: string, message: string, evidence: readonly string[] = []): never {
  throw new AutopilotCloseError(code, message, evidence);
}

async function isD65CoordinatorRun(active: ActiveAutopilotRow, env: ProcessEnvLike): Promise<boolean> {
  if (active.coordination_authority !== 'coordinator-edit-leases-v1') return false;
  const status = await new CoordinatorClient({ env }).query('status', active.repo_key, active.workstream_run);
  const artifacts = status.payload['authoritative_artifacts'];
  if (!Array.isArray(artifacts)) throw new AutopilotCloseError('coordination-authority-invalid', 'D65 classification lacks authoritative_artifacts.');
  const bootstrapId = `semantic-graph-bootstrap:${active.workstream_run}`;
  return artifacts.map(parseCoordinationAuthoritativeArtifact).some((artifact) => artifact.artifact_id === bootstrapId && artifact.document_schema_version === 'autopilot.semantic_graph_bootstrap.v1');
}

const TERMINAL_RECOVERY_BINDINGS = Object.freeze({ attached_session_current: false, policy_trust_current: false, no_pending_publication: false, terminal_prepared_cancellable: false, terminal_after_commit: false, accepted_continuation_reason: null, covered_semantic_reason: null, attach_terminal_recovery: false });
const TERMINAL_AFTER_COMMIT_BINDINGS = Object.freeze({ ...TERMINAL_RECOVERY_BINDINGS, terminal_after_commit: true });

async function assertD65TerminalCleanupBoundary(active: ActiveAutopilotRow, env: ProcessEnvLike): Promise<void> {
  if (await isD65CoordinatorRun(active, env)) await assertD65RecoveryBoundaryFromEnvironment('terminal-tail', TERMINAL_AFTER_COMMIT_BINDINGS, env);
}

async function publishAndAuthenticateD65PreparedTerminalSuccessor(env: ProcessEnvLike, createdAt: string): Promise<void> {
  const published = await publishD65CoordinatorOnlySuccessorFromEnvironment({ env, createdAt });
  if (published.semanticEventType !== null && published.semanticEventType !== 'run-terminal-prepared') throw new AutopilotCloseError('terminal-successor-event-mismatch', 'D65 terminal successor publication covered a semantic event other than terminal preparation.', [published.semanticEventType]);
  await ensureD65ProgramHeartbeatForGraphFromEnvironment({ graphSequence: published.graphSequence, graphSha256: published.graphSha256, env });
}

export async function closeAutopilotWorkstream(options: AutopilotCloseOptions): Promise<AutopilotCloseResult> {
  let env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    const recovered = await recoverAutopilotTerminalCleanup({ ...options, expectedOutcome: 'closed' });
    if (recovered !== null) return recovered;
  }
  const prepared = await resolveCloseContext(options, env);
  const sessionBinding = dryRun ? { env, supervisor: null, attachment: null } : await ensureCloseSession(prepared, env, options.coordinationSessionId);
  env = sessionBinding.env;

  if (dryRun) {
    const validation = await validateCloseReadiness(prepared, now, env);
    return buildCloseResult({
      outcome: 'dry-run',
      active: prepared.active,
      repoKey: prepared.repo.repoKey,
      targetBefore: gitHead(prepared.repo.repoRoot),
      targetAfter: null,
      workstreamBefore: gitHead(prepared.active.main_worktree_path),
      workstreamAfter: null,
      integrationCommitSha: null,
      changedPaths: validation.preIntegrationChangedPaths,
      releasedClaims: [],
      archivedRuntimePath: null,
      archiveRef: null,
      mergeId: null,
      blockers: validation.blockers,
      closeResultPath: null,
      now,
    });
  }

  try {
    return await withAutopilotFileLock(
    closeMergeLockPath(prepared, env),
    `autopilot-close:${prepared.active.autopilot_id}:${prepared.active.workstream_run}`,
    async () => {
      let active = await setActiveStatus(prepared.coordinationRoot, prepared.active, 'merging', now, null);
      const context: PreparedCloseContext = { ...prepared, active };
      const coordinatorAuthority = active.coordination_authority === 'coordinator-edit-leases-v1';
      if (coordinatorAuthority && env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] === undefined) fail('coordination-authority-unavailable', 'Coordinator-backed close requires its durable coordinator session; refusing legacy fallback.');
      const d65 = coordinatorAuthority && await isD65CoordinatorRun(active, env);
      const attemptPath = await writeCloseAttempt(context, now, d65);
      let terminalIntent: CoordinationRunTerminalIntent | null = coordinatorAuthority ? await preparedRunTerminalIntent(active, env) : null;
      if (terminalIntent !== null && terminalIntent.outcome !== 'closed') fail('terminal-intent-outcome-mismatch', 'prepared coordinator terminal intent is for abort, not close.', [terminalIntent.terminal_intent_id]);
      let coordinatorTerminalCommitted = false;
      let targetLanded = false;
      try {
        const existingManifestPath = terminalCleanupManifestPath(active);
        if (d65 && existsSync(existingManifestPath)) {
          const manifest = await readTerminalCleanupManifest(active);
          if (manifest.outcome !== 'closed') fail('terminal-intent-outcome-mismatch', 'existing D65 terminal cleanup manifest is not a close intent.', [existingManifestPath]);
          const workstreamAfter = gitHead(active.main_worktree_path);
          if (manifest.terminal_sha !== workstreamAfter || manifest.result.target_after !== workstreamAfter || manifest.result.workstream_after !== workstreamAfter) fail('terminal-successor-context-mismatch', 'prepared D65 close manifest no longer equals the immutable workstream terminal authority.', [manifest.terminal_sha, workstreamAfter]);
          if (terminalIntent === null) terminalIntent = await (await ReservationCoordinationClient.fromEnvironment(env)).prepareRunTerminal('closed');
          if (terminalIntent.outcome !== 'closed') fail('terminal-intent-outcome-mismatch', 'prepared coordinator terminal intent is for abort, not close.', [terminalIntent.terminal_intent_id]);
          await publishAndAuthenticateD65PreparedTerminalSuccessor(env, manifest.prepared_at);
          await assertD65RecoveryBoundaryFromEnvironment('terminal-tail', TERMINAL_RECOVERY_BINDINGS, env);
          let targetAfter = gitHead(context.repo.repoRoot);
          if (targetAfter !== manifest.terminal_sha) {
            if (targetAfter !== manifest.result.target_before) fail('terminal-successor-context-mismatch', 'D65 close resume target is neither the immutable pre-effect authority nor the terminal authority.', [targetAfter, manifest.result.target_before ?? '<null>', manifest.terminal_sha]);
            await fastForwardD65TerminalTarget({ active, sourceRepo: context.repo.repoRoot, targetBefore: targetAfter });
            targetAfter = gitHead(context.repo.repoRoot);
          }
          if (targetAfter !== manifest.terminal_sha) fail('terminal-successor-context-mismatch', 'D65 close terminal Git effect did not land the immutable prepared authority.', [targetAfter, manifest.terminal_sha]);
          targetLanded = true;
          await writeAndRecordRunTerminalEvidence(active, 'closed', targetAfter, env, new Date(manifest.prepared_at));
          coordinatorTerminalCommitted = true;
          active = await setActiveStatus(context.coordinationRoot, active, 'closed', new Date(manifest.prepared_at), manifest.prepared_at);
          const terminalResult = await completeTerminalCleanup({ context: { ...context, active }, manifest, env }, options.observeTerminalCleanupBoundary);
          await detachExistingTerminalSession(sessionBinding, active, 'close-terminal-cleanup-finished');
          return terminalResult;
        }
        // The coordinator transaction changes the durable run to merging and
        // installs the launch fence before validation can observe mutable state.
        if (coordinatorAuthority && !d65 && terminalIntent === null) terminalIntent = await (await ReservationCoordinationClient.fromEnvironment(env)).prepareRunTerminal('closed');
        if (coordinatorAuthority) await options.observeCloseRaceBoundary?.('after-durable-launch-fence-before-validation');
        await validateTerminalArchiveSources(context);
        if (coordinatorAuthority) {
          await preparePendingReservationIntegrations(active, env, now);
          await reconcilePendingReservationResolutions(active, env);
        }
        const validation = await validateCloseReadiness(context, now, env, terminalIntent !== null);
        if (validation.blockers.length > 0) {
          if (terminalIntent !== null) {
            await (await ReservationCoordinationClient.fromEnvironment(env)).cancelRunTerminal(terminalIntent, 'close validation blocked');
            terminalIntent = null;
          }
          active = await setActiveStatus(context.coordinationRoot, active, 'blocked', now, null);
          const result = buildCloseResult({
            outcome: 'blocked',
            active,
            repoKey: context.repo.repoKey,
            targetBefore: gitHead(context.repo.repoRoot),
            targetAfter: null,
            workstreamBefore: gitHead(active.main_worktree_path),
            workstreamAfter: null,
            integrationCommitSha: null,
            changedPaths: validation.preIntegrationChangedPaths,
            releasedClaims: [],
            archivedRuntimePath: null,
            archiveRef: null,
            mergeId: null,
            blockers: validation.blockers,
            closeResultPath: null,
            now,
          });
          const resultPath = await writeCloseResult(active.runtime_root, result, now);
          return { ...result, close_result_path: resultPath };
        }

        const targetBefore = gitHead(context.repo.repoRoot);
        const workstreamBefore = gitHead(active.main_worktree_path);
        if (d65 && terminalIntent === null) await assertD65OrdinaryBoundaryFromEnvironment('unit-merge', env);
        const integrationCommitSha = d65 && terminalIntent !== null ? null : await integrateTargetIntoWorkstream({ active, targetHead: targetBefore, env });
        const workstreamAfter = gitHead(active.main_worktree_path);
        const changedPaths = d65
          ? validation.preIntegrationChangedPaths
          : terminalIntent !== null && targetBefore === workstreamBefore
            ? diffPaths(active.main_worktree_path, active.target_base_sha, workstreamAfter)
            : diffPaths(active.main_worktree_path, targetBefore, workstreamAfter);
        const postIntegrationBlockers = validation.unitMerges.length > 0
          ? phaseTwoCloseBlockers(active, validation.unitMerges, [], changedPaths)
          : finalDiffBlockers(changedPaths, validation.retainedWriteClaims, validation.executionCommits);
        if (postIntegrationBlockers.length > 0) {
          active = await setActiveStatus(context.coordinationRoot, active, 'blocked', now, null);
          const result = buildCloseResult({
            outcome: 'blocked',
            active,
            repoKey: context.repo.repoKey,
            targetBefore,
            targetAfter: null,
            workstreamBefore,
            workstreamAfter,
            integrationCommitSha,
            changedPaths,
            releasedClaims: [],
            archivedRuntimePath: null,
            archiveRef: null,
            mergeId: null,
            blockers: postIntegrationBlockers,
            closeResultPath: null,
            now,
          });
          if (terminalIntent !== null) await (await ReservationCoordinationClient.fromEnvironment(env)).cancelRunTerminal(terminalIntent, 'post-integration close proof blocked');
          terminalIntent = null;
          const resultPath = await writeCloseResult(active.runtime_root, result, now);
          return { ...result, close_result_path: resultPath };
        }

        const archiveRef = `autopilot/archive/${active.workstream_run}/main`;
        await assertPrivateTerminalArchiveAncestry(context, true);
        await options.observeCloseRaceBoundary?.('after-private-archive-staging-before-terminal-commit');
        await assertPrivateTerminalArchiveAncestry(context, true);
        const proposedClosedActive: ActiveAutopilotRow = { ...active, status: 'closed', active_epoch_started_at: now.toISOString() };
        const proposedClosedContext: PreparedCloseContext = { ...context, active: proposedClosedActive };
        const mergeId = buildId('merge', active.workstream_run, now);
        const preparedTargetAfter = workstreamAfter;
        if (d65 && terminalIntent === null) terminalIntent = await (await ReservationCoordinationClient.fromEnvironment(env)).prepareRunTerminal('closed');
        if (d65) {
          await publishAndAuthenticateD65PreparedTerminalSuccessor(env, now.toISOString());
          await assertD65RecoveryBoundaryFromEnvironment('terminal-tail', TERMINAL_RECOVERY_BINDINGS, env);
        }
        const manifest = await prepareTerminalCleanupManifest({
          context: proposedClosedContext, outcome: 'closed', terminalSha: preparedTargetAfter, archiveRef, now,
          result: buildCloseResult({
            outcome: 'closed', active: proposedClosedActive, repoKey: context.repo.repoKey, targetBefore, targetAfter: preparedTargetAfter, workstreamBefore, workstreamAfter,
            integrationCommitSha, changedPaths, releasedClaims: validation.retainedClaims.map((claim) => `${claim.claim_type} ${claim.path}`),
            archivedRuntimePath: join(context.worktreeRoot, '_archive', active.workstream_run, 'runtime'), archiveRef, mergeId, blockers: [],
            closeResultPath: join(context.worktreeRoot, '_archive', active.workstream_run, '_close-result.json'), now,
          }),
        });
        await observeTerminalBoundary(options, 'after-terminal-manifest');
        if (d65) await fastForwardD65TerminalTarget({ active, sourceRepo: context.repo.repoRoot, targetBefore });
        else await fastForwardTargetToWorkstream({ active, sourceRepo: context.repo.repoRoot, branch: active.branch, targetBefore, env });
        targetLanded = true;
        const targetAfter = gitHead(context.repo.repoRoot);
        if (targetAfter !== preparedTargetAfter) fail('terminal-successor-context-mismatch', 'close terminal Git effect differs from its immutable prepared workstream authority.', [targetAfter, preparedTargetAfter]);
        const mergeEvent: AutopilotMergeEvent = {
          schema_version: 'autopilot.merge_event.v1',
          merge_id: mergeId,
          repo_key: context.repo.repoKey,
          autopilot_id: active.autopilot_id,
          workstream: active.workstream,
          workstream_run: active.workstream_run,
          branch: active.branch,
          target_branch: requireTargetBranch(active),
          target_before: targetBefore,
          target_after: targetAfter,
          workstream_before: workstreamBefore,
          workstream_after: workstreamAfter,
          integration_commit_sha: integrationCommitSha,
          changed_paths: changedPaths,
          merged_at: now.toISOString(),
        };
        if (!coordinationCutoverCommitted(resolveAutopilotStateRoot(env), active.repo_key)) {
          await appendJsonl(join(context.coordinationRoot, MERGE_LOG_FILE), parseMergeEvent(mergeEvent));
          await appendForeignMergeAcks(context, validation.nonIntersectingForeignMerges, now);
        }
        await writeAndRecordRunTerminalEvidence(active, 'closed', targetAfter, env, now);
        coordinatorTerminalCommitted = true;
        active = await setActiveStatus(context.coordinationRoot, active, 'closed', now, now.toISOString());
        const closedContext: PreparedCloseContext = { ...context, active };
        await observeTerminalBoundary(options, 'after-terminal-commit');
        const terminalResult = await completeTerminalCleanup({ context: closedContext, manifest, env }, options.observeTerminalCleanupBoundary);
        await detachExistingTerminalSession(sessionBinding, active, 'close-terminal-cleanup-finished');
        return terminalResult;

      } catch (error) {
        if (coordinatorTerminalCommitted) fail('terminal-cleanup-recovery-required', `Coordinator close is terminal; remaining archive/worktree cleanup must resume forward-only after attempt ${attemptPath}: ${errorMessage(error)}`, [active.workstream_run]);
        if (d65 && terminalIntent !== null) fail('terminal-successor-required', `D65 close is durably prepared${targetLanded ? ' after final product mutation' : ''}; publish/accept its prepared-terminal successor graph and governing heartbeat, then resume the same intent: ${errorMessage(error)}`, [terminalIntent.terminal_intent_id]);
        const recoveryFailures: string[] = [];
        if (terminalIntent !== null && !targetLanded) {
          try {
            await (await ReservationCoordinationClient.fromEnvironment(env)).cancelRunTerminal(terminalIntent, 'close failed before final target mutation');
            terminalIntent = null;
          } catch (recoveryError) { recoveryFailures.push(`terminal-intent cancellation/cadence failed: ${errorMessage(recoveryError)}`); }
        }
        try { await setActiveStatus(prepared.coordinationRoot, active, 'blocked', now, null); }
        catch (recoveryError) { recoveryFailures.push(`active-row recovery classification failed: ${errorMessage(recoveryError)}`); }
        if (recoveryFailures.length > 0) fail('close-recovery-failed', `Autopilot close failed (${errorMessage(error)}) and durable recovery also failed.`, recoveryFailures);
        if (error instanceof AutopilotCloseError) throw error;
        fail('close-failed', `Autopilot close failed after attempt ${attemptPath}: ${errorMessage(error)}`);
      }
    },
    );
  } finally {
    await detachTransientCloseSession(sessionBinding, 'close-invocation-finished');
  }
}

export async function abortAutopilotWorkstream(options: AutopilotCloseOptions): Promise<AutopilotCloseResult> {
  let env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    const recovered = await recoverAutopilotTerminalCleanup({ ...options, expectedOutcome: 'aborted' });
    if (recovered !== null) return recovered;
  }
  const prepared = await resolveCloseContext(options, env);
  const sessionBinding = dryRun ? { env, supervisor: null, attachment: null } : await ensureCloseSession(prepared, env, options.coordinationSessionId);
  env = sessionBinding.env;
  const currentHead = existsSync(prepared.active.main_worktree_path) ? gitHead(prepared.active.main_worktree_path) : prepared.active.target_base_sha;
  const changedPaths = existsSync(prepared.active.main_worktree_path) && commitExists(prepared.active.main_worktree_path, prepared.active.target_base_sha)
    ? diffPaths(prepared.active.main_worktree_path, prepared.active.target_base_sha, currentHead)
    : [];
  if (dryRun) {
    const blockers = await abortReadinessBlockers(prepared.active, env);
    return buildCloseResult({
      outcome: 'dry-run',
      active: prepared.active,
      repoKey: prepared.repo.repoKey,
      targetBefore: gitHead(prepared.repo.repoRoot),
      targetAfter: null,
      workstreamBefore: currentHead,
      workstreamAfter: null,
      integrationCommitSha: null,
      changedPaths,
      releasedClaims: [],
      archivedRuntimePath: null,
      archiveRef: null,
      mergeId: null,
      blockers,
      closeResultPath: null,
      now,
    });
  }

  try {
    return await withAutopilotFileLock(
    closeMergeLockPath(prepared, env),
    `autopilot-abort:${prepared.active.autopilot_id}:${prepared.active.workstream_run}`,
    async () => {
      let active = await setActiveStatus(prepared.coordinationRoot, prepared.active, 'merging', now, null);
      const context: PreparedCloseContext = { ...prepared, active };
      const coordinatorAuthority = active.coordination_authority === 'coordinator-edit-leases-v1';
      if (coordinatorAuthority && env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] === undefined) fail('coordination-authority-unavailable', 'Coordinator-backed abort requires its durable coordinator session; refusing legacy fallback.');
      const d65 = coordinatorAuthority && await isD65CoordinatorRun(active, env);
      const attemptPath = await writeCloseAttempt(context, now, d65);
      let terminalIntent: CoordinationRunTerminalIntent | null = coordinatorAuthority ? await preparedRunTerminalIntent(active, env) : null;
      if (terminalIntent !== null && terminalIntent.outcome !== 'aborted') fail('terminal-intent-outcome-mismatch', 'prepared coordinator terminal intent is for close, not abort.', [terminalIntent.terminal_intent_id]);
      let coordinatorTerminalCommitted = false;
      try {
        const existingManifestPath = terminalCleanupManifestPath(active);
        if (d65 && existsSync(existingManifestPath)) {
          const manifest = await readTerminalCleanupManifest(active);
          if (manifest.outcome !== 'aborted') fail('terminal-intent-outcome-mismatch', 'existing D65 terminal cleanup manifest is not an abort intent.', [existingManifestPath]);
          const terminalSha = existsSync(active.main_worktree_path) ? gitHead(active.main_worktree_path) : manifest.terminal_sha;
          if (manifest.terminal_sha !== terminalSha || manifest.result.workstream_after !== terminalSha) fail('terminal-successor-context-mismatch', 'prepared D65 abort manifest no longer equals the preserved workstream authority.', [manifest.terminal_sha, terminalSha]);
          if (terminalIntent === null) terminalIntent = await (await ReservationCoordinationClient.fromEnvironment(env)).prepareRunTerminal('aborted');
          if (terminalIntent.outcome !== 'aborted') fail('terminal-intent-outcome-mismatch', 'prepared coordinator terminal intent is for close, not abort.', [terminalIntent.terminal_intent_id]);
          await publishAndAuthenticateD65PreparedTerminalSuccessor(env, manifest.prepared_at);
          await assertD65RecoveryBoundaryFromEnvironment('terminal-tail', TERMINAL_RECOVERY_BINDINGS, env);
          await writeAndRecordRunTerminalEvidence(active, 'aborted', terminalSha, env, new Date(manifest.prepared_at));
          coordinatorTerminalCommitted = true;
          active = await setActiveStatus(context.coordinationRoot, active, 'closed', new Date(manifest.prepared_at), manifest.prepared_at);
          const terminalResult = await completeTerminalCleanup({ context: { ...context, active }, manifest, env }, options.observeTerminalCleanupBoundary);
          await detachExistingTerminalSession(sessionBinding, active, 'abort-terminal-cleanup-finished');
          return terminalResult;
        }
        // Abort uses the same durable pre-validation launch fence as close.
        if (coordinatorAuthority && !d65 && terminalIntent === null) terminalIntent = await (await ReservationCoordinationClient.fromEnvironment(env)).prepareRunTerminal('aborted');
        if (coordinatorAuthority) await options.observeCloseRaceBoundary?.('after-durable-launch-fence-before-validation');
        await validateTerminalArchiveSources(context);
        const latestBlockers = await abortReadinessBlockers(active, env);
        if (latestBlockers.length > 0) {
          if (terminalIntent !== null) {
            await (await ReservationCoordinationClient.fromEnvironment(env)).cancelRunTerminal(terminalIntent, 'abort validation blocked');
            terminalIntent = null;
          }
          active = await setActiveStatus(context.coordinationRoot, active, 'blocked', now, null);
          const result = buildCloseResult({
            outcome: 'blocked',
            active,
            repoKey: context.repo.repoKey,
            targetBefore: gitHead(context.repo.repoRoot),
            targetAfter: null,
            workstreamBefore: currentHead,
            workstreamAfter: null,
            integrationCommitSha: null,
            changedPaths,
            releasedClaims: [],
            archivedRuntimePath: null,
            archiveRef: null,
            mergeId: null,
            blockers: latestBlockers,
            closeResultPath: null,
            now,
          });
          const resultPath = await writeCloseResult(active.runtime_root, result, now);
          return { ...result, close_result_path: resultPath };
        }
        const archiveRef = `autopilot/archive/${active.workstream_run}/aborted`;
        const workstreamHead = gitHead(active.main_worktree_path);
        if (d65 && terminalIntent === null) await assertD65OrdinaryBoundaryFromEnvironment('ordinary-state-advance', env);
        await assertPrivateTerminalArchiveAncestry(context, true);
        await options.observeCloseRaceBoundary?.('after-private-archive-staging-before-terminal-commit');
        await assertPrivateTerminalArchiveAncestry(context, true);
        const proposedClosedActive: ActiveAutopilotRow = { ...active, status: 'closed', active_epoch_started_at: now.toISOString() };
        const proposedClosedContext: PreparedCloseContext = { ...context, active: proposedClosedActive };
        const latestRetainedClaims = active.coordination_authority === 'legacy-path-claims-v1'
          ? (await readPathClaims(proposedClosedContext.coordinationRoot)).filter((claim) => claim.autopilot_id === active.autopilot_id && claim.workstream_run === active.workstream_run)
          : [];
        const manifest = await prepareTerminalCleanupManifest({
          context: proposedClosedContext, outcome: 'aborted', terminalSha: workstreamHead, archiveRef, now,
          result: buildCloseResult({
            outcome: 'aborted', active: proposedClosedActive, repoKey: context.repo.repoKey, targetBefore: gitHead(context.repo.repoRoot), targetAfter: null,
            workstreamBefore: workstreamHead, workstreamAfter: workstreamHead, integrationCommitSha: null, changedPaths,
            releasedClaims: latestRetainedClaims.map((claim) => `${claim.claim_type} ${claim.path}`),
            archivedRuntimePath: join(context.worktreeRoot, '_archive', active.workstream_run, 'runtime'), archiveRef, mergeId: null, blockers: [],
            closeResultPath: join(context.worktreeRoot, '_archive', active.workstream_run, '_abort-result.json'), now,
          }),
        });
        await observeTerminalBoundary(options, 'after-terminal-manifest');
        if (d65 && terminalIntent === null) terminalIntent = await (await ReservationCoordinationClient.fromEnvironment(env)).prepareRunTerminal('aborted');
        if (d65) {
          await publishAndAuthenticateD65PreparedTerminalSuccessor(env, now.toISOString());
          await assertD65RecoveryBoundaryFromEnvironment('terminal-tail', TERMINAL_RECOVERY_BINDINGS, env);
        }
        await writeAndRecordRunTerminalEvidence(active, 'aborted', workstreamHead, env, now);
        coordinatorTerminalCommitted = true;
        active = await setActiveStatus(context.coordinationRoot, active, 'closed', now, now.toISOString());
        const closedContext: PreparedCloseContext = { ...context, active };
        await observeTerminalBoundary(options, 'after-terminal-commit');
        const terminalResult = await completeTerminalCleanup({ context: closedContext, manifest, env }, options.observeTerminalCleanupBoundary);
        await detachExistingTerminalSession(sessionBinding, active, 'abort-terminal-cleanup-finished');
        return terminalResult;

      } catch (error) {
        if (coordinatorTerminalCommitted) fail('terminal-cleanup-recovery-required', `Coordinator abort is terminal; remaining archive/worktree cleanup must resume forward-only after attempt ${attemptPath}: ${errorMessage(error)}`, [active.workstream_run]);
        if (d65 && terminalIntent !== null) fail('terminal-successor-required', `D65 abort is durably prepared; publish/accept its prepared-terminal successor graph and governing heartbeat, then resume the same intent: ${errorMessage(error)}`, [terminalIntent.terminal_intent_id]);
        const recoveryFailures: string[] = [];
        if (terminalIntent !== null) {
          try { await (await ReservationCoordinationClient.fromEnvironment(env)).cancelRunTerminal(terminalIntent, 'abort failed before coordinator terminal commit'); }
          catch (recoveryError) { recoveryFailures.push(`terminal-intent cancellation failed: ${errorMessage(recoveryError)}`); }
        }
        try { await setActiveStatus(prepared.coordinationRoot, active, 'blocked', now, null); }
        catch (recoveryError) { recoveryFailures.push(`active-row recovery classification failed: ${errorMessage(recoveryError)}`); }
        if (recoveryFailures.length > 0) fail('abort-recovery-failed', `Autopilot abort failed (${errorMessage(error)}) and durable recovery also failed.`, recoveryFailures);
        if (error instanceof AutopilotCloseError) throw error;
        fail('abort-failed', `Autopilot abort failed after attempt ${attemptPath}: ${errorMessage(error)}`);
      }
    },
    );
  } finally {
    await detachTransientCloseSession(sessionBinding, 'abort-invocation-finished');
  }
}

export async function recoverAutopilotTerminalCleanup(options: AutopilotCloseOptions & { readonly expectedOutcome?: 'closed' | 'aborted' }): Promise<AutopilotCloseResult | null> {
  const baseEnv = options.env ?? process.env;
  const repo = resolveRepoIdentity(options.sourceCwd);
  const paths = coordinatorRuntimePaths(baseEnv);
  if (!coordinationCutoverCommitted(resolveAutopilotStateRoot(baseEnv), repo.repoKey) && !existsSync(paths.databasePath)) return null;
  const worktreeRoot = worktreeRootForRepo(repo.repoKey, baseEnv);
  const candidateRows = (await readCoordinatorActiveAutopilots(repo, worktreeRoot, baseEnv, true)).filter((row) => row.workstream === options.workstream && (options.workstreamRun === undefined || options.workstreamRun === null || row.workstream_run === options.workstreamRun));
  const terminalRowsByCoordinator: ActiveAutopilotRow[] = [];
  for (const row of candidateRows) {
    const candidateStatus = await new CoordinatorClient({ env: baseEnv }).query('status', repo.repoKey, row.workstream_run);
    const candidateRuns = arrayField(candidateStatus.payload['runs'], 'terminal cleanup candidate runs').map((value) => parseCoordinationRun(value));
    const candidateRun = candidateRuns[0];
    if (candidateRuns.length === 1 && candidateRun !== undefined && (candidateRun.status === 'closed' || candidateRun.status === 'aborted')) terminalRowsByCoordinator.push(row);
  }
  let terminalRows = terminalRowsByCoordinator;
  if (terminalRows.length === 0) return null;
  if ((options.workstreamRun === undefined || options.workstreamRun === null) && terminalRows.length > 0) {
    const pending: ActiveAutopilotRow[] = [];
    for (const row of terminalRows) {
      const candidateStatus = await new CoordinatorClient({ env: baseEnv }).query('status', repo.repoKey, row.workstream_run);
      const candidateMain = arrayField(candidateStatus.payload['worktrees'], 'terminal cleanup candidate worktrees').map((value) => parseCoordinationWorktree(value)).find((worktree) => worktree.owner.workstream_run === row.workstream_run && worktree.owner.unit_id === 'main' && worktree.kind === 'main');
      if (candidateMain?.state !== 'removed') pending.push(row);
      else {
        const completedManifest = await readTerminalCleanupManifest(row);
        await verifyCoordinatorBoundTerminalCleanup(candidateStatus.payload, row, completedManifest);
        await verifyTerminalResultProjection(completedManifest);
      }
    }
    terminalRows = pending;
  }
  if (terminalRows.length === 0) return null;
  if (terminalRows.length > 1) fail('ambiguous-terminal-cleanup', 'Multiple incomplete terminal runs match cleanup recovery; pass --run.', terminalRows.map((row) => row.workstream_run));
  const active = terminalRows[0];
  if (active === undefined) return null;
  const status = await new CoordinatorClient({ env: baseEnv }).query('status', repo.repoKey, active.workstream_run);
  const runs = arrayField(status.payload['runs'], 'terminal cleanup runs').map((value) => parseCoordinationRun(value));
  const run = runs[0];
  if (runs.length !== 1 || run === undefined || (run.status !== 'closed' && run.status !== 'aborted')) fail('invalid-terminal-cleanup-state', 'Terminal cleanup recovery lacks exactly one terminal durable run.', [active.workstream_run]);
  const intents = arrayField(status.payload['run_terminal_intents'], 'terminal cleanup intents').map((value) => parseCoordinationRunTerminalIntent(value)).filter((intent) => intent.state === 'committed');
  const intent = intents[0];
  if (intents.length !== 1 || intent === undefined || intent.outcome !== run.status) fail('invalid-terminal-cleanup-state', 'Terminal cleanup recovery lacks one matching committed terminal intent.', [active.workstream_run]);
  if (options.expectedOutcome !== undefined && intent.outcome !== options.expectedOutcome) fail('terminal-outcome-mismatch', `Terminal run outcome is ${intent.outcome}, not ${options.expectedOutcome}.`, [active.workstream_run]);
  const manifest = await readTerminalCleanupManifest(active);
  await verifyCoordinatorBoundTerminalCleanup(status.payload, active, manifest);
  if (manifest.outcome !== intent.outcome) fail('invalid-terminal-cleanup-state', 'Terminal cleanup manifest outcome disagrees with coordinator evidence.', [active.workstream_run]);
  const worktrees = arrayField(status.payload['worktrees'], 'terminal cleanup worktrees').map((value) => parseCoordinationWorktree(value));
  const main = worktrees.find((worktree) => worktree.owner.workstream_run === active.workstream_run && worktree.owner.unit_id === 'main' && worktree.kind === 'main');
  if (main?.state === 'removed') {
    await verifyTerminalResultProjection(manifest);
    await detachExistingTerminalSession({ env: baseEnv, supervisor: null, attachment: null }, active, 'terminal-cleanup-already-complete');
    return manifest.result;
  }
  let recoveryEnv = baseEnv;
  let transientRecovery: Awaited<ReturnType<DurableRunSupervisorClient['attachTerminalRecovery']>> | null = null;
  let transientSupervisor: DurableRunSupervisorClient | null = null;
  const contextPath = baseEnv[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  let currentContext = false;
  if (contextPath !== undefined && contextPath.trim().length > 0) {
    const context = await readCoordinatorSessionContext(contextPath);
    const lease = arrayField(status.payload['session_leases'], 'terminal cleanup sessions').map((value) => parseCoordinationSessionLease(value)).find((candidate) => candidate.session_lease_id === context.session_lease_id);
    currentContext = context.repo_id === active.repo_key && context.autopilot_id === active.autopilot_id && context.workstream_run === active.workstream_run &&
      context.pid === process.pid && context.boot_id === currentBootId() && lease?.status === 'attached' && lease.session_generation === run.active_session_generation;
  }
  if (!currentContext) {
    if (options.coordinationSessionId === undefined || options.coordinationSessionId.trim().length === 0) fail('terminal-recovery-session-required', 'Terminal cleanup requires a fenced recovery attachment after process death.', [active.workstream_run]);
    transientSupervisor = new DurableRunSupervisorClient(baseEnv);
    transientRecovery = await transientSupervisor.attachTerminalRecovery({ repo, active, rawSessionId: options.coordinationSessionId });
    recoveryEnv = { ...baseEnv, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: transientRecovery.contextPath };
  }
  try {
    return await completeTerminalCleanup({ context: { repo, coordinationRoot: coordinationRootForRepo(repo.repoKey, baseEnv), worktreeRoot, active }, manifest, env: recoveryEnv }, options.observeTerminalCleanupBoundary);
  } finally {
    if (transientRecovery !== null && transientSupervisor !== null) {
      await transientSupervisor.client.mutate('detach-session', {
        repoId: transientRecovery.session.repo_id, workstreamRun: transientRecovery.session.workstream_run, sessionId: transientRecovery.session.session_id,
        fencingGeneration: transientRecovery.session.session_generation, expectedVersion: transientRecovery.session.version,
        idempotencyKey: `detach-terminal-recovery:${transientRecovery.session.session_lease_id}`,
      }, { reason: 'terminal-cleanup-recovery-finished', session_lease_id: transientRecovery.session.session_lease_id, session_token: transientRecovery.context.session_token });
    }
  }
}

async function ensureCloseSession(context: PreparedCloseContext, env: ProcessEnvLike, rawSessionId: string | undefined): Promise<CloseSessionBinding> {
  if (context.active.coordination_authority !== 'coordinator-edit-leases-v1') return { env, supervisor: null, attachment: null };
  const existingPath = env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (existingPath !== undefined && existingPath.trim().length > 0) {
    const existing = await readCoordinatorSessionContext(existingPath);
    if (existing.repo_id === context.active.repo_key && existing.autopilot_id === context.active.autopilot_id && existing.workstream_run === context.active.workstream_run && existing.pid === process.pid && existing.boot_id === currentBootId()) return { env, supervisor: null, attachment: null };
  }
  if (rawSessionId === undefined || rawSessionId.trim().length === 0) fail('coordination-authority-unavailable', 'Coordinator-backed close/abort requires a durable session attachment; refusing legacy fallback.');
  const supervisor = new DurableRunSupervisorClient(env);
  const attachment = await supervisor.attach({ repo: context.repo, active: context.active, rawSessionId });
  return { env: { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: attachment.contextPath }, supervisor, attachment };
}

async function detachExistingTerminalSession(binding: CloseSessionBinding, active: ActiveAutopilotRow, reason: string): Promise<void> {
  if (active.coordination_authority !== 'coordinator-edit-leases-v1' || binding.attachment !== null) return;
  const contextPath = binding.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  if (contextPath === undefined || contextPath.trim().length === 0) return;
  const context = await readCoordinatorSessionContext(contextPath);
  if (context.repo_id !== active.repo_key || context.autopilot_id !== active.autopilot_id || context.workstream_run !== active.workstream_run) return;
  await new CoordinatorClient({ env: binding.env }).mutate('detach-session', {
    repoId: context.repo_id, workstreamRun: context.workstream_run, sessionId: context.session_id,
    fencingGeneration: context.session_generation, expectedVersion: context.session_version,
    idempotencyKey: `detach-terminal-session:${context.session_lease_id}`,
  }, { reason, session_lease_id: context.session_lease_id, session_token: context.session_token });
}

async function detachTransientCloseSession(binding: CloseSessionBinding, reason: string): Promise<void> {
  if (binding.supervisor === null || binding.attachment === null) return;
  await binding.supervisor.client.mutate('detach-session', {
    repoId: binding.attachment.session.repo_id, workstreamRun: binding.attachment.session.workstream_run, sessionId: binding.attachment.session.session_id,
    fencingGeneration: binding.attachment.session.session_generation, expectedVersion: binding.attachment.session.version,
    idempotencyKey: `detach-close-session:${binding.attachment.session.session_lease_id}`,
  }, { reason, session_lease_id: binding.attachment.session.session_lease_id, session_token: binding.attachment.context.session_token });
}

async function prepareTerminalCleanupManifest(input: { readonly context: PreparedCloseContext; readonly outcome: 'closed' | 'aborted'; readonly terminalSha: string; readonly archiveRef: string; readonly result: AutopilotCloseResult; readonly now: Date }): Promise<TerminalCleanupManifest> {
  const manifest: TerminalCleanupManifest = {
    schema_version: 'autopilot.terminal_cleanup.v1', repo_key: input.context.active.repo_key, autopilot_id: input.context.active.autopilot_id,
    workstream: input.context.active.workstream, workstream_run: input.context.active.workstream_run, outcome: input.outcome,
    terminal_sha: input.terminalSha, archive_ref: input.archiveRef, archive_runtime_path: input.result.archived_runtime_path ?? '',
    result_path: input.result.close_result_path ?? '', result: input.result, prepared_at: input.now.toISOString(),
  };
  if (manifest.archive_runtime_path.length === 0 || manifest.result_path.length === 0) fail('invalid-terminal-cleanup-state', 'Terminal cleanup manifest requires deterministic archive/result paths.');
  const path = terminalCleanupManifestPath(input.context.active);
  if (existsSync(path)) {
    const existing = parseTerminalCleanupManifest(JSON.parse(await readFile(path, 'utf8')) as unknown, input.context.active);
    if (existing.outcome !== manifest.outcome || existing.terminal_sha !== manifest.terminal_sha || existing.archive_ref !== manifest.archive_ref || existing.archive_runtime_path !== manifest.archive_runtime_path || existing.result_path !== manifest.result_path) fail('terminal-cleanup-intent-conflict', 'Existing terminal cleanup intent differs from the requested immutable recovery work.', [path]);
    if (!commitExists(input.context.active.source_repo, existing.terminal_sha)) fail('terminal-cleanup-git-drift', 'Existing terminal cleanup intent references a Git object that is no longer available.', [existing.terminal_sha]);
    return existing;
  }
  await writeJsonAtomic(path, manifest);
  return manifest;
}

async function completeTerminalCleanup(recovery: TerminalCleanupRecovery, observer?: (boundary: AutopilotTerminalCleanupBoundary) => Promise<void> | void): Promise<AutopilotCloseResult> {
  const { context, manifest, env } = recovery;
  await assertD65TerminalCleanupBoundary(context.active, env);
  await updateTaskInfoStatus(context.active, 'closed');
  await assertD65TerminalCleanupBoundary(context.active, env);
  await updateTaskInfoClosedAt(context.active, manifest.prepared_at);
  await assertD65TerminalCleanupBoundary(context.active, env);
  await updateBranchesInfo(context.active, manifest.archive_ref, manifest.terminal_sha);
  await observer?.('after-terminal-projections');
  await assertD65TerminalCleanupBoundary(context.active, env);
  const archivedRuntimePath = await archiveRuntimeArtifacts(context, manifest.archive_ref, new Date(manifest.prepared_at));
  if (archivedRuntimePath !== manifest.archive_runtime_path) fail('terminal-cleanup-path-mismatch', 'Runtime archive path disagrees with immutable terminal cleanup intent.', [archivedRuntimePath, manifest.archive_runtime_path]);
  await observer?.('after-runtime-archive');
  const retainedClaims = context.active.coordination_authority === 'legacy-path-claims-v1'
    ? (await readPathClaims(context.coordinationRoot)).filter((claim) => claim.autopilot_id === context.active.autopilot_id && claim.workstream_run === context.active.workstream_run)
    : [];
  await releaseRetainedClaims(context, retainedClaims, new Date(manifest.prepared_at));
  if (!coordinationCutoverCommitted(resolveAutopilotStateRoot(env), context.active.repo_key)) await archiveWorktreeIndex(context.active, new Date(manifest.prepared_at));
  await assertD65TerminalCleanupBoundary(context.active, env);
  await writeJsonAtomic(manifest.result_path, manifest.result);
  await observer?.('after-result-projection');
  await assertD65TerminalCleanupBoundary(context.active, env);
  await cleanupClosedAutopilotRun({
    active: context.active, archiveRef: manifest.archive_ref, archiveSha: manifest.terminal_sha,
    reason: manifest.outcome === 'closed' ? 'autopilot close terminal-cleanup recovery' : 'autopilot abort terminal-cleanup recovery',
    removeActiveTaskDir: true, env, now: new Date(manifest.prepared_at),
    ...(observer === undefined ? {} : { observeTerminalBoundary: observer }),
  });
  return manifest.result;
}

async function verifyTerminalResultProjection(manifest: TerminalCleanupManifest): Promise<void> {
  if (!existsSync(manifest.result_path)) fail('terminal-cleanup-projection-missing', 'Completed terminal cleanup is missing its final result projection.', [manifest.result_path]);
  const projected = parseTerminalCloseResult(JSON.parse(await readFile(manifest.result_path, 'utf8')) as unknown);
  if (canonicalDigest(projected) !== canonicalDigest(manifest.result)) fail('terminal-cleanup-projection-mismatch', 'Final terminal cleanup projection differs from its hash-bound cleanup intent.', [manifest.result_path]);
}

async function verifyCoordinatorBoundTerminalCleanup(payload: Readonly<Record<string, unknown>>, active: ActiveAutopilotRow, manifest: TerminalCleanupManifest): Promise<void> {
  const expectedSource = manifest.outcome === 'closed' ? 'run-close' : 'run-abort';
  const accepted = arrayField(payload['reconciliation_evidence'], 'terminal reconciliation evidence').map((value) => parseCoordinationReconciliationEvidence(value)).filter((entry) => entry.source === expectedSource && entry.workstream_run === active.workstream_run);
  const evidence = accepted[0]?.release_condition.evidence;
  if (accepted.length !== 1 || evidence === null || evidence === undefined) fail('terminal-cleanup-evidence-missing', 'Terminal cleanup manifest is not bound to exactly one accepted coordinator evidence record.', [active.workstream_run]);
  const activeEvidence = join(active.main_worktree_path, ...evidence.ref.split('/'));
  const runtimePrefix = `${AUTOPILOT_RUNTIME_ROOT_PREFIX}/${active.workstream}/`;
  if (!evidence.ref.startsWith(runtimePrefix)) fail('terminal-cleanup-evidence-mismatch', 'Accepted terminal evidence ref is outside the deterministic runtime root.', [evidence.ref, runtimePrefix]);
  const archiveEvidence = join(active.worktree_root, '_archive', active.workstream_run, 'runtime', ...evidence.ref.slice(runtimePrefix.length).split('/'));
  const evidencePath = existsSync(activeEvidence) ? activeEvidence : archiveEvidence;
  if (!existsSync(evidencePath)) fail('terminal-cleanup-evidence-missing', 'Accepted terminal evidence artifact is unavailable from active or archived run storage.', [activeEvidence, archiveEvidence]);
  const evidenceBytes = await readFile(evidencePath);
  const evidenceSha = `sha256:${createHash('sha256').update(evidenceBytes).digest('hex')}`;
  if (evidenceSha !== evidence.sha256) fail('terminal-cleanup-evidence-mismatch', 'Accepted terminal evidence bytes no longer match coordinator authority.', [evidencePath, evidence.sha256, evidenceSha]);
  const document = requireRecord(JSON.parse(await readFile(evidencePath, 'utf8')) as unknown, 'run terminal evidence');
  const expectedManifestRef = 'close/_terminal-cleanup.json';
  const manifestPath = existsSync(terminalCleanupManifestPath(active)) ? terminalCleanupManifestPath(active) : join(active.worktree_root, '_archive', active.workstream_run, 'runtime', ...expectedManifestRef.split('/'));
  const manifestBytes = await readFile(manifestPath);
  const manifestSha = `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`;
  if (document['schema_version'] !== 'autopilot.run_terminal.v1' || document['repo_key'] !== active.repo_key || document['autopilot_id'] !== active.autopilot_id || document['workstream_run'] !== active.workstream_run || document['outcome'] !== manifest.outcome || document['terminal_sha'] !== manifest.terminal_sha || document['cleanup_manifest_ref'] !== expectedManifestRef || document['cleanup_manifest_sha256'] !== manifestSha) fail('terminal-cleanup-evidence-mismatch', 'Terminal cleanup manifest is not hash-bound to accepted terminal evidence.', [active.workstream_run]);
}

async function readTerminalCleanupManifest(active: ActiveAutopilotRow): Promise<TerminalCleanupManifest> {
  const activePath = terminalCleanupManifestPath(active);
  const archivePath = join(active.worktree_root, '_archive', active.workstream_run, 'runtime', 'close', '_terminal-cleanup.json');
  const path = existsSync(activePath) ? activePath : archivePath;
  if (!existsSync(path)) fail('terminal-cleanup-intent-missing', 'Terminal coordinator evidence exists without its required cleanup intent.', [activePath, archivePath]);
  return parseTerminalCleanupManifest(JSON.parse(await readFile(path, 'utf8')) as unknown, active);
}

function terminalCleanupManifestPath(active: ActiveAutopilotRow): string {
  return join(active.runtime_root, 'close', '_terminal-cleanup.json');
}

function parseTerminalCleanupManifest(value: unknown, active: ActiveAutopilotRow): TerminalCleanupManifest {
  const row = requireRecord(value, 'terminal cleanup manifest');
  const fields = ['archive_ref', 'archive_runtime_path', 'autopilot_id', 'outcome', 'prepared_at', 'repo_key', 'result', 'result_path', 'schema_version', 'terminal_sha', 'workstream', 'workstream_run'];
  const unknown = Object.keys(row).filter((field) => !fields.includes(field));
  if (unknown.length > 0 || fields.some((field) => !(field in row))) fail('invalid-terminal-cleanup-state', 'Terminal cleanup manifest has an incompatible closed shape.', unknown);
  if (row['schema_version'] !== 'autopilot.terminal_cleanup.v1' || row['repo_key'] !== active.repo_key || row['autopilot_id'] !== active.autopilot_id || row['workstream'] !== active.workstream || row['workstream_run'] !== active.workstream_run) fail('terminal-cleanup-owner-mismatch', 'Terminal cleanup manifest does not belong to the exact durable run.', [active.workstream_run]);
  const outcome = row['outcome'];
  if (outcome !== 'closed' && outcome !== 'aborted') fail('invalid-terminal-cleanup-state', 'Terminal cleanup outcome is invalid.');
  const terminalSha = expectString(row, 'terminal_sha');
  const archiveRef = expectString(row, 'archive_ref');
  const archiveRuntimePath = expectString(row, 'archive_runtime_path');
  const resultPath = expectString(row, 'result_path');
  const preparedAt = expectString(row, 'prepared_at');
  if (Number.isNaN(Date.parse(preparedAt)) || normalizeSha(terminalSha) === null) fail('invalid-terminal-cleanup-state', 'Terminal cleanup timestamp or Git object id is invalid.');
  const expectedArchiveRuntime = join(active.worktree_root, '_archive', active.workstream_run, 'runtime');
  const expectedResult = join(active.worktree_root, '_archive', active.workstream_run, outcome === 'closed' ? '_close-result.json' : '_abort-result.json');
  if (archiveRuntimePath !== expectedArchiveRuntime || resultPath !== expectedResult || !archiveRef.startsWith(`autopilot/archive/${active.workstream_run}/`)) fail('terminal-cleanup-path-mismatch', 'Terminal cleanup paths/ref are not derived from exact run ownership.', [archiveRuntimePath, resultPath, archiveRef]);
  const closeResult = parseTerminalCloseResult(row['result']);
  if (closeResult.outcome !== outcome || closeResult.repo_key !== active.repo_key || closeResult.autopilot_id !== active.autopilot_id || closeResult.workstream !== active.workstream || closeResult.workstream_run !== active.workstream_run || closeResult.archive_ref !== archiveRef || closeResult.archived_runtime_path !== archiveRuntimePath || closeResult.close_result_path !== resultPath) fail('terminal-cleanup-owner-mismatch', 'Terminal cleanup result projection identity is invalid.', [active.workstream_run]);
  return { schema_version: 'autopilot.terminal_cleanup.v1', repo_key: active.repo_key, autopilot_id: active.autopilot_id, workstream: active.workstream, workstream_run: active.workstream_run, outcome, terminal_sha: terminalSha, archive_ref: archiveRef, archive_runtime_path: archiveRuntimePath, result_path: resultPath, result: closeResult, prepared_at: preparedAt };
}

function parseTerminalCloseResult(value: unknown): AutopilotCloseResult {
  const row = requireRecord(value, 'terminal cleanup close result');
  const fields = ['archive_ref', 'archived_runtime_path', 'autopilot_id', 'blockers', 'branch', 'changed_paths', 'close_result_path', 'created_at', 'integration_commit_sha', 'merge_id', 'outcome', 'released_claims', 'repo_key', 'schema_version', 'target_after', 'target_before', 'target_branch', 'workstream', 'workstream_after', 'workstream_before', 'workstream_run'];
  const unknown = Object.keys(row).filter((field) => !fields.includes(field));
  if (unknown.length > 0 || fields.some((field) => !(field in row))) fail('invalid-terminal-cleanup-state', 'Terminal cleanup close result has an incompatible closed shape.', unknown);
  if (row['schema_version'] !== 'autopilot.close_result.v1') fail('invalid-terminal-cleanup-state', 'Terminal cleanup close result schema is invalid.');
  const outcome = row['outcome'];
  if (outcome !== 'closed' && outcome !== 'aborted') fail('invalid-terminal-cleanup-state', 'Terminal cleanup close result must be terminal.');
  const createdAt = expectString(row, 'created_at');
  if (Number.isNaN(Date.parse(createdAt))) fail('invalid-terminal-cleanup-state', 'Terminal cleanup close result timestamp is invalid.');
  return Object.freeze({
    schema_version: 'autopilot.close_result.v1', outcome, workstream: expectString(row, 'workstream'), workstream_run: expectString(row, 'workstream_run'),
    autopilot_id: expectString(row, 'autopilot_id'), repo_key: expectString(row, 'repo_key'), branch: expectString(row, 'branch'), target_branch: expectNullableString(row, 'target_branch'),
    target_before: expectString(row, 'target_before'), target_after: expectNullableString(row, 'target_after'), workstream_before: expectString(row, 'workstream_before'),
    workstream_after: expectNullableString(row, 'workstream_after'), integration_commit_sha: expectNullableString(row, 'integration_commit_sha'), changed_paths: expectStringArray(row, 'changed_paths'),
    released_claims: expectStringArray(row, 'released_claims'), archived_runtime_path: expectNullableString(row, 'archived_runtime_path'), archive_ref: expectNullableString(row, 'archive_ref'),
    merge_id: expectNullableString(row, 'merge_id'), blockers: expectStringArray(row, 'blockers'), close_result_path: expectNullableString(row, 'close_result_path'), created_at: createdAt,
  });
}

async function observeTerminalBoundary(options: AutopilotCloseOptions, boundary: AutopilotTerminalCleanupBoundary): Promise<void> {
  await options.observeTerminalCleanupBoundary?.(boundary);
}

function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function arrayField(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) fail('invalid-coordinator-status', `${label} must be an array.`);
  return value;
}

async function resolveCloseContext(options: AutopilotCloseOptions, env: ProcessEnvLike): Promise<PreparedCloseContext> {
  const repo = resolveRepoIdentity(options.sourceCwd);
  const coordinationRoot = coordinationRootForRepo(repo.repoKey, env);
  const worktreeRoot = worktreeRootForRepo(repo.repoKey, env);
  assertCoordinationDispatchAllowed(resolveAutopilotStateRoot(env), repo.repoKey, 'Autopilot close/abort');
  const activeRows = coordinationCutoverCommitted(resolveAutopilotStateRoot(env), repo.repoKey)
    ? await readCoordinatorActiveAutopilots(repo, worktreeRoot, env)
    : await readActiveAutopilots(coordinationRoot);
  const matches = activeRows.filter((row) => {
    if (row.repo_key !== repo.repoKey || row.workstream !== options.workstream) return false;
    if (options.workstreamRun !== undefined && options.workstreamRun !== null && row.workstream_run !== options.workstreamRun) return false;
    return row.status !== 'closed' && row.status !== 'crashed';
  });
  if (matches.length === 0) {
    fail('active-run-not-found', 'No active Autopilot workstream run matched close request.', [
      `workstream=${options.workstream}`,
      `repo_key=${repo.repoKey}`,
      ...(options.workstreamRun === undefined || options.workstreamRun === null ? [] : [`workstream_run=${options.workstreamRun}`]),
    ]);
  }
  if (matches.length > 1) {
    fail('ambiguous-close-run', 'Multiple active Autopilot runs match; pass --run <workstream_run>.', matches.map((row) => row.workstream_run));
  }
  const active = matches[0];
  if (active === undefined) fail('internal-missing-active-row', 'matched active row disappeared.');
  if (active.status === 'merging' && await preparedRunTerminalIntent(active, env) === null) {
    fail('close-already-in-progress', 'Autopilot workstream is already marked merging without a recoverable coordinator terminal intent.', [active.workstream_run]);
  }
  return { repo, coordinationRoot, worktreeRoot, active };
}

async function validateCloseReadiness(context: PreparedCloseContext, now: Date, env: ProcessEnvLike, resumingPreparedTerminal = false): Promise<CloseValidationResult> {
  const blockers: string[] = [];
  const active = context.active;
  const targetBranch = active.target_branch;
  if (targetBranch === null) blockers.push('activation target branch was detached HEAD; local close requires a named target branch');
  if (context.repo.targetBranch !== targetBranch) {
    blockers.push(`source checkout must be on captured target branch ${String(targetBranch)}, got ${String(context.repo.targetBranch)}`);
  }
  if (targetBranch !== null) {
    const targetRefHead = revParse(context.repo.repoRoot, `refs/heads/${targetBranch}`);
    if (gitHead(context.repo.repoRoot) !== targetRefHead) blockers.push('source checkout HEAD must equal target branch HEAD');
  }
  if (normalizeSha(active.target_base_sha) === null) blockers.push('active row target_base_sha is not a valid commit SHA');

  const sourceDirty = sourceDirtyPaths(context.repo.repoRoot, active.workstream);
  if (sourceDirty.length > 0) blockers.push(`source checkout has dirty paths: ${sourceDirty.join(', ')}`);
  if (!existsSync(active.main_worktree_path)) blockers.push(`registered worktree is missing: ${active.main_worktree_path}`);
  const worktreeDirty = existsSync(active.main_worktree_path) ? sourceDirtyPaths(active.main_worktree_path, active.workstream) : [];
  if (worktreeDirty.length > 0) blockers.push(`Autopilot worktree has dirty source paths: ${worktreeDirty.join(', ')}`);
  if (existsSync(active.main_worktree_path)) {
    const branch = currentBranch(active.main_worktree_path);
    if (branch !== active.branch) blockers.push(`registered worktree must be on ${active.branch}, got ${String(branch)}`);
  }

  const coordinatorAuthority = active.coordination_authority === 'coordinator-edit-leases-v1';
  const cutoverCommitted = coordinationCutoverCommitted(resolveAutopilotStateRoot(env), active.repo_key);
  const claims = cutoverCommitted ? [] : await readPathClaims(context.coordinationRoot);
  const retainedClaims = claims.filter((claim) => claim.autopilot_id === active.autopilot_id && claim.workstream_run === active.workstream_run);
  const retainedWriteClaims = retainedClaims.filter((claim) => claim.claim_type === 'WRITE' || claim.claim_type === 'EXCLUSIVE');
  if (coordinatorAuthority && retainedClaims.length > 0) blockers.push(`coordinator-backed run has forbidden legacy path-claim authority: ${retainedClaims.map((claim) => `${claim.claim_type}:${claim.path}`).join(', ')}`);
  const targetHead = targetBranch === null ? gitHead(context.repo.repoRoot) : revParse(context.repo.repoRoot, `refs/heads/${targetBranch}`);
  const workstreamHead = existsSync(active.main_worktree_path) ? gitHead(active.main_worktree_path) : active.target_base_sha;
  const rawPreIntegrationChangedPaths = commitExists(active.main_worktree_path, active.target_base_sha)
    ? diffPaths(active.main_worktree_path, active.target_base_sha, workstreamHead)
    : [];
  const targetDeltaPaths = commitExists(context.repo.repoRoot, active.target_base_sha)
    ? diffPaths(context.repo.repoRoot, active.target_base_sha, targetHead)
    : [];

  const artifacts = await readRuntimeArtifacts(active.runtime_root);
  const executionCommits = artifacts.executionCommits.filter((commit) =>
    commit.autopilot_id === active.autopilot_id && commit.workstream_run === active.workstream_run,
  );
  const unitMerges = relevantUnitMerges(active, artifacts.unitMerges);
  // A D65 run's main branch necessarily contains graph/policy/runtime authority
  // commits. Their exact paths and commit chain are already authenticated by
  // complete-graph registration and are not product edits requiring fabricated
  // unit claims/execution commits. Product close authority is the complete set
  // of accepted unit-merge changed paths; any unpaired Git movement has already
  // been rejected by the graph publisher/store before terminal preparation.
  const d65 = coordinatorAuthority && await isD65CoordinatorRun(active, env);
  const preIntegrationChangedPaths = d65
    ? sortedUnique(unitMerges.flatMap((merge) => [...merge.changed_paths]))
    : rawPreIntegrationChangedPaths;
  const closeSurfacePaths = unitMerges.length > 0
    ? sortedUnique(unitMerges.flatMap((merge) => [...merge.changed_paths]))
    : retainedWriteClaims.map((claim) => claim.path);
  if (coordinatorAuthority && preIntegrationChangedPaths.length > 0 && unitMerges.length === 0) blockers.push('coordinator-backed close refuses direct-main source changes without accepted unit-merge reservations');
  blockers.push(...semanticClosureBlockers(artifacts, preIntegrationChangedPaths));
  if (unitMerges.length > 0) {
    blockers.push(...phaseTwoExecutionCommitBlockers(active, executionCommits, artifacts.audits, unitMerges));
  } else {
    blockers.push(...executionCommitBlockers(active, executionCommits, artifacts.audits, retainedWriteClaims, preIntegrationChangedPaths));
  }
  blockers.push(...phaseTwoCloseBlockers(active, unitMerges, artifacts.validationStalenessRefs, preIntegrationChangedPaths));
  blockers.push(...await unitWorktreeResidueBlockers(active));
  if (!d65) blockers.push(...branchCommitBlockers(active, executionCommits, unitMerges));
  blockers.push(...await incompleteSagaBlockers(active, env));
  blockers.push(...await reservationCloseBlockers(active, env));
  const reservationIntegrations = await resolvedReservationIntegrations(active, env);
  const resolvedTargetPath = (path: string): boolean => {
    const latest = latestCommitForPath(context.repo.repoRoot, active.target_base_sha, targetHead, path);
    return latest !== null && reservationIntegrations.some((integration) => integration.predecessorTerminalSha === latest && pathMatchesAnyClaim(path, integration.paths));
  };

  const targetAlreadyEqualsWorkstream = targetHead === workstreamHead;
  const targetIntersection = (resumingPreparedTerminal && targetAlreadyEqualsWorkstream ? [] : intersectingPaths(targetDeltaPaths, closeSurfacePaths)).filter((path) => !resolvedTargetPath(path));
  if (targetIntersection.length > 0) {
    blockers.push(`target branch changed retained claimed path(s) since activation: ${targetIntersection.join(', ')}; targeted revalidation required before close`);
  }

  const mergeLog = cutoverCommitted ? [] : await readMergeLog(context.coordinationRoot);
  const ackedIds = cutoverCommitted ? new Set<string>() : await readAckedMergeIds(context.coordinationRoot, active);
  const unackedForeignMerges = mergeLog.filter((row) =>
    row.repo_key === active.repo_key &&
    row.autopilot_id !== active.autopilot_id &&
    !ackedIds.has(row.merge_id),
  );
  const nonIntersectingForeignMerges: AutopilotMergeEvent[] = [];
  for (const merge of unackedForeignMerges) {
    const intersection = intersectingPaths(merge.changed_paths, closeSurfacePaths).filter((path) => !reservationIntegrations.some((integration) => integration.predecessorTerminalSha === merge.target_after && pathMatchesAnyClaim(path, integration.paths)));
    if (intersection.length > 0) {
      blockers.push(`foreign merge ${merge.merge_id} touched retained claimed path(s): ${intersection.join(', ')}; targeted revalidation required before close`);
    } else {
      nonIntersectingForeignMerges.push(merge);
    }
  }

  if (unitMerges.length === 0) blockers.push(...finalDiffBlockers(preIntegrationChangedPaths, retainedWriteClaims, executionCommits));
  if (blockers.length === 0 && targetBranch !== null && !isAncestor(context.repo.repoRoot, targetHead, workstreamHead)) {
    // This is allowed: the runtime will merge target into the clean workstream.
    // The explicit branch keeps this invariant visible and prevents accidental silent fallback.
  }

  void now;
  return {
    retainedClaims,
    retainedWriteClaims,
    executionCommits,
    unitMerges,
    preIntegrationChangedPaths,
    targetDeltaPaths,
    unackedForeignMerges,
    nonIntersectingForeignMerges,
    blockers: sortedUnique(blockers),
  };
}

function sourceDirtyPaths(cwd: string, workstream: string): readonly string[] {
  return readGitStatus(cwd).changedPaths.filter((path) => !isAutopilotRuntimeRepoPath(path, workstream));
}

async function abortReadinessBlockers(active: ActiveAutopilotRow, env: ProcessEnvLike): Promise<readonly string[]> {
  const blockers: string[] = [];
  if (active.coordination_authority === 'coordinator-edit-leases-v1' && !coordinationCutoverCommitted(resolveAutopilotStateRoot(env), active.repo_key)) {
    const forbiddenLegacyClaims = (await readPathClaims(coordinationRootForRepo(active.repo_key, env))).filter((claim) => claim.autopilot_id === active.autopilot_id && claim.workstream_run === active.workstream_run);
    if (forbiddenLegacyClaims.length > 0) blockers.push(`coordinator-backed abort found forbidden legacy path claims: ${forbiddenLegacyClaims.map((claim) => `${claim.claim_type}:${claim.path}`).join(', ')}`);
  }
  if (!existsSync(active.main_worktree_path)) blockers.push(`registered worktree is missing: ${active.main_worktree_path}`);
  if (existsSync(active.main_worktree_path)) {
    const dirty = sourceDirtyPaths(active.main_worktree_path, active.workstream);
    if (dirty.length > 0) blockers.push(`abort refused dirty source paths in worktree: ${dirty.join(', ')}`);
    const branch = currentBranch(active.main_worktree_path);
    if (branch !== active.branch) blockers.push(`registered worktree must be on ${active.branch}, got ${String(branch)}`);
  }
  blockers.push(...unitWorktreeResidueBlockersSync(active));
  blockers.push(...await incompleteSagaBlockers(active, env));
  return sortedUnique(blockers);
}

async function incompleteSagaBlockers(active: ActiveAutopilotRow, env: ProcessEnvLike): Promise<readonly string[]> {
  if (env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] === undefined) return [];
  const client = await OwnedWorktreeSagaClient.fromEnvironment(env);
  if (client.session.repo_id !== active.repo_key || client.session.autopilot_id !== active.autopilot_id || client.session.workstream_run !== active.workstream_run) return [`attached saga supervisor does not own closing run ${active.workstream_run}`];
  return (await client.operations())
    .filter((operation) => operation.stage !== 'committed' && operation.stage !== 'compensated' && operation.stage !== 'failed')
    .map((operation) => `owner-scoped ${operation.operation_type} saga is incomplete: ${operation.operation_id} (${operation.stage})`);
}

async function unitWorktreeResidueBlockers(active: ActiveAutopilotRow): Promise<readonly string[]> {
  const taskRoot = taskRootForActiveAutopilot(active);
  const indexPath = join(taskRoot, UNIT_INDEX_FILE);
  if (!existsSync(indexPath)) return [];
  const index = await readUnitIndex(taskRoot);
  const blockers: string[] = [];
  for (const unit of index.units) {
    if (unit.status === 'active') blockers.push(`unit worktree still active: ${unit.unit_id} attempt ${String(unit.attempt)}`);
    if (unit.status === 'quarantined') blockers.push(`unit worktree is quarantined and requires owned autonomous recovery: ${unit.unit_id} attempt ${String(unit.attempt)}`);
    if (existsSync(unit.worktree_path) && readGitStatus(unit.worktree_path).changedPaths.length > 0) blockers.push(`unit worktree has dirty residue: ${unit.unit_id} attempt ${String(unit.attempt)}`);
  }
  return sortedUnique(blockers);
}

function unitWorktreeResidueBlockersSync(active: ActiveAutopilotRow): readonly string[] {
  const taskRoot = taskRootForActiveAutopilot(active);
  const indexPath = join(taskRoot, UNIT_INDEX_FILE);
  if (!existsSync(indexPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [`invalid unit index: ${indexPath}`];
    const units = (parsed as Readonly<Record<string, unknown>>)['units'];
    if (!Array.isArray(units)) return [`invalid unit index units: ${indexPath}`];
    const blockers: string[] = [];
    for (const unit of units) {
      if (typeof unit !== 'object' || unit === null || Array.isArray(unit)) continue;
      const row = unit as Readonly<Record<string, unknown>>;
      const status = row['status'];
      const unitId = typeof row['unit_id'] === 'string' ? row['unit_id'] : 'unknown';
      const attempt = typeof row['attempt'] === 'number' ? String(row['attempt']) : 'unknown';
      const worktreePath = typeof row['worktree_path'] === 'string' ? row['worktree_path'] : null;
      if (status === 'active') blockers.push(`unit worktree still active: ${unitId} attempt ${attempt}`);
      if (status === 'quarantined') blockers.push(`unit worktree is quarantined and requires owned autonomous recovery: ${unitId} attempt ${attempt}`);
      if (worktreePath !== null && existsSync(worktreePath) && readGitStatus(worktreePath).changedPaths.length > 0) blockers.push(`unit worktree has dirty residue: ${unitId} attempt ${attempt}`);
    }
    return sortedUnique(blockers);
  } catch (error) {
    return [`failed to inspect unit worktree residue: ${errorMessage(error)}`];
  }
}

function semanticClosureBlockers(artifacts: RuntimeArtifacts, changedPaths: readonly string[]): readonly string[] {
  if (changedPaths.length === 0 && artifacts.executionCommits.length === 0) return [];
  const blockers: string[] = [];
  if (artifacts.state === null) blockers.push('source-changing close requires schema-valid state.json');
  if (artifacts.masterPlan === null) blockers.push('source-changing close requires schema-valid master-plan.json');
  if (artifacts.state !== null && artifacts.state.running.length > 0) {
    blockers.push(`state.json still has running unit(s): ${artifacts.state.running.join(', ')}`);
  }
  if (artifacts.state !== null && artifacts.masterPlan !== null) {
    const gate = evaluateAutopilotClosureGate({
      state: artifacts.state,
      masterPlan: artifacts.masterPlan,
      statuses: artifacts.statuses,
      audits: artifacts.audits,
      decisions: artifacts.decisions,
    });
    if (gate.status !== 'passed') blockers.push(...gate.blocking_reasons.map((reason) => `closure gate: ${reason}`));
  }
  return blockers;
}

function relevantUnitMerges(active: ActiveAutopilotRow, unitMerges: readonly AutopilotUnitMerge[]): readonly AutopilotUnitMerge[] {
  return Object.freeze(unitMerges.filter((merge) => merge.autopilot_id === active.autopilot_id && merge.workstream_run === active.workstream_run));
}

function executionCommitBlockers(
  active: ActiveAutopilotRow,
  executionCommits: readonly AutopilotExecutionCommit[],
  audits: readonly AutopilotExecutionAudit[],
  retainedWriteClaims: readonly AutopilotPathClaim[],
  finalChangedPaths: readonly string[],
): readonly string[] {
  const blockers: string[] = [];
  const writeClaimPaths = retainedWriteClaims.map((claim) => claim.path);
  if (finalChangedPaths.length > 0 && retainedWriteClaims.length === 0) {
    blockers.push('source-changing close requires retained WRITE/EXCLUSIVE path claims');
  }
  for (const commit of executionCommits) {
    if (commit.branch !== active.branch) blockers.push(`execution commit ${commit.commit_sha} branch does not match active branch`);
    for (const sha of commit.commit_shas ?? [commit.commit_sha]) {
      if (!isAncestor(active.main_worktree_path, sha, gitHead(active.main_worktree_path))) {
        blockers.push(`execution commit ${sha} is not reachable from workstream branch`);
      }
    }
    const matchingAudit = audits.find((audit) =>
      audit.workstream === commit.workstream &&
      audit.unit_id === commit.unit_id &&
      audit.role === commit.role &&
      audit.attempt === commit.attempt,
    );
    if (matchingAudit === undefined) blockers.push(`execution commit ${commit.commit_sha} lacks matching execution audit`);
    else if (matchingAudit.classification !== 'clean') blockers.push(`execution commit ${commit.commit_sha} audit is ${matchingAudit.classification}, not clean`);
    for (const path of commit.edited_claimed_paths) {
      if (!pathMatchesAnyClaim(path, writeClaimPaths)) {
        blockers.push(`execution commit ${commit.commit_sha} edited path outside retained claims: ${path}`);
      }
    }
  }
  const executionEditedPaths = sortedUnique(executionCommits.flatMap((commit) => [...commit.edited_claimed_paths]));
  for (const path of finalChangedPaths) {
    if (!pathMatchesAnyClaim(path, writeClaimPaths)) blockers.push(`final changed path is outside retained claims: ${path}`);
    if (!pathMatchesAnyClaim(path, executionEditedPaths)) blockers.push(`final changed path lacks execution commit evidence: ${path}`);
  }
  return blockers;
}

function phaseTwoExecutionCommitBlockers(
  active: ActiveAutopilotRow,
  executionCommits: readonly AutopilotExecutionCommit[],
  audits: readonly AutopilotExecutionAudit[],
  unitMerges: readonly AutopilotUnitMerge[],
): readonly string[] {
  const blockers: string[] = [];
  for (const merge of unitMerges) {
    const matchingCommit = executionCommits.find((commit) =>
      commit.unit_id === merge.unit_id && commit.attempt === merge.attempt && commit.role === merge.role,
    );
    if (matchingCommit === undefined) {
      blockers.push(`Phase 2 close: unit merge ${merge.unit_id} attempt ${String(merge.attempt)} lacks execution commit evidence`);
      continue;
    }
    if (matchingCommit.branch !== merge.unit_branch) {
      blockers.push(`Phase 2 close: execution commit ${matchingCommit.commit_sha} branch does not match unit branch ${merge.unit_branch}`);
    }
    if (matchingCommit.after_head !== merge.unit_head) {
      blockers.push(`Phase 2 close: execution commit ${matchingCommit.commit_sha} head does not match merged unit head ${merge.unit_head}`);
    }
    const matchingAudit = audits.find((audit) =>
      audit.workstream === matchingCommit.workstream &&
      audit.unit_id === matchingCommit.unit_id &&
      audit.role === matchingCommit.role &&
      audit.attempt === matchingCommit.attempt,
    );
    if (matchingAudit === undefined) blockers.push(`Phase 2 close: execution commit ${matchingCommit.commit_sha} lacks matching execution audit`);
    else if (matchingAudit.classification !== 'clean') blockers.push(`Phase 2 close: execution commit ${matchingCommit.commit_sha} audit is ${matchingAudit.classification}, not clean`);
    for (const path of merge.changed_paths) {
      if (!pathMatchesAnyClaim(path, matchingCommit.edited_claimed_paths)) {
        blockers.push(`Phase 2 close: unit merge ${merge.unit_id} path lacks execution commit evidence: ${path}`);
      }
    }
    for (const path of matchingCommit.edited_claimed_paths) {
      if (!pathMatchesAnyClaim(path, merge.changed_paths)) {
        blockers.push(`Phase 2 close: execution commit ${matchingCommit.commit_sha} path missing from unit merge evidence: ${path}`);
      }
    }
    if (!isAncestor(active.main_worktree_path, matchingCommit.commit_sha, gitHead(active.main_worktree_path))) {
      blockers.push(`Phase 2 close: execution commit ${matchingCommit.commit_sha} is not reachable from integration branch`);
    }
  }
  return sortedUnique(blockers);
}

function phaseTwoCloseBlockers(
  active: ActiveAutopilotRow,
  unitMerges: readonly AutopilotUnitMerge[],
  validationStalenessRefs: readonly string[],
  finalChangedPaths: readonly string[],
): readonly string[] {
  const blockers: string[] = [];
  if (unitMerges.length === 0 && validationStalenessRefs.length === 0) return blockers;
  const relevantMerges = relevantUnitMerges(active, unitMerges);
  const unionPaths = sortedUnique(relevantMerges.flatMap((merge) => [...merge.changed_paths]));
  for (const path of finalChangedPaths) {
    if (!pathMatchesAnyClaim(path, unionPaths)) blockers.push(`Phase 2 close: final path lacks accepted unit-merge evidence: ${path}`);
  }
  for (const path of unionPaths) {
    if (!pathMatchesAnyClaim(path, finalChangedPaths)) blockers.push(`Phase 2 close: accepted unit merge path missing from final integrated diff: ${path}`);
  }
  for (const merge of relevantMerges) {
    if (!isAncestor(active.main_worktree_path, merge.merge_commit_sha, gitHead(active.main_worktree_path))) {
      blockers.push(`Phase 2 close: unit merge ${merge.unit_id} attempt ${String(merge.attempt)} is not reachable from integration branch`);
    }
  }
  if (validationStalenessRefs.length > 0) blockers.push(`Phase 2 close: stale validation artifacts remain: ${validationStalenessRefs.join(', ')}`);
  return sortedUnique(blockers);
}

function branchCommitBlockers(active: ActiveAutopilotRow, executionCommits: readonly AutopilotExecutionCommit[], unitMerges: readonly AutopilotUnitMerge[]): readonly string[] {
  if (!commitExists(active.main_worktree_path, active.target_base_sha)) return [`target_base_sha ${active.target_base_sha} is not reachable in workstream repo`];
  const commits = revList(active.main_worktree_path, active.target_base_sha, gitHead(active.main_worktree_path));
  const executionShas = new Set([
    ...executionCommits.flatMap((commit) => [...(commit.commit_shas ?? [commit.commit_sha])]),
    ...unitMerges.flatMap((merge) => [merge.unit_head, merge.merge_commit_sha]),
  ]);
  const unknownCommits = commits.filter((sha) => !executionShas.has(sha));
  if (unknownCommits.length === 0) return [];
  return unknownCommits.map((sha) => `workstream branch contains non-runtime execution commit ${sha}`);
}

function finalDiffBlockers(
  changedPaths: readonly string[],
  retainedWriteClaims: readonly AutopilotPathClaim[],
  executionCommits: readonly AutopilotExecutionCommit[],
): readonly string[] {
  const blockers: string[] = [];
  const claimPaths = retainedWriteClaims.map((claim) => claim.path);
  const executionPaths = sortedUnique(executionCommits.flatMap((commit) => [...commit.edited_claimed_paths]));
  for (const path of changedPaths) {
    if (!pathMatchesAnyClaim(path, claimPaths)) blockers.push(`post-integration changed path is outside retained claims: ${path}`);
    if (!pathMatchesAnyClaim(path, executionPaths)) blockers.push(`post-integration changed path lacks execution commit evidence: ${path}`);
  }
  return blockers;
}

async function readRuntimeArtifacts(runtimeRoot: string): Promise<RuntimeArtifacts> {
  return {
    state: await readOptionalJson(runtimeRoot, 'state.json', parseAutopilotState),
    masterPlan: await readOptionalJson(runtimeRoot, 'master-plan.json', parseAutopilotMasterPlan),
    statuses: await readJsonObjectsFromDir(join(runtimeRoot, 'statuses'), parseAutopilotStatusEntry),
    audits: await readJsonObjectsFromDir(join(runtimeRoot, 'execution-audits'), parseAutopilotExecutionAudit),
    decisions: await readDecisionRows(join(runtimeRoot, 'decision-log.jsonl')),
    executionCommits: await readJsonObjectsFromDir(join(runtimeRoot, 'execution-commits'), parseAutopilotExecutionCommit),
    unitMerges: await readJsonObjectsFromDir(join(runtimeRoot, 'unit-merges'), parseAutopilotUnitMerge),
    validationStalenessRefs: await listRuntimeJsonRefs(join(runtimeRoot, 'validation-staleness'), runtimeRoot),
  };
}

async function readOptionalJson<T>(root: string, file: string, parse: (value: unknown) => T): Promise<T | null> {
  const path = join(root, file);
  if (!existsSync(path)) return null;
  try {
    return parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    fail('invalid-runtime-artifact', `${file} is present but invalid: ${errorMessage(error)}`, [path]);
  }
}

async function readJsonObjectsFromDir<T>(dir: string, parse: (value: unknown) => T): Promise<readonly T[]> {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const path of await listFilesRecursive(dir)) {
    if (!path.endsWith('.json')) continue;
    try {
      out.push(parse(JSON.parse(await readFile(path, 'utf8')) as unknown));
    } catch (error) {
      fail('invalid-runtime-artifact', `runtime JSON artifact is invalid: ${errorMessage(error)}`, [path]);
    }
  }
  return Object.freeze(out);
}

async function readDecisionRows(path: string): Promise<readonly AutopilotDecisionRow[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  const rows: AutopilotDecisionRow[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(parseAutopilotDecisionRow(JSON.parse(line) as unknown));
    } catch (error) {
      fail('invalid-runtime-artifact', `decision-log.jsonl line ${String(index + 1)} is invalid: ${errorMessage(error)}`, [path]);
    }
  }
  return Object.freeze(rows);
}

async function listRuntimeJsonRefs(root: string, runtimeRoot: string): Promise<readonly string[]> {
  if (!existsSync(root)) return [];
  const files = await listFilesRecursive(root);
  const prefix = runtimeRoot.endsWith('/') ? runtimeRoot : `${runtimeRoot}/`;
  return Object.freeze(files.filter((file) => file.endsWith('.json')).map((file) => file.startsWith(prefix) ? file.slice(prefix.length) : file).sort((left, right) => left.localeCompare(right)));
}

async function listFilesRecursive(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...await listFilesRecursive(path));
    else out.push(path);
  }
  return Object.freeze(out.sort((left, right) => left.localeCompare(right)));
}

function pathContained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function assertNoSymbolicTree(source: string, physicalRoot: string, label: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) fail('unsafe-terminal-archive-source', `${label} contains a symbolic link or junction.`, [source]);
  const physical = await realpath(source);
  if (!pathContained(physicalRoot, physical)) fail('unsafe-terminal-archive-source', `${label} physically escapes its authority root.`, [source, physical, physicalRoot]);
  if (info.isDirectory()) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail('unsafe-terminal-archive-source', `${label} contains a symbolic link or loop.`, [join(source, entry.name)]);
      await assertNoSymbolicTree(join(source, entry.name), physicalRoot, label);
    }
  } else if (!info.isFile()) fail('unsafe-terminal-archive-source', `${label} contains a non-regular archive object.`, [source]);
}

function terminalArchiveStagingPath(context: PreparedCloseContext): string {
  return join(context.worktreeRoot, '_archive', `.staging-${context.active.workstream_run}`);
}

async function assertPrivateTerminalArchiveAncestry(context: PreparedCloseContext, createStage: boolean): Promise<void> {
  const archiveParent = join(context.worktreeRoot, '_archive');
  const archiveRoot = join(archiveParent, context.active.workstream_run);
  const stage = terminalArchiveStagingPath(context);
  const worktreeInfo = await lstat(context.worktreeRoot);
  if (!worktreeInfo.isDirectory() || worktreeInfo.isSymbolicLink()) fail('unsafe-terminal-archive-destination', 'terminal archive authority root must be a real directory.', [context.worktreeRoot]);
  const worktreePhysical = await realpath(context.worktreeRoot);
  if (existsSync(archiveParent)) {
    const parentInfo = await lstat(archiveParent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail('unsafe-terminal-archive-destination', 'terminal archive parent must be a non-symbolic directory.', [archiveParent]);
  } else await ensurePrivateAuthorityDirectory(archiveParent);
  const parentPhysical = await realpath(archiveParent);
  if (!pathContained(worktreePhysical, parentPhysical)) fail('unsafe-terminal-archive-destination', 'terminal archive parent escapes its worktree authority root.', [archiveParent, parentPhysical]);
  await enforcePrivateAuthorityPath(archiveParent, true);
  if (existsSync(archiveRoot)) {
    const finalInfo = await lstat(archiveRoot);
    if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory()) fail('unsafe-terminal-archive-destination', 'terminal archive final path is preoccupied by an unsafe object.', [archiveRoot]);
    if (createStage) fail('unsafe-terminal-archive-destination', 'terminal archive final path already exists before terminal commit.', [archiveRoot]);
  }
  if (!existsSync(stage) && createStage) await mkdir(stage, { recursive: false, mode: 0o700 });
  if (existsSync(stage)) {
    const stageInfo = await lstat(stage);
    if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink() || !pathContained(parentPhysical, await realpath(stage))) fail('unsafe-terminal-archive-destination', 'terminal archive staging path is unsafe.', [stage]);
    await enforcePrivateAuthorityPath(stage, true);
  }
  // Re-read every destination component after creation; no later copy is
  // permitted to discover or follow a different ancestry.
  const parentAfter = await lstat(archiveParent);
  if (!parentAfter.isDirectory() || parentAfter.isSymbolicLink() || await realpath(archiveParent) !== parentPhysical) fail('unsafe-terminal-archive-destination', 'terminal archive ancestry changed during preparation.', [archiveParent]);
}

async function validateTerminalArchiveSources(context: PreparedCloseContext): Promise<void> {
  await assertPrivateTerminalArchiveAncestry(context, true);
  const mainInfo = await lstat(context.active.main_worktree_path);
  if (!mainInfo.isDirectory() || mainInfo.isSymbolicLink()) fail('unsafe-terminal-archive-source', 'main worktree archive authority must be a real directory.', [context.active.main_worktree_path]);
  const mainPhysical = await realpath(context.active.main_worktree_path);
  await assertNoSymbolicTree(context.active.runtime_root, mainPhysical, 'terminal runtime archive');
  const taskRoot = taskRootForActiveAutopilot(context.active);
  const taskInfo = await lstat(taskRoot);
  if (!taskInfo.isDirectory() || taskInfo.isSymbolicLink()) fail('unsafe-terminal-archive-source', 'task archive authority must be a real directory.', [taskRoot]);
  const taskPhysical = await realpath(taskRoot);
  for (const file of [TASK_INFO_FILE, BRANCHES_FILE, UNIT_INDEX_FILE, '_checkout-profile.json', '_materialization-ledger.jsonl']) {
    const source = join(taskRoot, file);
    if (existsSync(source)) await assertNoSymbolicTree(source, taskPhysical, 'terminal task metadata archive');
  }
}

async function copyPathNoFollow(source: string, destination: string, physicalRoot: string): Promise<void> {
  const before = await lstat(source);
  if (before.isSymbolicLink()) fail('unsafe-terminal-archive-source', 'terminal archive copy refuses a symbolic link or loop.', [source]);
  const physical = await realpath(source);
  if (!pathContained(physicalRoot, physical)) fail('unsafe-terminal-archive-source', 'terminal archive copy source escaped its physical authority root.', [source, physical]);
  if (before.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail('unsafe-terminal-archive-source', 'terminal archive copy refuses a symbolic link or loop.', [join(source, entry.name)]);
      await copyPathNoFollow(join(source, entry.name), join(destination, entry.name), physicalRoot);
    }
    return;
  }
  if (!before.isFile()) fail('unsafe-terminal-archive-source', 'terminal archive copy accepts regular files only.', [source]);
  const descriptor = openSync(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    const beforeSync = lstatSync(source);
    const openedPhysical = await realpath(source);
    if (!pathContained(physicalRoot, openedPhysical)) fail('unsafe-terminal-archive-source', 'terminal archive source ancestor changed to a physical escape while opening.', [source, openedPhysical, physicalRoot]);
    if (!opened.isFile() || opened.dev !== beforeSync.dev || opened.ino !== beforeSync.ino || opened.size !== beforeSync.size) fail('unsafe-terminal-archive-source', 'terminal archive source identity changed while opening.', [source]);
    const bytes = readFileSync(descriptor);
    const afterHandle = fstatSync(descriptor);
    const afterPath = lstatSync(source);
    if (bytes.byteLength !== opened.size || afterHandle.dev !== opened.dev || afterHandle.ino !== opened.ino || afterHandle.size !== opened.size || afterPath.isSymbolicLink() || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || afterPath.size !== opened.size) fail('unsafe-terminal-archive-source', 'terminal archive source identity changed during no-follow read.', [source]);
    await ensurePrivateAuthorityDirectory(dirname(destination));
    if (existsSync(destination)) {
      const destinationInfo = await lstat(destination);
      if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink()) fail('unsafe-terminal-archive-destination', 'terminal archive staging destination is not a regular file.', [destination]);
      const existing = await readFile(destination);
      if (createHash('sha256').update(existing).digest('hex') !== createHash('sha256').update(bytes).digest('hex') || existing.byteLength !== bytes.byteLength) fail('terminal-archive-conflict', 'existing staged archive bytes differ from the no-follow source.', [destination]);
    } else {
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      const target = await open(destination, 'r');
      try { await target.sync(); } finally { await target.close(); }
      await enforcePrivateAuthorityPath(destination, false);
    }
  } finally { closeSync(descriptor); }
}

async function integrateTargetIntoWorkstream(input: { readonly active: ActiveAutopilotRow; readonly targetHead: string; readonly env: ProcessEnvLike }): Promise<string | null> {
  const workstreamHead = gitHead(input.active.main_worktree_path);
  if (isAncestor(input.active.main_worktree_path, input.targetHead, workstreamHead)) return null;
  const targetBranch = requireTargetBranch(input.active);
  const mergeSpec = {
    active: input.active, unitId: 'main', attempt: 1, kind: 'main' as const, operationType: 'merge' as const,
    initialWorktreeState: 'active' as const, committedWorktreeState: 'active' as const,
    intent: { repo_root: input.active.source_repo, worktree_path: input.active.main_worktree_path, git_common_dir: input.active.git_common_dir, branch: input.active.branch, reason: 'integrate current target before close', base_sha: workstreamHead, target_sha: input.targetHead, archive_ref: null, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [] },
  };
  try {
    await executeOwnedWorktreeSaga(mergeSpec, {
      action: async () => {
        const merge = await runGitMutation({ descriptor: { kind: 'merge', mode: 'no-ff', message: `autopilot close integration ${input.active.workstream_run}`, target: targetBranch }, cwd: input.active.main_worktree_path, env: runtimeGitEnv('close-integration') });
        const postcondition = inspectOwnedWorktreeSpecPostcondition(mergeSpec, input.env);
        if (postcondition.effect_applied) return;
        if (postcondition.outcome === 'unsafe') fail('integration-merge-conflict', 'target merge canonical probe found unsafe repository state.', postcondition.proof);
        if (!postcondition.proof.includes('interrupted_merge')) throw new CoordinationRuntimeError('recovery-required', 'target merge did not apply and left no canonically compensable merge state', [...postcondition.proof, `mutation_report=${merge.kind}`, `mutation_diagnostic=${merge.diagnostic}`]);
        const abort = await runGitMutation({ descriptor: { kind: 'merge-abort' }, cwd: input.active.main_worktree_path, env: runtimeGitEnv('close-integration') });
        const restored = inspectOwnedWorktreeSpecPostcondition(mergeSpec, input.env);
        if (restored.outcome !== 'not-applied' || restored.effect_applied || restored.proof.includes('interrupted_merge')) fail('integration-merge-conflict', 'target merge into workstream conflicted and canonical abort probe failed.', [merge.diagnostic, abort.diagnostic, ...restored.proof]);
        throw new WorktreeSagaCompensatedError(`target merge into workstream conflicted: ${merge.diagnostic}`, [`workstream_head=${workstreamHead}`, `target_head=${input.targetHead}`]);
      },
    }, input.env);
  } catch (error) {
    if (error instanceof WorktreeSagaCompensatedError) fail('integration-merge-conflict', `${error.message}; targeted revalidation required before close`, error.proof);
    throw error;
  }
  const after = gitHead(input.active.main_worktree_path);
  return after === workstreamHead ? null : after;
}

async function fastForwardD65TerminalTarget(input: { readonly active: ActiveAutopilotRow; readonly sourceRepo: string; readonly targetBefore: string }): Promise<void> {
  const desired = gitHead(input.active.main_worktree_path);
  const current = gitHead(input.sourceRepo);
  if (current === desired) return;
  if (current !== input.targetBefore) fail('terminal-successor-context-mismatch', 'D65 terminal target moved away from its immutable pre-effect authority.', [current, input.targetBefore, desired]);
  if (!isAncestor(input.sourceRepo, current, desired)) fail('terminal-successor-context-mismatch', 'D65 terminal authority is not a fast-forward descendant of the immutable target.', [current, desired]);
  const mutation = await runGitMutation({ descriptor: { kind: 'merge', mode: 'ff-only', target: input.active.branch }, cwd: input.sourceRepo, env: runtimeGitEnv('d65-terminal-final-merge') });
  if (mutation.kind !== 'reported' || mutation.exitCode !== 0 || gitHead(input.sourceRepo) !== desired) throw new CoordinationRuntimeError('git-partial-effect', 'D65 terminal Git effect did not report and verify one exact fast-forward', [mutation.kind === 'reported' ? mutation.diagnostic : mutation.reason, current, desired]);
}

async function fastForwardTargetToWorkstream(input: { readonly active: ActiveAutopilotRow; readonly sourceRepo: string; readonly branch: string; readonly targetBefore: string; readonly env: ProcessEnvLike }): Promise<void> {
  const desired = gitHead(input.active.main_worktree_path);
  const targetBranch = requireTargetBranch(input.active);
  await executeOwnedWorktreeSaga({
    active: input.active, unitId: 'main', attempt: 1, kind: 'main', operationType: 'merge',
    initialWorktreeState: 'active', committedWorktreeState: 'active',
    intent: { repo_root: input.sourceRepo, worktree_path: input.active.main_worktree_path, git_common_dir: input.active.git_common_dir, branch: input.active.branch, reason: 'atomically fast-forward captured target to validated workstream', base_sha: input.targetBefore, target_sha: desired, archive_ref: targetBranch, checkout_mode: null, sparse_patterns: [], paths: [], metadata_refs: [] },
  }, {
    action: async () => { await runGitMutation({ descriptor: { kind: 'merge', mode: 'ff-only', target: input.branch }, cwd: input.sourceRepo, env: runtimeGitEnv('final-merge') }); },
  }, input.env);
}

async function setActiveStatus(
  coordinationRoot: string,
  row: ActiveAutopilotRow,
  status: AutopilotParentStatus,
  now: Date,
  closedAt: string | null,
): Promise<ActiveAutopilotRow> {
  const lockPath = coordinationCutoverCommitted(dirname(dirname(coordinationRoot)), row.repo_key)
    ? join(row.worktree_root, '.locks', 'activation.lock')
    : join(coordinationRoot, '.locks', 'activation.lock');
  return await withAutopilotFileLock(lockPath, `close-status:${row.autopilot_id}`, async () => {
    const updated: ActiveAutopilotRow = {
      ...row,
      status,
      active_epoch_started_at: now.toISOString(),
    };
    if (!coordinationCutoverCommitted(dirname(dirname(coordinationRoot)), row.repo_key)) {
      const rows = await readActiveAutopilots(coordinationRoot);
      const replaced = rows.map((candidate) => candidate.autopilot_id === row.autopilot_id ? updated : candidate);
      if (!replaced.some((candidate) => candidate.autopilot_id === row.autopilot_id)) fail('active-row-missing', 'active Autopilot row disappeared during close.', [row.autopilot_id]);
      await writeActiveAutopilots(coordinationRoot, replaced);
    }
    await updateTaskInfoStatus(updated, status);
    if (closedAt !== null) await updateTaskInfoClosedAt(updated, closedAt);
    return updated;
  });
}

async function updateTaskInfoClosedAt(row: ActiveAutopilotRow, closedAt: string): Promise<void> {
  const path = join(taskRootForActiveAutopilot(row), TASK_INFO_FILE);
  if (!existsSync(path)) return;
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeJsonAtomic(path, { ...value, schema_version: 'autopilot.task_info.v2', coordination_authority: row.coordination_authority, status: row.status, closed_at: closedAt });
}

async function updateBranchesInfo(row: ActiveAutopilotRow, archiveRef: string, currentSha: string): Promise<void> {
  const path = join(taskRootForActiveAutopilot(row), BRANCHES_FILE);
  if (!existsSync(path)) return;
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeJsonAtomic(path, { ...value, current_sha: currentSha, archive_ref: archiveRef });
}

async function writeCloseAttempt(context: PreparedCloseContext, now: Date, outsideRunAuthority = false): Promise<string> {
  const attemptPath = outsideRunAuthority
    ? join(taskRootForActiveAutopilot(context.active), '_close-attempts', `attempt-${safeTimestamp(now)}.json`)
    : join(context.active.runtime_root, 'close', `attempt-${safeTimestamp(now)}.json`);
  await writeJsonAtomic(attemptPath, {
    schema_version: 'autopilot.close_attempt.v1',
    workstream: context.active.workstream,
    workstream_run: context.active.workstream_run,
    autopilot_id: context.active.autopilot_id,
    repo_key: context.repo.repoKey,
    branch: context.active.branch,
    target_branch: context.active.target_branch,
    source_repo: context.repo.repoRoot,
    worktree_path: context.active.main_worktree_path,
    created_at: now.toISOString(),
  });
  return attemptPath;
}

async function writeCloseResult(runtimeRoot: string, result: AutopilotCloseResult, now: Date): Promise<string> {
  const path = join(runtimeRoot, 'close', `result-${safeTimestamp(now)}.json`);
  await writeJsonAtomic(path, result);
  return path;
}

function buildCloseResult(input: {
  readonly outcome: AutopilotCloseOutcome;
  readonly active: ActiveAutopilotRow;
  readonly repoKey: string;
  readonly targetBefore: string;
  readonly targetAfter: string | null;
  readonly workstreamBefore: string;
  readonly workstreamAfter: string | null;
  readonly integrationCommitSha: string | null;
  readonly changedPaths: readonly string[];
  readonly releasedClaims: readonly string[];
  readonly archivedRuntimePath: string | null;
  readonly archiveRef: string | null;
  readonly mergeId: string | null;
  readonly blockers: readonly string[];
  readonly closeResultPath: string | null;
  readonly now: Date;
}): AutopilotCloseResult {
  return Object.freeze({
    schema_version: 'autopilot.close_result.v1',
    outcome: input.outcome,
    workstream: input.active.workstream,
    workstream_run: input.active.workstream_run,
    autopilot_id: input.active.autopilot_id,
    repo_key: input.repoKey,
    branch: input.active.branch,
    target_branch: input.active.target_branch,
    target_before: input.targetBefore,
    target_after: input.targetAfter,
    workstream_before: input.workstreamBefore,
    workstream_after: input.workstreamAfter,
    integration_commit_sha: input.integrationCommitSha,
    changed_paths: sortedUnique(input.changedPaths),
    released_claims: sortedUnique(input.releasedClaims),
    archived_runtime_path: input.archivedRuntimePath,
    archive_ref: input.archiveRef,
    merge_id: input.mergeId,
    blockers: sortedUnique(input.blockers),
    close_result_path: input.closeResultPath,
    created_at: input.now.toISOString(),
  });
}

async function writeAndRecordRunTerminalEvidence(active: ActiveAutopilotRow, outcome: 'closed' | 'aborted', terminalSha: string, env: ProcessEnvLike, now: Date): Promise<void> {
  const evidencePath = join(active.runtime_root, 'close', `_run-terminal.${outcome}.json`);
  const cleanupPath = terminalCleanupManifestPath(active);
  if (!existsSync(cleanupPath)) fail('terminal-cleanup-intent-missing', 'Terminal evidence cannot commit before its cleanup intent is durable.', [cleanupPath]);
  const cleanupBytes = await readFile(cleanupPath);
  await writeJsonAtomic(evidencePath, {
    schema_version: 'autopilot.run_terminal.v1',
    repo_key: active.repo_key,
    autopilot_id: active.autopilot_id,
    workstream: active.workstream,
    workstream_run: active.workstream_run,
    outcome,
    terminal_sha: terminalSha,
    cleanup_manifest_ref: 'close/_terminal-cleanup.json',
    cleanup_manifest_sha256: `sha256:${createHash('sha256').update(cleanupBytes).digest('hex')}`,
    accepted_at: now.toISOString(),
  });
  await recordCoordinatorReleaseEvidenceFromFile({ active, source: outcome === 'closed' ? 'run-close' : 'run-abort', targetId: active.workstream_run, evidencePath, env });
}

async function fsyncArchiveTree(root: string): Promise<void> {
  if (platform() === 'win32') return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await fsyncArchiveTree(path);
    else {
      const file = await open(path, 'r');
      try { await file.sync(); } finally { await file.close(); }
    }
  }
  const directory = await open(root, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function archiveRuntimeArtifacts(context: PreparedCloseContext, archiveRef: string, now: Date): Promise<string> {
  const archiveParent = join(context.worktreeRoot, '_archive');
  const archiveRoot = join(archiveParent, context.active.workstream_run);
  const archiveRuntime = join(archiveRoot, 'runtime');
  const stage = terminalArchiveStagingPath(context);
  await assertPrivateTerminalArchiveAncestry(context, false);
  if (existsSync(archiveRoot)) {
    const infoPath = join(archiveRoot, '_archive-info.json');
    if (!existsSync(infoPath)) fail('terminal-archive-conflict', 'published terminal archive lacks its completion identity.', [archiveRoot]);
    const info = JSON.parse(await readFile(infoPath, 'utf8')) as Readonly<Record<string, unknown>>;
    if (info['schema_version'] !== 'autopilot.archive_info.v1' || info['workstream_run'] !== context.active.workstream_run || info['autopilot_id'] !== context.active.autopilot_id || info['archive_ref'] !== archiveRef) fail('terminal-archive-conflict', 'published terminal archive belongs to different terminal authority.', [archiveRoot]);
    if (!existsSync(archiveRuntime)) fail('terminal-runtime-archive-missing', 'published terminal archive has no runtime tree.', [archiveRuntime]);
    return archiveRuntime;
  }
  if (!existsSync(stage)) fail('unsafe-terminal-archive-destination', 'private terminal archive staging reservation disappeared after terminal commit.', [stage]);
  if (existsSync(context.active.runtime_root)) {
    const runtimePhysicalRoot = await realpath(context.active.runtime_root);
    await assertNoSymbolicTree(context.active.runtime_root, runtimePhysicalRoot, 'terminal runtime archive');
    await copyPathNoFollow(context.active.runtime_root, join(stage, 'runtime'), runtimePhysicalRoot);
  } else if (!existsSync(join(stage, 'runtime'))) fail('terminal-runtime-archive-missing', 'active runtime vanished before its private staged archive became complete.', [context.active.runtime_root]);
  const taskRoot = taskRootForActiveAutopilot(context.active);
  if (existsSync(taskRoot)) {
    const taskPhysicalRoot = await realpath(taskRoot);
    for (const file of [TASK_INFO_FILE, BRANCHES_FILE, UNIT_INDEX_FILE, '_checkout-profile.json', '_materialization-ledger.jsonl']) {
      const source = join(taskRoot, file);
      if (existsSync(source)) await copyPathNoFollow(source, join(stage, file), taskPhysicalRoot);
    }
  }
  await writeJsonAtomic(join(stage, '_archive-info.json'), {
    schema_version: 'autopilot.archive_info.v1', workstream: context.active.workstream, workstream_run: context.active.workstream_run,
    autopilot_id: context.active.autopilot_id, branch: context.active.branch, archive_ref: archiveRef, archived_at: now.toISOString(),
  });
  await assertNoSymbolicTree(stage, await realpath(stage), 'private terminal archive staging');
  await fsyncArchiveTree(stage);
  // The final name is never deleted or overwritten. Its parent was privately
  // reserved before terminal commit; a raced symlink/object is rejected.
  if (existsSync(archiveRoot)) fail('unsafe-terminal-archive-destination', 'terminal archive final path was raced before atomic publication.', [archiveRoot]);
  await rename(stage, archiveRoot);
  if (platform() !== 'win32') {
    const parent = await open(archiveParent, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
  if (existsSync(stage) || !existsSync(archiveRuntime)) fail('terminal-runtime-archive-missing', 'atomic terminal archive publication did not establish the exact final tree.', [archiveRoot]);
  return archiveRuntime;
}

async function archiveWorktreeIndex(row: ActiveAutopilotRow, now: Date): Promise<void> {
  const path = join(row.worktree_root, WORKTREE_INDEX_FILE);
  const index = await readWorktreeIndex(path);
  const archivedRow = {
    workstream: row.workstream,
    workstream_run: row.workstream_run,
    autopilot_id: row.autopilot_id,
    started_at: row.started_at,
    main_path: row.main_worktree_path,
    branch: row.branch,
    status: 'archived' as const,
  };
  await writeJsonAtomic(path, {
    schema_version: 'autopilot.worktree_index.v1',
    active: index.active.filter((candidate) => candidate.workstream_run !== row.workstream_run),
    archive: [
      ...index.archive.filter((candidate) => candidate.workstream_run !== row.workstream_run),
      archivedRow,
    ],
  });
  await appendJsonl(join(row.worktree_root, '_ledger.jsonl'), {
    schema_version: 'autopilot.worktree_ledger.v1',
    event: 'archive',
    ts: now.toISOString(),
    workstream: row.workstream,
    workstream_run: row.workstream_run,
    autopilot_id: row.autopilot_id,
    branch: row.branch,
    main_path: row.main_worktree_path,
  });
}

async function releaseRetainedClaims(
  context: PreparedCloseContext,
  retainedClaims: readonly AutopilotPathClaim[],
  now: Date,
): Promise<readonly string[]> {
  if (retainedClaims.length === 0) return [];
  return await withAutopilotFileLock(join(context.coordinationRoot, '.locks', 'path-claims.lock'), `close-release:${context.active.autopilot_id}`, async () => {
    const current = await readPathClaims(context.coordinationRoot);
    const releaseKeys = new Set(retainedClaims.map(claimKey));
    const released = current.filter((claim) => releaseKeys.has(claimKey(claim)));
    const remaining = current.filter((claim) => !releaseKeys.has(claimKey(claim)));
    await writePathClaims(context.coordinationRoot, remaining);
    for (const claim of released) {
      await appendClaimEvent(context.coordinationRoot, {
        schema_version: 'autopilot.claim_event.v1',
        event: 'release',
        ts: now.toISOString(),
        repo_key: context.active.repo_key,
        autopilot_id: claim.autopilot_id,
        workstream: claim.workstream,
        workstream_run: claim.workstream_run,
        unit_id: claim.unit_id,
        attempt: claim.attempt,
        path: claim.path,
        claim_type: claim.claim_type,
        active_run_epoch: claim.active_run_epoch,
        reason: 'autopilot close/archive release',
      });
    }
    return sortedUnique(released.map((claim) => `${claim.claim_type} ${claim.path}`));
  });
}

function claimKey(claim: AutopilotPathClaim): string {
  return `${claim.autopilot_id}\0${claim.workstream_run}\0${claim.unit_id}\0${String(claim.attempt)}\0${claim.claim_type}\0${claim.path}`;
}

async function appendForeignMergeAcks(context: PreparedCloseContext, merges: readonly AutopilotMergeEvent[], now: Date): Promise<void> {
  for (const merge of merges) {
    const ack: AutopilotForeignMergeAck = {
      schema_version: 'autopilot.foreign_merge_ack.v1',
      ack_id: buildId('ack', `${context.active.workstream_run}-${merge.merge_id}`, now),
      merge_id: merge.merge_id,
      repo_key: context.active.repo_key,
      acknowledging_autopilot_id: context.active.autopilot_id,
      acknowledging_workstream_run: context.active.workstream_run,
      foreign_autopilot_id: merge.autopilot_id,
      foreign_workstream_run: merge.workstream_run,
      action: 'non-intersecting',
      intersection_paths: [],
      acked_at: now.toISOString(),
    };
    await appendJsonl(join(context.coordinationRoot, FOREIGN_MERGE_ACKS_FILE), parseForeignMergeAck(ack));
  }
}

async function readMergeLog(coordinationRoot: string): Promise<readonly AutopilotMergeEvent[]> {
  const path = join(coordinationRoot, MERGE_LOG_FILE);
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  const out: AutopilotMergeEvent[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    try {
      out.push(parseMergeEvent(JSON.parse(line) as unknown));
    } catch (error) {
      fail('invalid-merge-log', `merge-log.jsonl line ${String(index + 1)} is invalid: ${errorMessage(error)}`, [path]);
    }
  }
  return Object.freeze(out);
}

async function readAckedMergeIds(coordinationRoot: string, active: ActiveAutopilotRow): Promise<ReadonlySet<string>> {
  const path = join(coordinationRoot, FOREIGN_MERGE_ACKS_FILE);
  if (!existsSync(path)) return new Set<string>();
  const text = await readFile(path, 'utf8');
  const ids = new Set<string>();
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    try {
      const ack = parseForeignMergeAck(JSON.parse(line) as unknown);
      if (ack.acknowledging_autopilot_id === active.autopilot_id && ack.acknowledging_workstream_run === active.workstream_run) ids.add(ack.merge_id);
    } catch (error) {
      fail('invalid-foreign-merge-acks', `foreign-merge-acks.jsonl line ${String(index + 1)} is invalid: ${errorMessage(error)}`, [path]);
    }
  }
  return ids;
}

function parseMergeEvent(value: unknown): AutopilotMergeEvent {
  const row = requireRecord(value, 'merge event');
  const parsed: AutopilotMergeEvent = {
    schema_version: expectConst(row, 'schema_version', 'autopilot.merge_event.v1'),
    merge_id: expectString(row, 'merge_id'),
    repo_key: expectString(row, 'repo_key'),
    autopilot_id: expectString(row, 'autopilot_id'),
    workstream: expectString(row, 'workstream'),
    workstream_run: expectString(row, 'workstream_run'),
    branch: expectString(row, 'branch'),
    target_branch: expectString(row, 'target_branch'),
    target_before: expectString(row, 'target_before'),
    target_after: expectString(row, 'target_after'),
    workstream_before: expectString(row, 'workstream_before'),
    workstream_after: expectString(row, 'workstream_after'),
    integration_commit_sha: expectNullableString(row, 'integration_commit_sha'),
    changed_paths: expectStringArray(row, 'changed_paths'),
    merged_at: expectString(row, 'merged_at'),
  };
  return parsed;
}

function parseForeignMergeAck(value: unknown): AutopilotForeignMergeAck {
  const row = requireRecord(value, 'foreign merge ack');
  const action = expectString(row, 'action');
  if (action !== 'non-intersecting') fail('invalid-foreign-merge-ack', 'foreign merge ack action is invalid.', [action]);
  return {
    schema_version: expectConst(row, 'schema_version', 'autopilot.foreign_merge_ack.v1'),
    ack_id: expectString(row, 'ack_id'),
    merge_id: expectString(row, 'merge_id'),
    repo_key: expectString(row, 'repo_key'),
    acknowledging_autopilot_id: expectString(row, 'acknowledging_autopilot_id'),
    acknowledging_workstream_run: expectString(row, 'acknowledging_workstream_run'),
    foreign_autopilot_id: expectString(row, 'foreign_autopilot_id'),
    foreign_workstream_run: expectString(row, 'foreign_workstream_run'),
    action,
    intersection_paths: expectStringArray(row, 'intersection_paths'),
    acked_at: expectString(row, 'acked_at'),
  };
}

function closeMergeLockPath(context: PreparedCloseContext, env: ProcessEnvLike): string {
  return coordinationCutoverCommitted(resolveAutopilotStateRoot(env), context.active.repo_key)
    ? join(context.worktreeRoot, '.locks', 'main-merge.lock')
    : mainMergeLockPathForRepo(context.repo.repoKey, env);
}

function requireTargetBranch(row: ActiveAutopilotRow): string {
  if (row.target_branch === null) fail('missing-target-branch', 'active Autopilot row has no target branch.');
  return row.target_branch;
}

function revParse(cwd: string, ref: string): string {
  return gitQueryText({ descriptor: { kind: 'resolve-revision', revision: ref }, cwd }).trim();
}

function latestCommitForPath(cwd: string, fromExclusive: string, toInclusive: string, path: string): string | null {
  const output = gitQueryText({ descriptor: { kind: 'last-commit-for-path', fromExclusive, toInclusive, path }, cwd }).trim();
  return output.length === 0 ? null : output;
}

function revList(cwd: string, fromExclusive: string, toInclusive: string): readonly string[] {
  const output = gitQueryText({ descriptor: { kind: 'rev-list-range', fromExclusive, toInclusive }, cwd }).trim();
  if (output.length === 0) return [];
  return Object.freeze(output.split('\n').filter((line) => line.length > 0));
}

function diffPaths(cwd: string, left: string, right: string): readonly string[] {
  return Object.freeze(gitQueryNulStrings({ descriptor: { kind: 'diff-paths', from: left, to: right }, cwd }).map((path) => path.replace(/\\/gu, '/')).sort((a, b) => a.localeCompare(b)));
}

function currentBranch(cwd: string): string | null {
  const result = runGitQuery({ descriptor: { kind: 'current-branch' }, cwd });
  return result.negative ? null : new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).trim();
}

function commitExists(cwd: string, sha: string): boolean {
  return !runGitQuery({ descriptor: { kind: 'commit-exists', revision: sha }, cwd }).negative;
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return !runGitQuery({ descriptor: { kind: 'is-ancestor', ancestor, descendant }, cwd }).negative;
}

function intersectingPaths(paths: readonly string[], patterns: readonly string[]): readonly string[] {
  return sortedUnique(paths.filter((path) => patterns.some((pattern) => pathOverlapsOrContains(path, pattern))));
}

function pathMatchesAnyClaim(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesRepoPathPattern(path, pattern));
}

function runtimeGitEnv(authority: string): Record<string, string> {
  return {
    AUTOPILOT_RUNTIME: '1',
    AUTOPILOT_RUNTIME_AUTHORITY: authority,
    GIT_AUTHOR_NAME: 'autopilot-runtime',
    GIT_AUTHOR_EMAIL: 'autopilot-runtime@example.invalid',
    GIT_COMMITTER_NAME: 'autopilot-runtime',
    GIT_COMMITTER_EMAIL: 'autopilot-runtime@example.invalid',
  };
}

function buildId(prefix: string, seed: string, now: Date): string {
  return `${prefix}-${seed}-${safeTimestamp(now)}-${Math.random().toString(16).slice(2, 8)}`;
}

function safeTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/gu, '').replace(/Z$/u, 'Z');
}

function normalizeSha(value: string): string | null {
  return /^[a-f0-9]{40,64}$/u.test(value) ? value : null;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('invalid-runtime-record', `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function expectString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) fail('invalid-runtime-record', `field ${field} must be a non-empty string.`);
  return value;
}

function expectNullableString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value === 'string') return value;
  fail('invalid-runtime-record', `field ${field} must be a string or null.`);
}

function expectConst<T extends string>(record: Record<string, unknown>, field: string, expected: T): T {
  const value = record[field];
  if (value !== expected) fail('invalid-runtime-record', `field ${field} must equal ${expected}.`);
  return expected;
}

function expectStringArray(record: Record<string, unknown>, field: string): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail('invalid-runtime-record', `field ${field} must be a string array.`);
  return Object.freeze([...value] as string[]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void ACTIVE_AUTOPILOTS_FILE;
void PATH_CLAIMS_FILE;
void CLAIM_EVENTS_FILE;
