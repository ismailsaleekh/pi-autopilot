import { constants as fsConstants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcessDataChunk, type ChildProcessLite } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTOPILOT_COORDINATION_AUTHORITY_ENV,
  AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV,
  AUTOPILOT_PREFLIGHT_ROLLBACK_REASON_PREFIX,
  AUTOPILOT_STATUS_CONTEXT_ENV,
  AUTOPILOT_STATUS_TOOL,
} from './names.ts';
import {
  AUTOPILOT_EXECUTION_OBSERVATION_ENV,
  deriveRoutePolicyFromObservedProviderApi,
  parseAutopilotExecutionObservation,
  type AutopilotExecutionObservationV1,
} from '../internal/execution-observer-extension.ts';
import {
  buildAutopilotProviderIdentity,
  buildAutopilotProviderIdentityFromRequestProfile,
  buildAutopilotStatusToolContext,
  deriveAutopilotArtifactRoot,
  parseAutopilotStatusToolContext,
  sha256Buffer,
  splitAutopilotModelId,
  validateAutopilotStatusEvidence,
  type AutopilotObservedExecutionEvidence,
  type AutopilotProviderIdentity,
  type AutopilotRosterExecutionIdentity,
  type AutopilotStatusReceipt,
  type AutopilotStatusToolContext,
} from './forced-output/index.ts';
import { AutopilotForcedOutputEvidenceError } from './forced-output/status-evidence.ts';
import { parseAutopilotStatusEntry, parseAutopilotUnitSpec, parseAutopilotUnitSpecV2 } from './contracts/index.ts';
import { deriveAutopilotAuthority, persistAutopilotAuthority, type AutopilotAuthorityArtifact } from './authority.ts';
import type { AutopilotExecutionAudit, AutopilotExecutionCommit, AutopilotStatusEntry, AutopilotUnitSpec, AutopilotUnitSpecV2 } from './contracts/types.ts';
import {
  captureAutopilotExecutionBaseline,
  deriveAutopilotExecutionAuditPath,
  writeAutopilotExecutionAudit,
  type AutopilotExecutionBaseline,
} from './execution-audit/index.ts';
import {
  AutopilotExecutionCommitError,
  commitAutopilotExecution,
  deriveAutopilotExecutionCommitPath,
} from './execution-commit.ts';
import {
  AutopilotParallelRuntimeError,
  acquireClaimsForUnit,
  coordinationRootForRepo,
  ensureWorktreeCleanForLaunch,
  prepareAutopilotUnitWorktree,
  readActiveAutopilots,
  readCoordinatorActiveAutopilots,
  readPathClaims,
  recoverAutopilotWorktreeSagas,
  releaseClaimsForUnit,
  readGitStatus,
  gitHead,
  resolveAutopilotStateRoot,
  AUTOPILOT_STATE_ROOT_ENV,
  resolveRepoIdentity,
  unitWorktreePathForActiveAutopilot,
  worktreeRootForRepo,
  resolveActiveAutopilotForSpec,
  isPathWithinRoot,
  type ActiveAutopilotContext,
  type ActiveAutopilotRow,
  type AutopilotPathClaim,
} from './parallel-runtime.ts';
import { coordinationCutoverCommitted } from './coordination/migration-paths.ts';
import { ClaimNegotiationClient, type ClaimGroupAcquisitionResult } from './coordination/negotiation.ts';
import { ReservationCoordinationClient, reservationSchedulingBlockers } from './coordination/reservations.ts';
import { PlanningContradictionClient } from './coordination/escalation.ts';
import { assertD65OrdinaryBoundaryFromEnvironment } from './coordination/d65-runtime-dispatch.ts';
import type { CoordinationAcquisitionGroup } from './coordination/types.ts';
import { quarantineFailedUnit, resetFailedUnit } from './unit-failure.ts';
import { rollbackCreatedUnitWorktree } from './worktree-cleanup.ts';
import { registerAutopilotChildAuthority, type AutopilotChildLeaseHandle } from './coordination/child-authority.ts';
import { autopilotAuditProvesZeroSourceChange, writeAutopilotChildTerminalAcceptance } from './coordination/terminal-acceptance.ts';
import {
  assertAutopilotSpecMaterializationDiskGate,
  expandedReadOnlyPathsForAudit,
  materializeAutopilotSpecPaths,
} from './materialization.ts';
import { assertAutopilotSpecQualityGate } from './quality/spec-gate.ts';
import {
  AutopilotPromptTemplateError,
  renderAndMaybeWriteAutopilotPromptSnapshot,
  deriveAutopilotPromptSnapshotPath,
  type AutopilotForcedOutputContract,
  type AutopilotRenderedPrompt,
} from './prompt-renderer/index.ts';
import { recoverRuntimeRosterSelection, runtimeRosterSnapshotPath } from './roster/snapshot.ts';
import { resolveCommittedExistingRunRosterTransitionChain, savedRosterRefForSelection, type AutopilotSavedRosterRefV1, type AutopilotRosterTransitionV1, type ExistingRunRosterSuccessorAttemptAuthority } from './roster/transition.ts';
import { preRunSelectionPath, resolveRosterScopePaths, rosterRevisionPath, type RosterSha256 } from './roster/paths.ts';
import { autopilotRosterContractCanonicalJson, computeAutopilotRosterContractObjectHash, parseAutopilotHistoricalFixedRosterAdapterResult, parseAutopilotRoster } from './roster/contracts.ts';
import { bytesEqual, parseCanonicalPreRunSelectionBytes, type RunSelectionDiagnostic } from './roster/run-selection.ts';
import { assertRequestProfileMatchesAssignment, assertUnitSpecMatchesPinnedFacts, resolvePinnedRoleRuntimeFacts } from './roster/runtime-spec.ts';
import { unitSpecAuthorityProjection, type AutopilotRuntimeUnitSpec } from './roster/runtime-consumers.ts';
import { isCentrallyTrustedW4CertifiedRoster } from './roster/providers/index.ts';
import { readAuthorityFileIfPresent } from './roster/transaction.ts';

type JsonRecord = Readonly<Record<string, unknown>>;
type ProcessEnv = Readonly<Record<string, string | undefined>>;
type TimerHandle = ReturnType<typeof setTimeout>;

export type AutopilotAgentRunFailureClass =
  | 'spec-invalid'
  | 'waiting-for-peer-release'
  | 'pi-spawn-failed'
  | 'missing-structured-output'
  | 'invalid-structured-output'
  | 'status-non-success'
  | 'runtime-commit-failed';

export interface AutopilotAgentRunErrorDetails {
  readonly reason: string;
  readonly specPath?: string;
  readonly statusOutput?: string;
  readonly receiptOutput?: string;
  readonly promptSnapshotPath?: string | null;
  readonly auditOutput?: string | null;
  readonly auditClassification?: AutopilotExecutionAudit['classification'] | null;
  readonly executionCommitOutput?: string | null;
  readonly executionCommitSha?: string | null;
  readonly piErrorCode?: string;
  readonly statusVerdict?: AutopilotStatusEntry['verdict'];
  readonly terminalAcceptanceOutput?: string;
  readonly terminalAcceptanceSha256?: `sha256:${string}`;
}

export class AutopilotAgentRunError extends Error {
  public readonly failureClass: AutopilotAgentRunFailureClass;
  public readonly details: AutopilotAgentRunErrorDetails;

  constructor(failureClass: AutopilotAgentRunFailureClass, details: AutopilotAgentRunErrorDetails) {
    super(`${failureClass}: ${details.reason}`);
    this.name = 'AutopilotAgentRunError';
    this.failureClass = failureClass;
    this.details = details;
  }
}

export type AutopilotAgentRunStatus = 'dry-run' | 'success';

export interface AutopilotAgentRunResult {
  readonly status: AutopilotAgentRunStatus;
  readonly spec: AutopilotRuntimeUnitSpec;
  readonly statusEntry: AutopilotStatusEntry | null;
  readonly statusOutput: string;
  readonly receiptOutput: string;
  readonly promptSnapshotPath: string | null;
  readonly contextPath: string;
  readonly auditOutput: string | null;
  readonly auditClassification: AutopilotExecutionAudit['classification'] | null;
  readonly executionCommitOutput: string | null;
  readonly executionCommitSha: string | null;
  readonly summary: string;
}

export interface AutopilotV1GrandfatherAuthority {
  readonly schema_version: 'autopilot.v1_grandfather_authority.v1';
  readonly authority: 'grandfathered-existing-v1';
  readonly unit_spec_sha256: `sha256:${string}`;
  readonly historical_bytes_mutated: false;
  readonly reason: string;
}

export interface AutopilotAgentRunOptions {
  readonly dryRun?: boolean;
  readonly piExecutable?: string;
  readonly env?: ProcessEnv;
  readonly timeoutMsOverride?: number;
  readonly forcePromptSnapshot?: boolean;
  readonly v1GrandfatherAuthority?: unknown;
}

const AUTOPILOT_AGENT_PI_EXECUTABLE_ENV = 'AUTOPILOT_AGENT_PI_EXECUTABLE';
const AUTOPILOT_V1_GRANDFATHER_AUTHORITY_ENV = 'AUTOPILOT_V1_GRANDFATHER_AUTHORITY';
const DEFAULT_AGENT_WALL_MS = 3_600_000;
const RPC_COMMAND_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_TEXT_LIMIT = 600;
const FAILURE_REASON_LIMIT = 2_400;
const AUTOPILOT_AGENT_STATUS_EXTENSION_PATH = resolveAutopilotInternalExtensionPath(import.meta.url, 'status-extension');
const AUTOPILOT_AGENT_EXECUTION_OBSERVER_EXTENSION_PATH = resolveAutopilotInternalExtensionPath(import.meta.url, 'execution-observer-extension');

function resolveAutopilotInternalExtensionPath(moduleUrl: string, basename: string): string {
  const sourcePath = fileURLToPath(new URL(`../internal/${basename}.ts`, moduleUrl));
  if (existsSync(sourcePath)) return sourcePath;
  return fileURLToPath(new URL(`../internal/${basename}.js`, moduleUrl));
}

interface ToolPolicy {
  readonly builtinTools: readonly string[];
  readonly customTools: readonly string[];
  readonly disableMutatingBash: boolean;
}

interface SpawnSpec {
  readonly executable: string;
  readonly model: string;
  readonly thinking: AutopilotProviderIdentity['thinking_level'];
  readonly requestProfile?: AutopilotRosterExecutionIdentity['request_profile'];
  readonly cwd: string;
  readonly toolPolicy: ToolPolicy;
  readonly env: ProcessEnv;
  readonly contextPath: string;
  readonly executionObservationPath: string;
  readonly wallMs: number;
  readonly name: string;
  readonly preemptionSignal: AbortSignal;
}

interface RpcCommand {
  readonly type: string;
  readonly id: string;
  readonly [key: string]: unknown;
}

interface RpcResponse {
  readonly type: 'response';
  readonly id: string;
  readonly command?: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

interface ToolResultCandidate {
  readonly tool_name?: string;
  readonly toolName?: string;
  readonly tool_call_id?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly details?: unknown;
  readonly detailsConflict?: boolean;
}

interface PiRunDiagnostics {
  readonly errorMessages: readonly string[];
  readonly stderrTail: string;
  readonly eventSummaries: readonly JsonRecord[];
  readonly responseSummaries: readonly JsonRecord[];
}

interface PiResult {
  readonly isError: boolean;
  readonly stopReason: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly api: string | null;
  readonly thinkingLevel: string | null;
  readonly numTurns: number;
  readonly finalAssistantMessage: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly api: string | null;
    readonly stopReason: string | null;
  } | null;
  readonly initialStateModel: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly api: string | null;
  } | null;
  readonly artifacts: {
    readonly structuredOutput?: {
      readonly toolResultCandidates: readonly ToolResultCandidate[];
    };
    readonly diagnostics: PiRunDiagnostics;
    readonly executionObservationPath: string;
  };
}

class AutopilotPiRunError extends Error {
  public readonly code: string;
  public readonly details: JsonRecord | undefined;
  public readonly rpcRunArtifacts: PiRunDiagnostics | undefined;

  constructor(
    code: string,
    message: string,
    details?: JsonRecord,
    rpcRunArtifacts?: PiRunDiagnostics,
  ) {
    super(message);
    this.name = 'AutopilotPiRunError';
    this.code = code;
    this.details = details;
    this.rpcRunArtifacts = rpcRunArtifacts;
  }
}

interface PendingCommand {
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: TimerHandle;
}

interface PendingEvent {
  readonly resolve: (event: JsonRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer: TimerHandle;
}

interface ChildAuthorityLifecycle {
  handle: AutopilotChildLeaseHandle | null;
  completed: boolean;
  preflight: RuntimePreflightResult | null;
  env: ProcessEnv | null;
  spec: AutopilotUnitSpec | null;
  auditBaseline: AutopilotExecutionBaseline | null;
}

interface AutopilotAgentRunSpecBundle {
  /** Original runtime artifact identity: v2 stays v2 until strict external+mirror+roster authentication succeeds. */
  readonly unitSpec: AutopilotRuntimeUnitSpec;
  /** Adapter input for legacy v1-era mechanics after v2 authentication; never an authentication authority. */
  readonly authoritySpec: AutopilotUnitSpec | null;
  readonly originalSpec: AutopilotRuntimeUnitSpec;
  readonly rosterExecutionIdentity: AutopilotRosterExecutionIdentity | null;
}

export async function runAutopilotAgentFromSpecPath(
  specPath: string,
  options: AutopilotAgentRunOptions = {},
): Promise<AutopilotAgentRunResult> {
  const lifecycle: ChildAuthorityLifecycle = { handle: null, completed: false, preflight: null, env: null, spec: null, auditBaseline: null };
  try {
    return await runAutopilotAgentFromSpecPathInternal(specPath, options, lifecycle);
  } catch (error) {
    if (lifecycle.handle === null && lifecycle.preflight !== null && lifecycle.env !== null && lifecycle.spec !== null) {
      try {
        if (lifecycle.preflight.coordinatorGroup !== null) {
          await (await ClaimNegotiationClient.fromEnvironment(lifecycle.env)).cancelGroup({ group: lifecycle.preflight.coordinatorGroup, reason: 'autopilot-agent-run pre-child failure rollback' });
        } else if (lifecycle.preflight.acquiredClaims.length > 0) {
          await releaseClaimsForUnit({ context: lifecycle.preflight.context, unitId: lifecycle.spec.unit_id, attempt: lifecycle.spec.attempt, reason: 'autopilot-agent-run pre-child failure rollback' });
        }
      } catch (rollbackError) {
        throw new AutopilotAgentRunError('runtime-commit-failed', {
          reason: `pre-child attempt failed (${errorMessage(error)}) and authority rollback failed: ${errorMessage(rollbackError)}`,
          specPath,
        });
      }
    }
    if (lifecycle.handle !== null && !lifecycle.completed) {
      try {
        await lifecycle.handle.markRecoveryRequired();
        lifecycle.completed = true;
        if (lifecycle.preflight !== null && lifecycle.spec !== null && lifecycle.env !== null && isSourceChangingRole(lifecycle.spec)) {
          await preserveOrResetFailedSourceAttempt({
            context: lifecycle.preflight.context,
            spec: lifecycle.spec,
            baseline: lifecycle.auditBaseline,
            summary: `transport/recovery failure after child launch: ${errorMessage(error)}`,
            env: lifecycle.env,
          });
        }
      } catch (recoveryError) {
        throw new AutopilotAgentRunError('runtime-commit-failed', {
          reason: `child attempt failed (${errorMessage(error)}) and durable child recovery/preservation also failed: ${errorMessage(recoveryError)}`,
          specPath,
        });
      }
    }
    throw error;
  }
}

async function runAutopilotAgentFromSpecPathInternal(
  specPath: string,
  options: AutopilotAgentRunOptions,
  lifecycle: ChildAuthorityLifecycle,
): Promise<AutopilotAgentRunResult> {
  const env = { ...process.env, ...(options.env ?? {}) };
  let specBundle = await readAndValidateSpec(specPath, options, env);
  specBundle = await authenticateSpecBundleBeforePreflight({ specBundle, specPath, env });
  const spec = requireAuthenticatedAuthoritySpec(specBundle, specPath);
  if (options.dryRun !== true) await assertD65OrdinaryBoundaryFromEnvironment('runner-preflight', env);
  const runtimePreflight = await preflightSpec(specBundle, specPath, {
    skipStaleOutputCheck: options.dryRun === true,
    skipClaimAcquire: options.dryRun === true,
    skipSagaRecovery: options.dryRun === true,
    env,
  });
  lifecycle.preflight = runtimePreflight;
  lifecycle.env = env;
  lifecycle.spec = spec;
  let providerIdentity: AutopilotProviderIdentity;
  let context: AutopilotStatusToolContext;
  try {
    providerIdentity = specBundle.rosterExecutionIdentity === null
      ? buildAutopilotProviderIdentity(spec.model, spec.thinking)
      : buildAutopilotProviderIdentityFromRequestProfile(specBundle.rosterExecutionIdentity.request_profile);
    context = buildAutopilotStatusToolContext({
      unitSpec: spec,
      providerIdentity,
      ...(specBundle.rosterExecutionIdentity === null ? {} : { rosterExecutionIdentity: specBundle.rosterExecutionIdentity }),
    });
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: errorMessage(error),
      specPath,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
    });
  }
  if (options.dryRun !== true) await assertD65OrdinaryBoundaryFromEnvironment('post-acquisition-output', env);
  const auditBaseline = await captureAutopilotExecutionBaseline(spec.cwd);
  lifecycle.auditBaseline = auditBaseline;
  const auditOutput = deriveAutopilotExecutionAuditPath(specBundle.unitSpec, { allowLegacyV1RuntimeSpec: isLegacyV1RuntimeSpecBundle(specBundle) });
  const contextPath = deriveAutopilotStatusContextPath(spec);
  await writeStatusContext(contextPath, context);

  const adjudicationBundle = options.dryRun !== true && spec.role === 'adjudicate' ? await (await PlanningContradictionClient.fromEnvironment(env)).assignmentBundleFor(spec.unit_id, spec.attempt) : null;
  const adjudicationAssignment = adjudicationBundle?.assignment ?? null;
  const adjudicationOutput = adjudicationAssignment === null ? null : resolve(spec.cwd, 'adjudications', `${adjudicationAssignment.assignment_id}.json`);
  const coordinationAppendix = adjudicationAssignment === null || adjudicationBundle === null ? undefined : [
    '## Coordinator planning-contradiction assignment',
    '',
    'This is the only assignment you may adjudicate. Independently inspect the registered immutable clauses. If and only if they are a major contradiction, write the exact `autopilot.planning_contradiction_adjudication.v1` JSON result to:',
    '',
    `- ${adjudicationOutput}`,
    '',
    'Do not claim another identity or assignment. The runner will accept this file only through your authenticated terminal child authority.',
    '',
    '<coordinator_assignment_bundle_json>',
    JSON.stringify(adjudicationBundle, null, 2),
    '</coordinator_assignment_bundle_json>',
  ].join('\n');
  let rendered: AutopilotRenderedPrompt;
  try {
    rendered = await renderAndMaybeWritePromptForSpecBundle({
      specBundle,
      providerIdentity,
      ...(coordinationAppendix === undefined ? {} : { coordinationAppendix }),
      ...(options.forcePromptSnapshot === undefined ? {} : { forceSnapshot: options.forcePromptSnapshot }),
    });
  } catch (error) {
    if (error instanceof AutopilotPromptTemplateError) {
      throw new AutopilotAgentRunError('spec-invalid', {
        reason: `prompt template validation failed before model spend: ${error.message}`,
        specPath,
        statusOutput: spec.status_output,
        receiptOutput: spec.receipt_output,
      });
    }
    throw error;
  }

  if (options.dryRun === true) {
    return ({
      status: 'dry-run',
      spec: specBundle.unitSpec,
      statusEntry: null,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
      promptSnapshotPath: rendered.snapshotPath,
      contextPath,
      auditOutput: null,
      auditClassification: null,
      executionCommitOutput: null,
      executionCommitSha: null,
      summary: 'dry-run rendered prompt and status context without launching Pi',
    });
  }

  try {
    await assertD65OrdinaryBoundaryFromEnvironment('post-acquisition-output', env);
    lifecycle.handle = await registerAutopilotChildAuthority(spec, runtimePreflight.attemptSpec, env, runtimePreflight.authority.exclusives[0]?.critical_section ?? null);
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: `coordinator child authority preflight failed before model spend: ${errorMessage(error)}`,
      specPath,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
    });
  }

  const childProcessEnv: ProcessEnv = {
    ...env,
    [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: undefined,
    [AUTOPILOT_COORDINATION_AUTHORITY_ENV]: runtimePreflight.context.active.coordination_authority,
  };
  const spawnSpec: SpawnSpec = {
    executable: options.piExecutable ?? resolvePiExecutable(env),
    model: spec.model,
    thinking: providerIdentity.thinking_level,
    ...(specBundle.rosterExecutionIdentity === null ? {} : { requestProfile: specBundle.rosterExecutionIdentity.request_profile }),
    cwd: spec.cwd,
    toolPolicy: toolPolicyForRole(spec.role),
    env: childProcessEnv,
    contextPath,
    executionObservationPath: deriveAutopilotExecutionObservationPath(spec),
    wallMs: options.timeoutMsOverride ?? timeoutMsForSpec(spec),
    name: `autopilot-${spec.unit_id}-${spec.role}-attempt-${String(spec.attempt)}`,
    preemptionSignal: lifecycle.handle.preemptionSignal,
  };

  let piResult: PiResult;
  try {
    await assertD65OrdinaryBoundaryFromEnvironment('child-model-spawn', env);
    piResult = await runPiPromptWithStatusCarrier(spawnSpec, rendered.text);
  } catch (error) {
    if (error instanceof AutopilotPiRunError) {
      const audit = await writeAttemptAudit(specBundle, runtimePreflight.context, runtimePreflight.authority, auditBaseline, null, auditOutput, env);
      throw new AutopilotAgentRunError('pi-spawn-failed', {
        reason: `Pi spawn failed before valid Autopilot status acceptance: ${error.code}: ${error.message}${formatPiRunErrorDiagnostics(error)}`,
        specPath,
        statusOutput: spec.status_output,
        receiptOutput: spec.receipt_output,
        promptSnapshotPath: rendered.snapshotPath,
        auditOutput,
        auditClassification: audit.classification,
        piErrorCode: error.code,
      });
    }
    throw error;
  }

  let observedExecution: AutopilotObservedExecutionEvidence | null = null;
  try {
    observedExecution = await observeExecutionIdentityForRoster({
      specBundle,
      piResult,
    });
  } catch (error) {
    const audit = await writeAttemptAudit(specBundle, runtimePreflight.context, runtimePreflight.authority, auditBaseline, null, auditOutput, env);
    throw new AutopilotAgentRunError('invalid-structured-output', {
      reason: `execution identity observer failed before terminal acceptance: ${redactSensitiveText(errorMessage(error))}`,
      specPath,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
      promptSnapshotPath: rendered.snapshotPath,
      auditOutput,
      auditClassification: audit.classification,
    });
  }

  let evidence;
  try {
    evidence = await validateAutopilotStatusEvidence({
      unitSpec: spec,
      providerIdentity,
      ...(specBundle.rosterExecutionIdentity === null ? {} : { rosterExecutionIdentity: specBundle.rosterExecutionIdentity, observedExecution }),
    });
  } catch (error) {
    const audit = await writeAttemptAudit(specBundle, runtimePreflight.context, runtimePreflight.authority, auditBaseline, null, auditOutput, env);
    if (piResult.isError) {
      throw new AutopilotAgentRunError('pi-spawn-failed', {
        reason: `Pi session returned an error result before valid Autopilot status acceptance: ${formatPiResultFailureDiagnostics(piResult)}`,
        specPath,
        statusOutput: spec.status_output,
        receiptOutput: spec.receipt_output,
        promptSnapshotPath: rendered.snapshotPath,
        auditOutput,
        auditClassification: audit.classification,
      });
    }
    if (error instanceof AutopilotForcedOutputEvidenceError) {
      const failureClass: AutopilotAgentRunFailureClass =
        error.code === 'missing-status' || error.code === 'missing-receipt'
          ? 'missing-structured-output'
          : 'invalid-structured-output';
      throw new AutopilotAgentRunError(failureClass, {
        reason: error.message,
        specPath,
        statusOutput: spec.status_output,
        receiptOutput: spec.receipt_output,
        promptSnapshotPath: rendered.snapshotPath,
        auditOutput,
        auditClassification: audit.classification,
      });
    }
    throw new AutopilotAgentRunError('invalid-structured-output', {
      reason: errorMessage(error),
      specPath,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
      promptSnapshotPath: rendered.snapshotPath,
      auditOutput,
      auditClassification: audit.classification,
    });
  }

  const audit = await writeAttemptAudit(specBundle, runtimePreflight.context, runtimePreflight.authority, auditBaseline, evidence.status, auditOutput, env);

  try {
    validateAutopilotEmitStatusCarrier(
      piResult,
      evidence.receipt.tool_call_id,
      evidence.receipt.status_sha256 as `sha256:${string}`,
    );
    parseAutopilotStatusEntry(evidence.status, {
      unitSpec: spec,
      artifactRoot: deriveAutopilotArtifactRoot(spec),
      executionAudit: audit,
    });
  } catch (error) {
    throw new AutopilotAgentRunError('invalid-structured-output', {
      reason: errorMessage(error),
      specPath,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
      promptSnapshotPath: rendered.snapshotPath,
      auditOutput,
      auditClassification: audit.classification,
    });
  }

  if (
    piResult.isError &&
    !isBenignTerminalStatusCompletion(
      piResult,
      evidence.receipt.tool_call_id,
      evidence.receipt.status_sha256 as `sha256:${string}`,
    )
  ) {
    throw new AutopilotAgentRunError('pi-spawn-failed', {
      reason: `Pi session returned an error result after Autopilot status emission: ${formatPiResultFailureDiagnostics(piResult)}`,
      specPath,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
      promptSnapshotPath: rendered.snapshotPath,
      auditOutput,
      auditClassification: audit.classification,
    });
  }

  const childAuthority = lifecycle.handle;
  if (childAuthority === null) throw new AutopilotAgentRunError('runtime-commit-failed', { reason: 'durable child authority disappeared before terminal acceptance commit', specPath });
  let terminalAcceptance: Awaited<ReturnType<typeof writeAutopilotChildTerminalAcceptance>>;
  try {
    const terminalInputs = await materializeTerminalAcceptanceInputs({
      specBundle,
      specPath,
      receipt: evidence.receipt,
    });
    terminalAcceptance = await writeAutopilotChildTerminalAcceptance({
      mainWorktreePath: runtimePreflight.context.active.main_worktree_path,
      runtimeRoot: runtimePreflight.context.active.runtime_root,
      workstream: spec.workstream,
      child: childAuthority.child,
      specPath: terminalInputs.specPath,
      statusPath: spec.status_output,
      receiptPath: terminalInputs.receiptPath,
      auditPath: auditOutput,
      status: evidence.status,
      receipt: terminalInputs.receipt,
      audit,
    });
  } catch (error) {
    throw new AutopilotAgentRunError('runtime-commit-failed', {
      reason: `accepted structured output could not be committed as immutable child-terminal acceptance evidence: ${errorMessage(error)}`,
      specPath,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
      promptSnapshotPath: rendered.snapshotPath,
      auditOutput,
      auditClassification: audit.classification,
    });
  }

  if (!isSuccessVerdict(evidence.status)) {
    await childAuthority.completeTerminal(terminalAcceptance.evidence);
    lifecycle.completed = true;
    if (isSourceChangingRole(spec)) {
      await preserveOrResetTrustedNonSuccess({
        context: runtimePreflight.context,
        spec,
        audit,
        summary: `trusted terminal ${evidence.status.verdict}: ${evidence.status.summary}`,
        env,
      });
    }
    throw new AutopilotAgentRunError('status-non-success', {
      reason: `Autopilot status verdict ${evidence.status.verdict}: ${evidence.status.summary}`,
      specPath,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
      promptSnapshotPath: rendered.snapshotPath,
      auditOutput,
      auditClassification: audit.classification,
      statusVerdict: evidence.status.verdict,
      terminalAcceptanceOutput: terminalAcceptance.path,
      terminalAcceptanceSha256: terminalAcceptance.evidence.sha256,
    });
  }

  const executionCommitOutput = deriveAutopilotExecutionCommitPath(spec);
  let executionCommit: AutopilotExecutionCommit | null = null;
  try {
    executionCommit = await commitAutopilotExecution({
      spec,
      statusEntry: evidence.status,
      audit,
      context: runtimePreflight.context,
      acquiredClaims: runtimePreflight.acquiredClaims,
      auditPath: auditOutput,
      commitPath: executionCommitOutput,
      env,
    });
  } catch (error) {
    if (error instanceof AutopilotExecutionCommitError || error instanceof AutopilotParallelRuntimeError) {
      throw new AutopilotAgentRunError('runtime-commit-failed', {
        reason: error.message,
        specPath,
        statusOutput: spec.status_output,
        receiptOutput: spec.receipt_output,
        promptSnapshotPath: rendered.snapshotPath,
        auditOutput,
        auditClassification: audit.classification,
        executionCommitOutput,
      });
    }
    throw error;
  }

  childAuthority.assertHealthy();
  if (adjudicationAssignment !== null && adjudicationOutput !== null) {
    await childAuthority.completeAdjudication(adjudicationAssignment.assignment_id, adjudicationOutput, terminalAcceptance.evidence);
  } else {
    await childAuthority.completeTerminal(terminalAcceptance.evidence);
  }
  lifecycle.completed = true;

  return ({
    status: 'success',
    spec: specBundle.unitSpec,
    statusEntry: evidence.status,
    statusOutput: spec.status_output,
    receiptOutput: spec.receipt_output,
    promptSnapshotPath: rendered.snapshotPath,
    contextPath,
    auditOutput,
    auditClassification: audit.classification,
    executionCommitOutput: executionCommit === null ? null : executionCommitOutput,
    executionCommitSha: executionCommit?.commit_sha ?? null,
    summary: evidence.status.summary,
  });
}

function isSourceChangingRole(spec: AutopilotUnitSpec): boolean {
  return spec.role === 'implement' || spec.role === 'fix';
}

async function preserveOrResetTrustedNonSuccess(input: {
  readonly context: ActiveAutopilotContext;
  readonly spec: AutopilotUnitSpec;
  readonly audit: AutopilotExecutionAudit;
  readonly summary: string;
  readonly env: ProcessEnv;
}): Promise<void> {
  if (autopilotAuditProvesZeroSourceChange(input.audit) && existsSync(input.spec.cwd) && readGitStatus(input.spec.cwd).changedPaths.length === 0 && gitHead(input.spec.cwd) === input.audit.baseline_head) {
    await resetFailedUnit({ context: input.context, unitId: input.spec.unit_id, attempt: input.spec.attempt, unitWorktreePath: input.spec.cwd, summary: input.summary, ...(input.audit.baseline_head === null || input.audit.baseline_head === undefined ? {} : { baselineHead: input.audit.baseline_head }), env: input.env });
    return;
  }
  await quarantineFailedUnit({ context: input.context, unitId: input.spec.unit_id, attempt: input.spec.attempt, unitWorktreePath: input.spec.cwd, summary: input.summary, ...(input.audit.baseline_head === null || input.audit.baseline_head === undefined ? {} : { baselineHead: input.audit.baseline_head }), env: input.env });
}

async function preserveOrResetFailedSourceAttempt(input: {
  readonly context: ActiveAutopilotContext;
  readonly spec: AutopilotUnitSpec;
  readonly baseline: AutopilotExecutionBaseline | null;
  readonly summary: string;
  readonly env: ProcessEnv;
}): Promise<void> {
  const cleanUnchanged = input.baseline !== null
    && input.baseline.available
    && input.baseline.gitHead !== null
    && existsSync(input.spec.cwd)
    && readGitStatus(input.spec.cwd).changedPaths.length === 0
    && gitHead(input.spec.cwd) === input.baseline.gitHead;
  if (cleanUnchanged) {
    await resetFailedUnit({ context: input.context, unitId: input.spec.unit_id, attempt: input.spec.attempt, unitWorktreePath: input.spec.cwd, summary: input.summary, ...(input.baseline?.gitHead === null || input.baseline?.gitHead === undefined ? {} : { baselineHead: input.baseline.gitHead }), env: input.env });
    return;
  }
  await quarantineFailedUnit({ context: input.context, unitId: input.spec.unit_id, attempt: input.spec.attempt, unitWorktreePath: input.spec.cwd, summary: input.summary, ...(input.baseline?.gitHead === null || input.baseline?.gitHead === undefined ? {} : { baselineHead: input.baseline.gitHead }), env: input.env });
}

async function readAndValidateSpec(
  specPath: string,
  options: AutopilotAgentRunOptions,
  env: ProcessEnv,
): Promise<AutopilotAgentRunSpecBundle> {
  let parsed: unknown;
  let specBytes: Uint8Array;
  try {
    specBytes = await readFile(specPath);
    parsed = JSON.parse(Buffer.from(specBytes).toString('utf8')) as unknown;
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: `unit spec is not readable JSON: ${errorMessage(error)}`,
      specPath,
    });
  }

  try {
    if (isJsonRecord(parsed) && parsed['schema_version'] === 'autopilot.unit_spec.v2') {
      const originalSpec = parseAutopilotUnitSpecV2(parsed);
      assertV2LaunchQualityGate(originalSpec);
      return { unitSpec: originalSpec, authoritySpec: null, originalSpec, rosterExecutionIdentity: null };
    }
    const spec = parseAutopilotUnitSpec(parsed);
    assertV1SpecHasGrandfatherAuthority({ specPath, specBytes, options, env });
    assertAutopilotSpecQualityGate(spec);
    return { unitSpec: spec, authoritySpec: spec, originalSpec: spec, rosterExecutionIdentity: null };
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: errorMessage(error),
      specPath,
    });
  }
}

function assertV1SpecHasGrandfatherAuthority(input: {
  readonly specPath: string;
  readonly specBytes: Uint8Array;
  readonly options: AutopilotAgentRunOptions;
  readonly env: ProcessEnv;
}): void {
  const authorityValue = input.options.v1GrandfatherAuthority ?? readV1GrandfatherAuthorityFromCaller(input.specPath, input.env);
  if (authorityValue === null) {
    throw new Error('new unit_spec.v1 execution is forbidden; v1 bytes are historical evidence only and require exact historical adapter or grandfather authority');
  }
  const specSha256 = sha256Buffer(input.specBytes);
  if (isJsonRecord(authorityValue) && authorityValue['schema_version'] === 'autopilot.historical_fixed_roster_adapter_result.v1') {
    const result = parseAutopilotHistoricalFixedRosterAdapterResult(authorityValue);
    if (result.ok !== true || result.admission.admitted !== true || result.historical_bytes_mutated !== false || result.admission.historical_bytes_mutated !== false) {
      throw new Error('historical unit_spec.v1 adapter authority did not admit preserved bytes');
    }
    if (result.historical_unit_spec_sha256 !== specSha256) {
      throw new Error('historical unit_spec.v1 adapter authority hash does not match exact spec bytes');
    }
    return;
  }
  const authority = parseV1GrandfatherAuthority(authorityValue);
  if (authority.unit_spec_sha256 !== specSha256) {
    throw new Error('unit_spec.v1 grandfather authority hash does not match exact spec bytes');
  }
}

function readV1GrandfatherAuthorityFromCaller(specPath: string, env: ProcessEnv): unknown | null {
  const authorityPath = env[AUTOPILOT_V1_GRANDFATHER_AUTHORITY_ENV] ?? `${specPath}.grandfather-authority.json`;
  if (!existsSync(authorityPath)) return null;
  try {
    return JSON.parse(readFileSync(authorityPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`unit_spec.v1 grandfather authority is not readable JSON: ${errorMessage(error)}`);
  }
}

function parseV1GrandfatherAuthority(value: unknown): AutopilotV1GrandfatherAuthority {
  if (!isJsonRecord(value)) throw new Error('unit_spec.v1 grandfather authority must be a JSON object');
  const fields = ['schema_version', 'authority', 'unit_spec_sha256', 'historical_bytes_mutated', 'reason'];
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('unit_spec.v1 grandfather authority fields are not exact');
  if (value['schema_version'] !== 'autopilot.v1_grandfather_authority.v1') throw new Error('unit_spec.v1 grandfather authority schema_version is invalid');
  if (value['authority'] !== 'grandfathered-existing-v1') throw new Error('unit_spec.v1 grandfather authority kind is invalid');
  if (value['historical_bytes_mutated'] !== false) throw new Error('unit_spec.v1 grandfather authority must prove historical_bytes_mutated=false');
  const unitSpecSha256 = value['unit_spec_sha256'];
  if (typeof unitSpecSha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(unitSpecSha256)) throw new Error('unit_spec.v1 grandfather authority unit_spec_sha256 is invalid');
  const reason = value['reason'];
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 500) throw new Error('unit_spec.v1 grandfather authority reason is required');
  return Object.freeze({
    schema_version: 'autopilot.v1_grandfather_authority.v1',
    authority: 'grandfathered-existing-v1',
    unit_spec_sha256: unitSpecSha256 as `sha256:${string}`,
    historical_bytes_mutated: false,
    reason,
  });
}

function requireAuthenticatedAuthoritySpec(bundle: AutopilotAgentRunSpecBundle, specPath: string): AutopilotUnitSpec {
  if (bundle.authoritySpec !== null) return bundle.authoritySpec;
  throw new AutopilotAgentRunError('spec-invalid', {
    reason: 'unit_spec.v2 reached legacy authority mechanics before external roster/selection authentication',
    specPath,
    statusOutput: bundle.unitSpec.status_output,
    receiptOutput: bundle.unitSpec.receipt_output,
  });
}

async function authenticateSpecBundleBeforePreflight(input: {
  readonly specBundle: AutopilotAgentRunSpecBundle;
  readonly specPath: string;
  readonly env: ProcessEnv;
}): Promise<AutopilotAgentRunSpecBundle> {
  if (!isUnitSpecV2(input.specBundle.originalSpec)) return input.specBundle;
  try {
    const originalSpec = input.specBundle.originalSpec;
    const runtimeContext = await resolveReadOnlyV2RuntimeAuthenticationContext({
      originalSpec,
      specPath: input.specPath,
      env: input.env,
    });
    const stateRoot = input.env[AUTOPILOT_STATE_ROOT_ENV];
    const authenticated = await authenticateV2SpecAgainstSelectionOrTransition({
      stateRoot,
      runtimeContext,
      originalSpec,
      specPath: input.specPath,
    });
    return { ...input.specBundle, authoritySpec: unitSpecAuthorityProjection(originalSpec), rosterExecutionIdentity: authenticated.identity };
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: `unit_spec.v2 failed external roster/selection authentication before preflight authority derivation: ${errorMessage(error)}`,
      specPath: input.specPath,
      statusOutput: input.specBundle.originalSpec.status_output,
      receiptOutput: input.specBundle.originalSpec.receipt_output,
    });
  }
}

async function resolveReadOnlyV2RuntimeAuthenticationContext(input: {
  readonly originalSpec: AutopilotUnitSpecV2;
  readonly specPath: string;
  readonly env: ProcessEnv;
}): Promise<ActiveAutopilotContext> {
  const runtimeRoot = deriveStrictV2ArtifactRoot(input.originalSpec);
  const mainWorktreePath = mainWorktreePathFromV2RuntimeRoot(runtimeRoot, input.originalSpec.workstream);
  let repo: ActiveAutopilotContext['repo'];
  try {
    repo = resolveRepoIdentity(mainWorktreePath);
  } catch (error) {
    throw new Error(`unit_spec.v2 runtime main worktree is not an authenticated readable git worktree before preflight: ${mainWorktreePath}; ${errorMessage(error)}`);
  }
  const stateRoot = resolveAutopilotStateRoot(input.env);
  const coordinationRoot = coordinationRootForRepo(repo.repoKey, input.env);
  const activeRows = coordinationCutoverCommitted(stateRoot, repo.repoKey)
    ? await readCoordinatorActiveAutopilots(repo, worktreeRootForRepo(repo.repoKey, input.env), input.env)
    : await readActiveAutopilots(coordinationRoot);
  const matchingRows = activeRows.filter((row) => {
    if (row.repo_key !== repo.repoKey || row.workstream !== input.originalSpec.workstream || row.status !== 'active') return false;
    if (!sameExistingPath(row.main_worktree_path, mainWorktreePath)) return false;
    return normalizeFsPath(row.runtime_root) === normalizeFsPath(runtimeRoot);
  });
  if (matchingRows.length === 0) {
    throw new Error(`no active run/resource authenticates unit_spec.v2 runtime root before preflight: repo=${repo.repoKey} workstream=${input.originalSpec.workstream} main=${mainWorktreePath}`);
  }
  if (matchingRows.length > 1) {
    throw new Error(`multiple active run/resources authenticate unit_spec.v2 runtime root before preflight: ${matchingRows.map((row) => row.workstream_run).join(', ')}`);
  }
  const active = matchingRows[0];
  if (active === undefined) throw new Error('matched active run/resource disappeared before v2 authentication');
  const issues: string[] = [];
  if (!isPathWithinRoot(active.runtime_root, input.originalSpec.status_output)) issues.push('status_output outside active runtime root');
  if (!isPathWithinRoot(active.runtime_root, input.originalSpec.receipt_output)) issues.push('receipt_output outside active runtime root');
  if (!isPathWithinRoot(active.runtime_root, input.originalSpec.evidence_dir)) issues.push('evidence_dir outside active runtime root');
  if (!isPathWithinRoot(active.main_worktree_path, input.specPath)) issues.push('unit spec path outside active main worktree');
  if (normalizeFsPath(active.source_repo) === normalizeFsPath(active.main_worktree_path)) issues.push('active row source_repo equals main worktree path');
  if (issues.length > 0) throw new Error(`active run/resource does not authenticate unit_spec.v2 launch context: ${issues.join('; ')}`);
  return Object.freeze({
    repo,
    active,
    coordinationRoot,
    claimsPath: join(coordinationRoot, 'path-claims.json'),
    claimEventsPath: join(coordinationRoot, 'claim-events.jsonl'),
  });
}

function deriveStrictV2ArtifactRoot(spec: AutopilotUnitSpecV2): string {
  const candidates = [
    rootBeforeV2ArtifactSegment(spec.status_output, 'statuses'),
    rootBeforeV2ArtifactSegment(spec.receipt_output, 'receipts'),
    rootBeforeV2ArtifactSegment(spec.evidence_dir, 'evidence'),
  ].filter((candidate): candidate is string => candidate !== null);
  const unique = [...new Set(candidates.map(normalizeFsPath))];
  if (unique.length !== 1) {
    const diagnostic = unique.length === 0 ? 'no canonical statuses/receipts/evidence runtime root' : unique.join(', ');
    throw new Error(`unit_spec.v2 artifact paths do not identify one runtime root before preflight: ${diagnostic}`);
  }
  const [runtimeRoot] = unique;
  if (runtimeRoot === undefined) throw new Error('internal error: missing v2 runtime root');
  return runtimeRoot;
}

function rootBeforeV2ArtifactSegment(path: string, segment: 'statuses' | 'receipts' | 'evidence'): string | null {
  const normalized = normalizeFsPath(path).replace(/\\/gu, '/');
  const parts = normalized.split('/');
  const index = parts.lastIndexOf(segment);
  if (index <= 0) return null;
  const root = parts.slice(0, index).join('/');
  return root.length === 0 ? '/' : root;
}

function mainWorktreePathFromV2RuntimeRoot(runtimeRoot: string, workstream: string): string {
  const normalized = normalizeFsPath(runtimeRoot).replace(/\\/gu, '/');
  const suffix = `/.pi/autopilot/${workstream}`;
  if (!normalized.endsWith(suffix)) throw new Error(`unit_spec.v2 runtime root does not end with ${suffix}`);
  const main = normalized.slice(0, normalized.length - suffix.length);
  if (main.length === 0) throw new Error('unit_spec.v2 runtime root does not contain a main worktree path');
  return main;
}

function sameExistingPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function normalizeFsPath(path: string): string {
  return resolve(path);
}

type AuthenticatedPreRunSelection = NonNullable<Awaited<ReturnType<typeof recoverRuntimeRosterSelection>>['selection']>;

type AuthenticatedV2SpecRosterBinding = {
  readonly identity: AutopilotRosterExecutionIdentity;
};

async function authenticateV2SpecAgainstSelectionOrTransition(input: {
  readonly stateRoot: string | undefined;
  readonly runtimeContext: ActiveAutopilotContext;
  readonly originalSpec: AutopilotUnitSpecV2;
  readonly specPath: string;
}): Promise<AuthenticatedV2SpecRosterBinding> {
  const active = input.runtimeContext.active;
  const selection = await recoverImmutableV2Selection({
    stateRoot: input.stateRoot,
    mainWorktreeRoot: active.main_worktree_path,
    workstream: input.originalSpec.workstream,
    repoId: active.repo_key,
    workstreamRun: active.workstream_run,
  });
  const fromRef = savedRosterRefForSelection({ selection, stateRoot: input.stateRoot, trustedProjectRoot: active.source_repo });
  const chain = await resolveCommittedExistingRunRosterTransitionChain({
    ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }),
    run: {
      repo_id: active.repo_key,
      workstream: active.workstream,
      workstream_run: active.workstream_run,
      main_worktree_path: active.main_worktree_path,
      runtime_root: active.runtime_root,
      source_repo: active.source_repo,
    },
    initial_from_roster: fromRef,
  });
  if (!chain.ok) throw new Error(`committed roster transition chain failed authentication: ${chain.diagnostics.map((diagnostic) => diagnostic.code).join(', ')}`);

  if (v2SpecMatchesImmutableSelection(input.originalSpec, selection)) {
    if (chain.terminal_successor_attempt_authority !== null) throw new Error('old FROM-roster unit_spec.v2 launches are rejected after a committed roster transition');
    const roster = await readAuthenticatedRosterForSelection({
      selection,
      trustedProjectRoot: active.source_repo,
      stateRoot: input.stateRoot,
    });
    const facts = resolvePinnedRoleRuntimeFacts({
      selection,
      roster,
      role: input.originalSpec.role,
      request_profile: input.originalSpec.request_profile,
    });
    assertUnitSpecMatchesPinnedFacts(input.originalSpec, facts);
    return { identity: rosterIdentityFromSpecAndRequestProfile(input.originalSpec) };
  }

  const authority = chain.terminal_successor_attempt_authority;
  if (authority === null) throw new Error('unit_spec.v2 roster identity differs from immutable pre-run selection without a committed transition');
  if (input.originalSpec.pre_run_selection_sha256 !== selection.selection_sha256) throw new Error('transitioned unit_spec.v2 must keep pre_run_selection_sha256 bound to the immutable FROM selection');
  await assertTransitionContextRefMatchesSpec({ spec: input.originalSpec, runtimeRoot: active.runtime_root, authority });
  const targetRoster = await readAuthenticatedRosterForSavedRef({ ref: authority.to_roster, stateRoot: input.stateRoot, trustedProjectRoot: active.source_repo });
  assertTransitionedUnitSpecMatchesTargetRoster({ spec: input.originalSpec, selection, targetRoster, toRef: authority.to_roster });
  const maxFromAttempt = await maxFromRosterAttemptForUnit({ runtimeRoot: active.runtime_root, unitId: input.originalSpec.unit_id, fromSelection: selection });
  if (input.originalSpec.attempt <= maxFromAttempt) throw new Error(`transition successor attempt must be newer than max FROM-roster attempt ${String(maxFromAttempt)} for unit ${input.originalSpec.unit_id}`);
  if (!isCentrallyTrustedW4CertifiedRoster(targetRoster)) throw new Error('transition target roster is not centrally trusted W4-certified launch authority');
  return { identity: rosterIdentityFromSpecAndRequestProfile(input.originalSpec) };
}

async function recoverImmutableV2Selection(input: {
  readonly stateRoot: string | undefined;
  readonly mainWorktreeRoot: string;
  readonly workstream: string;
  readonly repoId: string;
  readonly workstreamRun: string;
}): Promise<AuthenticatedPreRunSelection> {
  const recovery = await recoverRuntimeRosterSelection({
    ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }),
    mainWorktreeRoot: input.mainWorktreeRoot,
    workstream: input.workstream,
    repo_id: input.repoId,
    workstream_run: input.workstreamRun,
    spec_identity: null,
    require_spec_identity: false,
    roster_file_state: 'present',
  });
  if (recovery.ok && recovery.selection !== null) return recovery.selection;
  const mirrorPath = runtimeRosterSnapshotPath({ mainWorktreeRoot: input.mainWorktreeRoot, workstream: input.workstream });
  let mirrorBytes: Uint8Array;
  try {
    mirrorBytes = await readFile(mirrorPath);
  } catch (error) {
    throw new Error(`runtime roster mirror unavailable at ${mirrorPath}: ${errorMessage(error)}; ${formatRunSelectionDiagnostics(recovery.diagnostics)}`);
  }
  const mirrorSelection = parseCanonicalPreRunSelectionBytes(mirrorBytes);
  if (mirrorSelection.repo_id !== input.repoId || mirrorSelection.workstream_run !== input.workstreamRun) throw new Error('runtime roster mirror belongs to a foreign run');
  const externalMatches = await findExternalSelectionByteMatches({ stateRoot: input.stateRoot, selection: mirrorSelection, mirrorBytes });
  if (externalMatches.length !== 1) throw new Error(`external pre-run selection recovery found ${String(externalMatches.length)} exact mirror byte match(es); ${formatRunSelectionDiagnostics(recovery.diagnostics)}`);
  return mirrorSelection;
}

async function recoverAuthenticatedV2Selection(input: {
  readonly stateRoot: string | undefined;
  readonly mainWorktreeRoot: string;
  readonly workstream: string;
  readonly repoId: string;
  readonly workstreamRun: string;
  readonly originalSpec: AutopilotUnitSpecV2;
}): Promise<AuthenticatedPreRunSelection> {
  const specIdentity = {
    schema_version: input.originalSpec.schema_version,
    workstream: input.originalSpec.workstream,
    roster_id: input.originalSpec.roster_id,
    roster_revision: input.originalSpec.roster_revision,
    roster_sha256: input.originalSpec.roster_sha256 as RosterSha256,
    pre_run_selection_sha256: input.originalSpec.pre_run_selection_sha256 as RosterSha256,
  } as const;
  const recovery = await recoverRuntimeRosterSelection({
    ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }),
    mainWorktreeRoot: input.mainWorktreeRoot,
    workstream: input.workstream,
    repo_id: input.repoId,
    workstream_run: input.workstreamRun,
    spec_identity: specIdentity,
    roster_file_state: 'present',
  });
  if (recovery.ok && recovery.selection !== null) return recovery.selection;
  return await recoverSelectionFromExactMirrorAndExternalBytes({
    ...input,
    priorDiagnostics: recovery.diagnostics,
  });
}

async function recoverSelectionFromExactMirrorAndExternalBytes(input: {
  readonly stateRoot: string | undefined;
  readonly mainWorktreeRoot: string;
  readonly workstream: string;
  readonly repoId: string;
  readonly originalSpec: AutopilotUnitSpecV2;
  readonly priorDiagnostics: readonly RunSelectionDiagnostic[];
}): Promise<AuthenticatedPreRunSelection> {
  const mirrorPath = runtimeRosterSnapshotPath({ mainWorktreeRoot: input.mainWorktreeRoot, workstream: input.workstream });
  let mirrorBytes: Uint8Array;
  try {
    mirrorBytes = await readFile(mirrorPath);
  } catch (error) {
    throw new Error(`runtime roster mirror unavailable at ${mirrorPath}: ${errorMessage(error)}; ${formatRunSelectionDiagnostics(input.priorDiagnostics)}`);
  }
  const mirrorSelection = parseCanonicalPreRunSelectionBytes(mirrorBytes);
  const specIssues = v2SpecSelectionIssues(input.originalSpec, mirrorSelection, input.repoId, input.workstream);
  if (specIssues.length > 0) throw new Error(`runtime roster mirror does not authenticate unit_spec.v2: ${specIssues.join('; ')}`);
  const externalMatches = await findExternalSelectionByteMatches({ stateRoot: input.stateRoot, selection: mirrorSelection, mirrorBytes });
  if (externalMatches.length !== 1) {
    throw new Error(`external pre-run selection recovery found ${String(externalMatches.length)} exact mirror byte match(es); ${formatRunSelectionDiagnostics(input.priorDiagnostics)}`);
  }
  return mirrorSelection;
}

async function findExternalSelectionByteMatches(input: {
  readonly stateRoot: string | undefined;
  readonly selection: AuthenticatedPreRunSelection;
  readonly mirrorBytes: Uint8Array;
}): Promise<readonly string[]> {
  const paths = resolveRosterScopePaths({ scope: 'user', ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }) });
  const candidates = new Set<string>();
  try { candidates.add(preRunSelectionPath(paths, input.selection)); } catch { /* generated workstream ids can be outside the roster path grammar; directory scan remains exact-byte authoritative. */ }
  const repoSelectionsRoot = join(paths.selectionsRoot, input.selection.repo_id);
  try {
    for (const entry of await readdir(repoSelectionsRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) candidates.add(join(repoSelectionsRoot, entry.name));
    }
  } catch {
    // Missing external directory is reported as zero matches below.
  }
  const matches: string[] = [];
  for (const candidate of candidates) {
    try {
      const read = await readAuthorityFileIfPresent(candidate, paths.userStateRoot);
      if (read !== null && bytesEqual(read.bytes, input.mirrorBytes)) matches.push(candidate);
    } catch {
      // Ignore disappearing or unsafe candidates; exact safe-read match count remains fail-closed.
    }
  }
  return Object.freeze(matches.sort());
}

function v2SpecSelectionIssues(
  spec: AutopilotUnitSpecV2,
  selection: AuthenticatedPreRunSelection,
  repoId: string,
  workstream: string,
): readonly string[] {
  const issues: string[] = [];
  if (selection.repo_id !== repoId) issues.push('selection.repo_id does not match active runtime repo');
  if (spec.workstream !== workstream) issues.push('unit_spec.v2 workstream does not match active runtime workstream');
  if (spec.pre_run_selection_sha256 !== selection.selection_sha256) issues.push('pre_run_selection_sha256 mismatch');
  if (spec.roster_id !== selection.roster_id) issues.push('roster_id mismatch');
  if (spec.roster_revision !== selection.roster_revision) issues.push('roster_revision mismatch');
  if (spec.roster_sha256 !== selection.roster_sha256) issues.push('roster_sha256 mismatch');
  return Object.freeze(issues);
}

async function readAuthenticatedRosterForSelection(input: {
  readonly selection: AuthenticatedPreRunSelection;
  readonly trustedProjectRoot: string;
  readonly stateRoot: string | undefined;
}): Promise<ReturnType<typeof parseAutopilotRoster>> {
  const paths = input.selection.scope === 'trusted-project'
    ? resolveRosterScopePaths({ scope: 'trusted-project', ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }), trustedProjectRoot: input.trustedProjectRoot })
    : resolveRosterScopePaths({ scope: 'user', ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }) });
  const rosterPath = rosterRevisionPath(paths, input.selection);
  const read = await readAuthorityFileIfPresent(rosterPath, paths.authorityRoot);
  if (read === null) throw new Error(`roster authority is missing or unsafe at ${rosterPath}`);
  const roster = parseAutopilotRoster(JSON.parse(Buffer.from(read.bytes).toString('utf8')) as unknown);
  const computedRosterHash = computeAutopilotRosterContractObjectHash('autopilot.roster.v1', roster);
  const issues: string[] = [];
  if (computedRosterHash !== roster.roster_sha256) issues.push('roster object hash does not match roster.roster_sha256');
  if (roster.roster_sha256 !== input.selection.roster_sha256) issues.push('roster_sha256 does not match recovered pre-run selection');
  if (roster.assignment_set_sha256 !== input.selection.assignment_set_sha256) issues.push('assignment_set_sha256 does not match recovered pre-run selection');
  if (issues.length > 0) throw new Error(issues.join('; '));
  return roster;
}

function v2SpecMatchesImmutableSelection(spec: AutopilotUnitSpecV2, selection: AuthenticatedPreRunSelection): boolean {
  return spec.pre_run_selection_sha256 === selection.selection_sha256 &&
    spec.roster_id === selection.roster_id &&
    spec.roster_revision === selection.roster_revision &&
    spec.roster_sha256 === selection.roster_sha256;
}

function rosterIdentityFromSpecAndRequestProfile(spec: AutopilotUnitSpecV2): AutopilotRosterExecutionIdentity {
  return Object.freeze({
    schema_version: 'autopilot.roster_execution_identity.v1' as const,
    roster_id: spec.roster_id,
    roster_revision: spec.roster_revision,
    roster_sha256: spec.roster_sha256 as `sha256:${string}`,
    assignment_sha256: spec.assignment_sha256 as `sha256:${string}`,
    pre_run_selection_sha256: spec.pre_run_selection_sha256 as `sha256:${string}`,
    request_profile: spec.request_profile,
    request_profile_sha256: spec.request_profile.request_profile_sha256 as `sha256:${string}`,
  });
}

async function assertTransitionContextRefMatchesSpec(input: {
  readonly spec: AutopilotUnitSpecV2;
  readonly runtimeRoot: string;
  readonly authority: ExistingRunRosterSuccessorAttemptAuthority;
}): Promise<void> {
  const ref = input.spec.context_refs.find((candidate) => candidate.path === input.authority.runtime_transition_ref) ?? null;
  if (ref === null) throw new Error('transitioned unit_spec.v2 lacks exact roster-transition context_ref');
  const transitionPath = join(input.runtimeRoot, input.authority.runtime_transition_ref);
  const read = await readAuthorityFileIfPresent(transitionPath, dirname(transitionPath));
  if (read === null) throw new Error('transition context_ref runtime authority is missing or unsafe');
  const bytes = read.bytes;
  const sha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (ref.sha256 !== input.authority.transition_artifact_sha256 || ref.sha256 !== sha) throw new Error('transition context_ref sha256 does not match exact runtime transition artifact bytes');
  if (ref.byte_count !== bytes.byteLength) throw new Error('transition context_ref byte_count does not match exact runtime transition artifact bytes');
  if (!ref.purpose.includes(input.authority.transition_id)) throw new Error('transition context_ref purpose is not bound to the transition id');
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  if (autopilotRosterContractCanonicalJson(parsed) !== Buffer.from(bytes).toString('utf8')) throw new Error('transition context_ref artifact is not canonical bytes');
}

async function readAuthenticatedRosterForSavedRef(input: {
  readonly ref: AutopilotSavedRosterRefV1;
  readonly stateRoot: string | undefined;
  readonly trustedProjectRoot: string;
}): Promise<ReturnType<typeof parseAutopilotRoster>> {
  const candidates = [
    resolveRosterScopePaths({ scope: 'user', ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }) }),
    resolveRosterScopePaths({ scope: 'trusted-project', ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }), trustedProjectRoot: input.trustedProjectRoot }),
  ];
  const matches: ReturnType<typeof parseAutopilotRoster>[] = [];
  for (const paths of candidates) {
    try {
      const rosterPath = rosterRevisionPath(paths, input.ref);
      const read = await readAuthorityFileIfPresent(rosterPath, paths.authorityRoot);
      if (read === null) continue;
      const roster = parseAutopilotRoster(JSON.parse(Buffer.from(read.bytes).toString('utf8')) as unknown);
      const computedRosterHash = computeAutopilotRosterContractObjectHash('autopilot.roster.v1', roster);
      if (
        computedRosterHash === roster.roster_sha256 &&
        roster.roster_id === input.ref.roster_id &&
        roster.roster_revision === input.ref.roster_revision &&
        roster.roster_sha256 === input.ref.roster_sha256 &&
        roster.assignment_set_sha256 === input.ref.assignment_set_sha256
      ) matches.push(roster);
    } catch {
      // Try the other immutable authority scope; exact match count below is authoritative.
    }
  }
  if (matches.length !== 1) throw new Error(`saved target roster ref resolved to ${String(matches.length)} authenticated roster file(s)`);
  const roster = matches[0];
  if (roster === undefined) throw new Error('saved target roster match disappeared');
  return roster;
}

function assertTransitionedUnitSpecMatchesTargetRoster(input: {
  readonly spec: AutopilotUnitSpecV2;
  readonly selection: AuthenticatedPreRunSelection;
  readonly targetRoster: ReturnType<typeof parseAutopilotRoster>;
  readonly toRef: AutopilotSavedRosterRefV1;
}): void {
  const { spec, targetRoster } = input;
  if (targetRoster.roster_id !== input.toRef.roster_id || targetRoster.roster_revision !== input.toRef.roster_revision || targetRoster.roster_sha256 !== input.toRef.roster_sha256 || targetRoster.assignment_set_sha256 !== input.toRef.assignment_set_sha256) throw new Error('transition target roster file does not match transition to_roster ref');
  if (spec.pre_run_selection_sha256 !== input.selection.selection_sha256) throw new Error('transitioned unit_spec.v2 pre_run_selection_sha256 must match immutable FROM selection');
  if (spec.roster_id !== targetRoster.roster_id || spec.roster_revision !== targetRoster.roster_revision || spec.roster_sha256 !== targetRoster.roster_sha256) throw new Error('transitioned unit_spec.v2 roster tuple does not match terminal TO roster');
  const assignment = targetRoster.assignments.find((entry) => entry.role === spec.role);
  if (assignment === undefined) throw new Error(`terminal TO roster lacks role assignment ${spec.role}`);
  if (spec.assignment_sha256 !== assignment.assignment_sha256) throw new Error('transitioned unit_spec.v2 assignment_sha256 does not match terminal TO roster role');
  assertRequestProfileMatchesAssignment(spec.request_profile, assignment);
  if (spec.model !== spec.request_profile.model || spec.thinking !== spec.request_profile.thinking) throw new Error('transitioned unit_spec.v2 model/thinking does not match target request_profile');
}

async function maxFromRosterAttemptForUnit(input: {
  readonly runtimeRoot: string;
  readonly unitId: string;
  readonly fromSelection: AuthenticatedPreRunSelection;
}): Promise<number> {
  let max = 0;
  for (const root of ['unit-specs', 'receipts']) {
    const dir = join(input.runtimeRoot, root);
    let files: readonly string[];
    try { files = await listJsonFiles(dir); }
    catch { continue; }
    for (const path of files) {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
        if (!isJsonRecord(parsed) || parsed['schema_version'] !== (root === 'unit-specs' ? 'autopilot.unit_spec.v2' : 'autopilot.receipt.v2')) continue;
        const unitId = typeof parsed['unit_id'] === 'string' ? parsed['unit_id'] : null;
        const attempt = typeof parsed['attempt'] === 'number' ? parsed['attempt'] : 0;
        if (unitId !== input.unitId || !Number.isSafeInteger(attempt)) continue;
        if (
          parsed['pre_run_selection_sha256'] === input.fromSelection.selection_sha256 &&
          parsed['roster_id'] === input.fromSelection.roster_id &&
          parsed['roster_revision'] === input.fromSelection.roster_revision &&
          parsed['roster_sha256'] === input.fromSelection.roster_sha256
        ) max = Math.max(max, attempt);
      } catch {
        throw new Error(`invalid runtime ${root} artifact blocks transition attempt freshness: ${path}`);
      }
    }
  }
  return max;
}

async function listJsonFiles(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && path.endsWith('.json')) out.push(path);
    }
  }
  await visit(root);
  return Object.freeze(out.sort((left, right) => left.localeCompare(right)));
}

function formatRunSelectionDiagnostics(diagnostics: readonly { readonly code: string; readonly severity?: string }[]): string {
  if (diagnostics.length === 0) return 'no diagnostics';
  return diagnostics.map((diagnostic) => `${diagnostic.code}${diagnostic.severity === undefined ? '' : `:${diagnostic.severity}`}`).join(', ');
}

function isUnitSpecV2(value: AutopilotRuntimeUnitSpec): value is AutopilotUnitSpecV2 {
  return value.schema_version === 'autopilot.unit_spec.v2';
}

function isLegacyV1RuntimeSpecBundle(bundle: AutopilotAgentRunSpecBundle): boolean {
  return bundle.unitSpec.schema_version === 'autopilot.unit_spec.v1';
}

function requireSpecBundleUnitSpecV2(bundle: AutopilotAgentRunSpecBundle): AutopilotUnitSpecV2 {
  if (isUnitSpecV2(bundle.unitSpec)) return bundle.unitSpec;
  throw new Error('unit_spec.v2 roster execution identity cannot be attached to historical unit_spec.v1');
}

function assertV2LaunchQualityGate(spec: AutopilotUnitSpec | AutopilotUnitSpecV2): void {
  const issues: string[] = [];
  if (spec.quality_profile === undefined || spec.quality_profile === null) issues.push('quality_profile is required before child launch');
  if (spec.risk_level === undefined || spec.risk_level === null) issues.push('risk_level is required before child launch');
  if (spec.acceptance_criteria === undefined || spec.acceptance_criteria.length === 0) issues.push('acceptance_criteria must contain at least one criterion before child launch');
  if (spec.verification_plan === undefined || spec.verification_plan === null) issues.push('verification_plan is required before child launch');
  if (spec.closure_criteria === undefined || spec.closure_criteria.length === 0) issues.push('closure_criteria must contain at least one criterion before child launch');
  if ((spec.role === 'implement' || spec.role === 'fix') && spec.owned_paths.length === 0) issues.push(`${spec.role} specs require at least one owned path`);
  if ((spec.role === 'validate' || spec.role === 'bughunt') && spec.validation_commands.length === 0) issues.push(`${spec.role} specs require at least one validation command`);
  if (issues.length > 0) throw new Error(`Autopilot unit_spec.v2 failed launch quality gate: ${issues.join('; ')}`);
}

async function renderAndMaybeWritePromptForSpecBundle(input: {
  readonly specBundle: AutopilotAgentRunSpecBundle;
  readonly providerIdentity: AutopilotProviderIdentity;
  readonly forceSnapshot?: boolean;
  readonly coordinationAppendix?: string;
}): Promise<AutopilotRenderedPrompt> {
  if (input.specBundle.rosterExecutionIdentity === null) {
    return await renderAndMaybeWriteAutopilotPromptSnapshot({
      spec: input.specBundle.unitSpec,
      allowLegacyV1RuntimeSpec: isLegacyV1RuntimeSpecBundle(input.specBundle),
      ...(input.coordinationAppendix === undefined ? {} : { coordinationAppendix: input.coordinationAppendix }),
      ...(input.forceSnapshot === undefined ? {} : { forceSnapshot: input.forceSnapshot }),
    });
  }

  const spec = requireSpecBundleUnitSpecV2(input.specBundle);
  const forcedOutputContract: AutopilotForcedOutputContract = {
    tool_name: AUTOPILOT_STATUS_TOOL,
    schema_version: 'autopilot.status.v1',
    workstream: spec.workstream,
    unit_id: spec.unit_id,
    role: spec.role,
    attempt: spec.attempt,
    status_output: spec.status_output,
    receipt_output: spec.receipt_output,
    provider_identity: input.providerIdentity,
  };
  return await renderAndMaybeWriteAutopilotPromptSnapshot({
    spec,
    forcedOutputContract,
    ...(input.coordinationAppendix === undefined ? {} : { coordinationAppendix: input.coordinationAppendix }),
    ...(input.forceSnapshot === undefined ? {} : { forceSnapshot: input.forceSnapshot }),
  });
}

async function observeExecutionIdentityForRoster(input: {
  readonly specBundle: AutopilotAgentRunSpecBundle;
  readonly piResult: PiResult;
}): Promise<AutopilotObservedExecutionEvidence | null> {
  const rosterExecutionIdentity = input.specBundle.rosterExecutionIdentity;
  if (rosterExecutionIdentity === null) return null;
  const observation = await readExecutionObservationEvidence(input.piResult.artifacts.executionObservationPath);
  return observedExecutionEvidenceFromPiAndObservation({
    requestProfile: rosterExecutionIdentity.request_profile,
    piResult: input.piResult,
    observation,
  });
}

async function readExecutionObservationEvidence(path: string): Promise<AutopilotExecutionObservationV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`missing or unreadable child execution observation evidence at ${path}: ${errorMessage(error)}`);
  }
  const observation = parseAutopilotExecutionObservation(parsed);
  if (observation.diagnostics.length > 0) {
    throw new Error(`child execution observation was incomplete: ${observation.diagnostics.join('; ')}`);
  }
  if (observation.final_assistant_message === null) {
    throw new Error('child execution observation did not record a final assistant message');
  }
  return observation;
}

function observedExecutionEvidenceFromPiAndObservation(input: {
  readonly requestProfile: AutopilotRosterExecutionIdentity['request_profile'];
  readonly piResult: PiResult;
  readonly observation: AutopilotExecutionObservationV1;
}): AutopilotObservedExecutionEvidence {
  const final = input.piResult.finalAssistantMessage;
  if (final === null || final.provider === null || final.model === null || final.api === null) {
    throw new Error('Pi RPC stream did not expose final assistant provider/model/api metadata');
  }
  const observedFinal = input.observation.final_assistant_message;
  if (observedFinal === null) throw new Error('execution observation lacks final assistant metadata');
  const finalMismatches: string[] = [];
  if (observedFinal.provider !== final.provider) finalMismatches.push(`provider ${observedFinal.provider} != ${final.provider}`);
  if (observedFinal.model !== final.model) finalMismatches.push(`model ${observedFinal.model} != ${final.model}`);
  if (observedFinal.api !== final.api) finalMismatches.push(`api ${observedFinal.api} != ${final.api}`);
  if (finalMismatches.length > 0) throw new Error(`execution observation final assistant metadata differs from Pi RPC stream: ${finalMismatches.join('; ')}`);
  const route = deriveRoutePolicyFromObservedProviderApi(final.provider, final.api);
  if (route === null) throw new Error(`no provider-qualified route policy for observed provider/api ${final.provider}/${final.api}`);
  const routeMismatches: string[] = [];
  if (route.route_policy_id !== input.observation.execution_profile.route_policy_id) routeMismatches.push('route_policy_id');
  if (route.route_policy_revision !== input.observation.execution_profile.route_policy_revision) routeMismatches.push('route_policy_revision');
  if (routeMismatches.length > 0) throw new Error(`execution observation route policy was not derived from final provider/api at ${routeMismatches.join(', ')}`);
  const thinking = input.piResult.thinkingLevel;
  if (thinking !== 'high' && thinking !== 'xhigh') throw new Error(`Pi RPC state did not expose a supported final thinking level: ${formatNullable(thinking)}`);
  const activeModel = input.observation.active_model;
  const requestedModelId = activeModel?.id ?? input.piResult.initialStateModel?.model ?? final.model;
  if (requestedModelId === null || requestedModelId.length === 0) throw new Error('execution observation did not expose requested model id');
  return Object.freeze({
    provider_id: final.provider,
    requested_model_id: requestedModelId,
    executed_model_id: final.model,
    api: final.api as AutopilotObservedExecutionEvidence['api'],
    thinking,
    service_tier: input.observation.execution_profile.service_tier,
    cache_policy: input.observation.execution_profile.cache_policy,
    system_prompt_profile: input.observation.execution_profile.system_prompt_profile,
    system_prompt_sha256: input.observation.execution_profile.system_prompt_sha256,
    route_policy_id: input.observation.execution_profile.route_policy_id,
    route_policy_revision: input.observation.execution_profile.route_policy_revision,
    request_profile_sha256: input.requestProfile.request_profile_sha256 as `sha256:${string}`,
    final_model_metadata: Object.freeze({
      provider: final.provider,
      model: final.model,
      api: final.api,
      stopReason: final.stopReason,
      observation_source: input.observation.source,
    }),
  });
}

async function materializeTerminalAcceptanceInputs(input: {
  readonly specBundle: AutopilotAgentRunSpecBundle;
  readonly specPath: string;
  readonly receipt: AutopilotStatusReceipt;
}): Promise<{ readonly specPath: string; readonly receiptPath: string; readonly receipt: AutopilotStatusReceipt }> {
  return { specPath: input.specPath, receiptPath: input.specBundle.unitSpec.receipt_output, receipt: input.receipt };
}

interface RuntimePreflightResult {
  readonly context: ActiveAutopilotContext;
  readonly authority: AutopilotAuthorityArtifact;
  readonly acquiredClaims: readonly AutopilotPathClaim[];
  readonly coordinatorGroup: CoordinationAcquisitionGroup | null;
  readonly attemptSpec: { readonly ref: string; readonly sha256: `sha256:${string}` };
}

interface RuntimePreflightOptions {
  readonly skipStaleOutputCheck?: boolean;
  readonly skipClaimAcquire?: boolean;
  readonly skipSagaRecovery?: boolean;
  readonly env?: ProcessEnv;
}

async function preflightSpec(
  specBundle: AutopilotAgentRunSpecBundle,
  specPath: string,
  options: RuntimePreflightOptions = {},
): Promise<RuntimePreflightResult> {
  const spec = requireAuthenticatedAuthoritySpec(specBundle, specPath);
  const preparedWorktree = await prepareMissingSourceChangingUnitWorktree(spec, options.env ?? process.env, options.skipSagaRecovery === true);
  try {
    return await preflightSpecAfterWorktreePreparation(specBundle, specPath, options);
  } catch (error) {
    if (preparedWorktree.created) {
      try {
        await rollbackCreatedUnitWorktree({ active: preparedWorktree.active, unitId: preparedWorktree.unitId, attempt: preparedWorktree.attempt, reason: `${AUTOPILOT_PREFLIGHT_ROLLBACK_REASON_PREFIX} ${errorMessage(error)}`, env: options.env ?? process.env });
      } catch (rollbackError) {
        throw preflightRollbackFailure(spec, specPath, error, rollbackError);
      }
    }
    throw error;
  }
}

async function preflightSpecAfterWorktreePreparation(
  specBundle: AutopilotAgentRunSpecBundle,
  specPath: string,
  options: RuntimePreflightOptions = {},
): Promise<RuntimePreflightResult> {
  const spec = requireAuthenticatedAuthoritySpec(specBundle, specPath);
  try {
    await access(spec.cwd, fsConstants.R_OK);
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: `cwd is not an accessible directory before model spend: ${spec.cwd}; ${errorMessage(error)}`,
      specPath,
    });
  }

  let runtimeContext: ActiveAutopilotContext;
  try {
    runtimeContext = await resolveActiveAutopilotForSpec(spec, options.env ?? process.env);
    if (options.skipSagaRecovery !== true && (options.env ?? process.env)[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] !== undefined) await recoverAutopilotWorktreeSagas({ active: runtimeContext.active, env: options.env ?? process.env });
    await ensureWorktreeCleanForLaunch({ spec, context: runtimeContext });
  } catch (error) {
    if (error instanceof AutopilotParallelRuntimeError) {
      throw new AutopilotAgentRunError('spec-invalid', {
        reason: error.message,
        specPath,
        statusOutput: spec.status_output,
        receiptOutput: spec.receipt_output,
      });
    }
    throw error;
  }

  let authority: AutopilotAuthorityArtifact;
  try {
    authority = await deriveAutopilotAuthority({ spec });
    if (options.skipClaimAcquire !== true) await persistAutopilotAuthority(runtimeContext.active.runtime_root, authority);
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', { reason: errorMessage(error), specPath, statusOutput: spec.status_output, receiptOutput: spec.receipt_output });
  }

  if (options.skipStaleOutputCheck !== true) {
    for (const [label, path] of [
      ['status_output', spec.status_output],
      ['receipt_output', spec.receipt_output],
    ] as const) {
      if (existsSync(path)) {
        throw new AutopilotAgentRunError('spec-invalid', {
          reason: `${label} already exists; refusing stale forced-output path ${path}`,
          specPath,
          statusOutput: spec.status_output,
          receiptOutput: spec.receipt_output,
        });
      }
    }
  }

  if (options.skipClaimAcquire !== true) {
    await assertAutopilotSpecMaterializationDiskGate({
      context: runtimeContext,
      spec: specBundle.unitSpec,
      authority,
      allowLegacyV1RuntimeSpec: isLegacyV1RuntimeSpecBundle(specBundle),
    }).catch((error: unknown) => {
      if (error instanceof Error) {
        throw new AutopilotAgentRunError('spec-invalid', {
          reason: error.message,
          specPath,
          statusOutput: spec.status_output,
          receiptOutput: spec.receipt_output,
        });
      }
      throw error;
    });
  }

  const coordinatorMode = options.skipClaimAcquire !== true && runtimeContext.active.coordination_authority === 'coordinator-edit-leases-v1';
  const cutoverCommitted = coordinationCutoverCommitted(resolveAutopilotStateRoot(options.env ?? process.env), runtimeContext.active.repo_key);
  if (coordinatorMode && !cutoverCommitted) {
    const forbiddenLegacyClaims = (await readPathClaims(runtimeContext.coordinationRoot)).filter((claim) => claim.autopilot_id === runtimeContext.active.autopilot_id && claim.workstream_run === runtimeContext.active.workstream_run);
    if (forbiddenLegacyClaims.length > 0) throw new AutopilotAgentRunError('spec-invalid', {
      reason: `coordinator-edit-lease authoritative run has forbidden legacy claims: ${forbiddenLegacyClaims.map((claim) => `${claim.claim_type}:${claim.path}`).join(', ')}`,
      specPath,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
    });
  }
  if (coordinatorMode && (options.env ?? process.env)[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] === undefined) throw new AutopilotAgentRunError('spec-invalid', {
    reason: 'coordinator-edit-lease authoritative run is missing its durable coordinator session; refusing legacy claim fallback',
    specPath,
    statusOutput: spec.status_output,
    receiptOutput: spec.receipt_output,
  });
  const attemptSpecRef = relative(runtimeContext.active.main_worktree_path, specPath).replace(/\\/gu, '/');
  if (attemptSpecRef.length === 0 || attemptSpecRef.startsWith('../') || attemptSpecRef.startsWith('/')) throw new AutopilotAgentRunError('spec-invalid', { reason: 'unit spec must remain inside the durable run main worktree', specPath });
  const attemptSpecBytes = await readFile(specPath);
  const attemptSpec = { ref: attemptSpecRef, sha256: `sha256:${createHash('sha256').update(attemptSpecBytes).digest('hex')}` as const };

  let coordinatorGroup: CoordinationAcquisitionGroup | null = null;
  const acquiredClaims = options.skipClaimAcquire === true
    ? []
    : coordinatorMode
      ? await acquireCoordinatorClaimsForUnit({ context: runtimeContext, spec, authority, specPath, env: options.env ?? process.env }).then((result) => {
          coordinatorGroup = result.group;
          return result.claims;
        })
      : await acquireClaimsForUnit({ context: runtimeContext, spec, authority, reason: 'autopilot-agent-run preflight' }).catch((error: unknown) => {
          if (error instanceof AutopilotParallelRuntimeError) {
            throw new AutopilotAgentRunError('spec-invalid', {
              reason: error.message,
              specPath,
              statusOutput: spec.status_output,
              receiptOutput: spec.receipt_output,
            });
          }
          throw error;
        });

  try {
    if (options.skipClaimAcquire !== true) await assertD65OrdinaryBoundaryFromEnvironment('post-acquisition-output', options.env ?? process.env);
    await mkdir(dirname(spec.status_output), { recursive: true });
    await mkdir(dirname(spec.receipt_output), { recursive: true });
    await mkdir(spec.evidence_dir, { recursive: true });
    if (options.skipClaimAcquire !== true) {
      await assertD65OrdinaryBoundaryFromEnvironment('post-acquisition-output', options.env ?? process.env);
      await materializeAutopilotSpecPaths({
        context: runtimeContext,
        spec: specBundle.unitSpec,
        authority,
        reason: 'autopilot-agent-run preflight materialization',
        allowLegacyV1RuntimeSpec: isLegacyV1RuntimeSpecBundle(specBundle),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    }
    const verifiedSpecBytes = await readFile(specPath);
    const verifiedSpecSha = `sha256:${createHash('sha256').update(verifiedSpecBytes).digest('hex')}`;
    if (verifiedSpecSha !== attemptSpec.sha256) throw new AutopilotAgentRunError('spec-invalid', { reason: 'unit spec changed after authority derivation; prelaunch authority was rolled back', specPath, statusOutput: spec.status_output, receiptOutput: spec.receipt_output });
    return { context: runtimeContext, authority, acquiredClaims, coordinatorGroup, attemptSpec };
  } catch (error) {
    try {
      if (coordinatorGroup !== null) {
        const negotiation = await ClaimNegotiationClient.fromEnvironment(options.env ?? process.env);
        await negotiation.cancelGroup({ group: coordinatorGroup, reason: 'autopilot-agent-run post-acquisition prelaunch rollback' });
      } else if (acquiredClaims.length > 0) {
        await releaseClaimsForUnit({ context: runtimeContext, unitId: spec.unit_id, attempt: spec.attempt, reason: 'autopilot-agent-run post-acquisition prelaunch rollback' });
      }
    } catch (rollbackError) {
      throw new AutopilotAgentRunError('runtime-commit-failed', { reason: `prelaunch failed (${errorMessage(error)}) and authority rollback failed: ${errorMessage(rollbackError)}`, specPath, statusOutput: spec.status_output, receiptOutput: spec.receipt_output });
    }
    if (error instanceof AutopilotAgentRunError) throw error;
    throw new AutopilotAgentRunError('spec-invalid', { reason: errorMessage(error), specPath, statusOutput: spec.status_output, receiptOutput: spec.receipt_output });
  }
}

async function acquireCoordinatorClaimsForUnit(input: {
  readonly context: ActiveAutopilotContext;
  readonly spec: AutopilotUnitSpec;
  readonly authority: AutopilotAuthorityArtifact;
  readonly specPath: string;
  readonly env: ProcessEnv;
}): Promise<{ readonly claims: readonly AutopilotPathClaim[]; readonly group: CoordinationAcquisitionGroup | null }> {
  const relativeSpec = relative(input.context.active.main_worktree_path, input.specPath).replace(/\\/gu, '/');
  if (relativeSpec.length === 0 || relativeSpec.startsWith('../') || relativeSpec.startsWith('/')) throw new AutopilotAgentRunError('spec-invalid', { reason: 'coordinator-backed unit spec must be inside the durable run main worktree', specPath: input.specPath });
  const specBytes = await readFile(input.specPath);
  const specSha256 = `sha256:${createHash('sha256').update(specBytes).digest('hex')}` as const;
  const requested = new Map<string, { readonly path: string; readonly mode: 'READ' | 'WRITE' | 'EXCLUSIVE'; readonly purpose: string; readonly source_identity?: AutopilotAuthorityArtifact['observations'][number]['source_identity']; readonly exclusive_operation?: AutopilotAuthorityArtifact['exclusives'][number]['operation'] }>();
  for (const observation of input.authority.observations) requested.set(`READ\0${observation.path}`, { path: observation.path, mode: 'READ', purpose: observation.purpose, source_identity: observation.source_identity });
  for (const edit of input.authority.edit_intentions) requested.set(`WRITE\0${edit.path}`, { path: edit.path, mode: 'WRITE', purpose: edit.purpose });
  for (const exclusive of input.authority.exclusives) requested.set(`EXCLUSIVE\0${exclusive.path}`, { path: exclusive.path, mode: 'EXCLUSIVE', purpose: exclusive.purpose, exclusive_operation: exclusive.operation });
  if (requested.size === 0) return { claims: [], group: null };
  const reservationView = await (await ReservationCoordinationClient.fromEnvironment(input.env)).view();
  const reservationBlockers = reservationSchedulingBlockers({ workstreamRun: input.context.active.workstream_run, requestedPaths: [...requested.values()].filter((entry) => entry.mode !== 'READ').map((entry) => entry.path), view: reservationView });
  if (reservationBlockers.ordering.length > 0 || reservationBlockers.integration.length > 0) throw new AutopilotAgentRunError('waiting-for-peer-release', {
    reason: `reservation coordination blocks dispatch: ${[...reservationBlockers.ordering, ...reservationBlockers.integration].join('; ')}`,
    specPath: input.specPath,
    statusOutput: input.spec.status_output,
    receiptOutput: input.spec.receipt_output,
  });
  const groupId = `group-${createHash('sha256').update(`${input.context.active.repo_key}\0${input.context.active.workstream_run}\0${input.spec.unit_id}\0${String(input.spec.attempt)}\0${specSha256}`, 'utf8').digest('hex')}`;
  const sourceChanging = input.spec.role === 'implement' || input.spec.role === 'fix';
  const result: ClaimGroupAcquisitionResult = await (await ClaimNegotiationClient.fromEnvironment(input.env)).acquire({
    acquisitionGroupId: groupId,
    unitId: input.spec.unit_id,
    attempt: input.spec.attempt,
    requestedLeases: [...requested.values()],
    reason: 'autopilot-agent-run complete initial authority preflight',
    normalReleaseCondition: sourceChanging
      ? { condition_type: 'unit-merged', target_id: `${input.spec.unit_id}:${String(input.spec.attempt)}`, evidence: null }
      : { condition_type: 'child-terminal', target_id: `child-${input.context.active.workstream_run}-${input.spec.unit_id}-${String(input.spec.attempt)}`, evidence: null },
    specRef: relativeSpec,
    specSha256,
    role: input.spec.role,
    preemptible: input.authority.exclusives.length === 0,
    checkpointOrdinal: 0,
  });
  if (result.outcome === 'waiting-for-peer-release') throw new AutopilotAgentRunError('waiting-for-peer-release', {
    reason: `complete lease set is waiting for peer release: ${result.requestRefs.join(', ')}`,
    specPath: input.specPath,
    statusOutput: input.spec.status_output,
    receiptOutput: input.spec.receipt_output,
  });
  const now = new Date().toISOString();
  const claims = [...result.observations.map((observation): AutopilotPathClaim => ({
    schema_version: 'autopilot.path_claim.v1',
    path: observation.path,
    autopilot_id: input.context.active.autopilot_id,
    workstream: input.context.active.workstream,
    workstream_run: input.context.active.workstream_run,
    unit_id: input.spec.unit_id,
    attempt: input.spec.attempt,
    claim_type: 'READ',
    acquired_at: now,
    active_run_epoch: input.context.active.active_run_epoch,
    reason: observation.purpose,
  })), ...result.editLeases.map((lease): AutopilotPathClaim => ({
    schema_version: 'autopilot.path_claim.v1',
    path: lease.path,
    autopilot_id: input.context.active.autopilot_id,
    workstream: input.context.active.workstream,
    workstream_run: input.context.active.workstream_run,
    unit_id: input.spec.unit_id,
    attempt: input.spec.attempt,
    claim_type: lease.mode,
    acquired_at: now,
    active_run_epoch: input.context.active.active_run_epoch,
    reason: lease.purpose,
  }))];
  return { claims, group: result.acquisitionGroup };
}

type MissingSourceChangingUnitWorktreePreparation =
  | { readonly created: false }
  | { readonly created: true; readonly active: ActiveAutopilotRow; readonly unitId: string; readonly attempt: number };

async function prepareMissingSourceChangingUnitWorktree(spec: AutopilotUnitSpec, env: ProcessEnv, skipSagaRecovery = false): Promise<MissingSourceChangingUnitWorktreePreparation> {
  if (spec.role !== 'implement' && spec.role !== 'fix') return { created: false };
  if (existsSync(spec.cwd)) return { created: false };
  const artifactRoot = deriveAutopilotArtifactRoot(spec);
  const runtimeSuffix = `${AUTOPILOT_RUNTIME_ROOT_MARKER}/${spec.workstream}`;
  if (!artifactRoot.endsWith(runtimeSuffix)) return { created: false };
  const mainWorktreePath = artifactRoot.slice(0, artifactRoot.length - runtimeSuffix.length);
  const taskRoot = dirname(mainWorktreePath);
  let taskInfo: JsonRecord;
  try {
    const parsed = JSON.parse(await readFile(resolve(taskRoot, '_task-info.json'), 'utf8')) as unknown;
    if (!isJsonRecord(parsed)) return { created: false };
    taskInfo = parsed;
  } catch {
    return { created: false };
  }
  const repoKey = taskInfo['repo_key'];
  if (typeof repoKey !== 'string' || repoKey.length === 0) return { created: false };
  const activeRows = coordinationCutoverCommitted(resolveAutopilotStateRoot(env), repoKey)
    ? (() => {
        const sourceRepo = taskInfo['source_repo'];
        if (typeof sourceRepo !== 'string') throw new AutopilotAgentRunError('spec-invalid', { reason: 'post-cutover task info lacks source_repo', statusOutput: spec.status_output, receiptOutput: spec.receipt_output });
        const repo = resolveRepoIdentity(sourceRepo);
        if (repo.repoKey !== repoKey) throw new AutopilotAgentRunError('spec-invalid', { reason: 'post-cutover task info repository identity mismatch', statusOutput: spec.status_output, receiptOutput: spec.receipt_output });
        return readCoordinatorActiveAutopilots(repo, worktreeRootForRepo(repoKey, env), env);
      })()
    : readActiveAutopilots(coordinationRootForRepo(repoKey, env));
  const active = (await activeRows).find((row) => row.workstream === spec.workstream && row.runtime_root === artifactRoot);
  if (active === undefined) return { created: false };
  if (!skipSagaRecovery && env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] !== undefined) await recoverAutopilotWorktreeSagas({ active, env });
  const expectedCwd = unitWorktreePathForActiveAutopilot(active, spec.unit_id, spec.attempt);
  if (resolve(spec.cwd) !== resolve(expectedCwd)) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: `source-changing Phase 2 unit cwd must be its deterministic unit worktree path ${expectedCwd}`,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
    });
  }
  await assertD65OrdinaryBoundaryFromEnvironment('missing-worktree-creation', env);
  const prepared = await prepareAutopilotUnitWorktree({ active, unitId: spec.unit_id, attempt: spec.attempt, unitSpec: spec, env });
  return prepared.created ? { created: true, active, unitId: spec.unit_id, attempt: spec.attempt } : { created: false };
}

function preflightRollbackFailure(spec: AutopilotUnitSpec, specPath: string, originalError: unknown, rollbackError: unknown): AutopilotAgentRunError {
  return new AutopilotAgentRunError('spec-invalid', {
    reason: `preflight failed before child launch (${errorMessage(originalError)}), and rollback of the newly-created unit worktree was blocked: ${errorMessage(rollbackError)}`,
    specPath,
    statusOutput: spec.status_output,
    receiptOutput: spec.receipt_output,
  });
}

const AUTOPILOT_RUNTIME_ROOT_MARKER = '/.pi/autopilot';

function timeoutMsForSpec(spec: AutopilotUnitSpec): number {
  return spec.timeout_seconds === undefined ? DEFAULT_AGENT_WALL_MS : spec.timeout_seconds * 1000;
}

function deriveAutopilotStatusContextPath(spec: AutopilotUnitSpec): string {
  return resolve(
    dirname(spec.receipt_output),
    `${spec.unit_id}.${spec.role}.attempt-${String(spec.attempt)}.context.json`,
  );
}

function deriveAutopilotExecutionObservationPath(spec: AutopilotUnitSpec): string {
  return resolve(
    spec.evidence_dir,
    `${spec.unit_id}.${spec.role}.attempt-${String(spec.attempt)}.execution-observation.json`,
  );
}

async function writeStatusContext(path: string, context: AutopilotStatusToolContext): Promise<void> {
  const parsed = parseAutopilotStatusToolContext(JSON.parse(JSON.stringify(context)) as unknown);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

async function writeAttemptAudit(
  specBundle: AutopilotAgentRunSpecBundle,
  context: ActiveAutopilotContext,
  authority: AutopilotAuthorityArtifact,
  baseline: AutopilotExecutionBaseline,
  statusEntry: AutopilotStatusEntry | null,
  auditPath: string,
  env: ProcessEnv,
): Promise<AutopilotExecutionAudit> {
  const allowLegacyV1RuntimeSpec = isLegacyV1RuntimeSpecBundle(specBundle);
  const readOnlyPaths = await expandedReadOnlyPathsForAudit({ context, spec: specBundle.unitSpec, authority, env, allowLegacyV1RuntimeSpec });
  return await writeAutopilotExecutionAudit({
    unitSpec: { ...specBundle.unitSpec, read_only_paths: readOnlyPaths },
    baseline,
    statusEntry,
    auditPath,
    allowLegacyV1RuntimeSpec,
  });
}

function resolvePiExecutable(env: ProcessEnv): string {
  const override = env[AUTOPILOT_AGENT_PI_EXECUTABLE_ENV];
  if (override !== undefined) {
    if (override.trim().length === 0) {
      throw new AutopilotAgentRunError('spec-invalid', {
        reason: `${AUTOPILOT_AGENT_PI_EXECUTABLE_ENV} must be non-empty when set`,
      });
    }
    return override;
  }
  return 'pi';
}

function toolPolicyForRole(role: AutopilotUnitSpec['role']): ToolPolicy {
  if (role === 'implement' || role === 'fix' || role === 'strategy' || role === 'adjudicate') {
    return ({
      builtinTools: (['read', 'grep', 'find', 'ls', 'bash', 'write', 'edit']),
      customTools: ([AUTOPILOT_STATUS_TOOL]),
      disableMutatingBash: false,
    });
  }
  return ({
    builtinTools: (['read', 'grep', 'find', 'ls', 'bash']),
    customTools: ([AUTOPILOT_STATUS_TOOL]),
    disableMutatingBash: true,
  });
}

function buildPiToolArgument(policy: ToolPolicy): string {
  return [...policy.builtinTools, ...policy.customTools].join(',');
}

function validateModelIdentity(model: string): void {
  try {
    buildAutopilotProviderIdentity(model, 'high');
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: errorMessage(error),
    });
  }
}

function validateSpawnExecutionProfile(spec: SpawnSpec): void {
  if (spec.requestProfile === undefined) {
    validateModelIdentity(spec.model);
    return;
  }
  try {
    const { provider, modelId } = splitAutopilotModelId(spec.model);
    const request = spec.requestProfile;
    const mismatches: string[] = [];
    if (provider !== request.provider_id) mismatches.push(`provider_id expected ${request.provider_id}, got ${provider}`);
    if (modelId !== request.model_id) mismatches.push(`model_id expected ${request.model_id}, got ${modelId}`);
    if (spec.model !== request.model) mismatches.push(`model expected ${request.model}, got ${spec.model}`);
    if (spec.thinking !== request.thinking) mismatches.push(`thinking expected ${request.thinking}, got ${spec.thinking}`);
    const route = deriveRoutePolicyFromObservedProviderApi(request.provider_id, request.api);
    if (route === null) mismatches.push(`route_policy ${request.route_policy_id}@${String(request.route_policy_revision)} has no provider-qualified Pi adapter for ${request.provider_id}/${request.api}`);
    else {
      if (route.route_policy_id !== request.route_policy_id) mismatches.push(`route_policy_id expected ${request.route_policy_id}, Pi adapter derives ${route.route_policy_id}`);
      if (route.route_policy_revision !== request.route_policy_revision) mismatches.push(`route_policy_revision expected ${String(request.route_policy_revision)}, Pi adapter derives ${String(route.route_policy_revision)}`);
    }
    if (request.service_tier !== null) mismatches.push(`Pi 0.80.6 cannot set request_profile.service_tier=${JSON.stringify(request.service_tier)} exactly before model spend`);
    if (request.cache_policy !== 'provider-default') mismatches.push(`Pi 0.80.6 cannot set request_profile.cache_policy=${JSON.stringify(request.cache_policy)} exactly before model spend`);
    if (request.system_prompt_profile !== 'pi-default.v1') mismatches.push(`Pi 0.80.6 cannot set request_profile.system_prompt_profile=${JSON.stringify(request.system_prompt_profile)} exactly before model spend`);
    if (mismatches.length > 0) throw new Error(mismatches.join('; '));
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: `roster request profile does not match an exactly applicable provider-qualified Pi execution adapter: ${errorMessage(error)}`,
    });
  }
}

async function runPiPromptWithStatusCarrier(spec: SpawnSpec, prompt: string): Promise<PiResult> {
  validateSpawnExecutionProfile(spec);
  const argv = [
    '--mode',
    'rpc',
    '--model',
    spec.model,
    '--thinking',
    spec.thinking,
    '--name',
    spec.name,
    '--no-session',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-extensions',
    '--approve',
    '--tools',
    buildPiToolArgument(spec.toolPolicy),
    '--extension',
    AUTOPILOT_AGENT_STATUS_EXTENSION_PATH,
    '--extension',
    AUTOPILOT_AGENT_EXECUTION_OBSERVER_EXTENSION_PATH,
  ];

  const env = sanitizeAgentEnv(spec.env, spec.contextPath, spec.executionObservationPath);
  let child: ChildProcessLite;
  try {
    child = spawn(spec.executable, argv, {
      cwd: spec.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    throw new AutopilotPiRunError(
      'spawn-failed',
      `Failed to start Pi executable ${JSON.stringify(spec.executable)}: ${errorMessage(error)}`,
    );
  }

  return await supervisePiRpcChild(child, spec, prompt);
}

function sanitizeAgentEnv(env: ProcessEnv, contextPath: string, executionObservationPath: string): ProcessEnv {
  const out: Record<string, string | undefined> = {
    ...env,
    [AUTOPILOT_STATUS_CONTEXT_ENV]: contextPath,
    [AUTOPILOT_EXECUTION_OBSERVATION_ENV]: executionObservationPath,
  };
  delete out[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
  delete out['PIPELINE_CODEX_CLI_EXECUTABLE'];
  delete out['PIPELINE_CODEX_CLI_MODEL'];
  return out;
}

function supervisePiRpcChild(
  child: ChildProcessLite,
  spec: SpawnSpec,
  prompt: string,
): Promise<PiResult> {
  return new Promise<PiResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    let stdoutBuffer = '';
    let stderrText = '';
    let lastState: JsonRecord | undefined;
    let lastMessage: JsonRecord | undefined;
    let lastAssistantMessage: JsonRecord | undefined;
    let turnCount = 0;
    let sawErrorEvent = false;
    const pendingCommands = new Map<string, PendingCommand>();
    const eventWaiters = new Map<string, Set<PendingEvent>>();
    const eventsByType = new Map<string, JsonRecord>();
    const toolResultCandidates: ToolResultCandidate[] = [];
    const errorMessages: string[] = [];
    const eventSummaries: JsonRecord[] = [];
    const responseSummaries: JsonRecord[] = [];

    const diagnostics = (): PiRunDiagnostics => ({
      errorMessages: ([...errorMessages]),
      stderrTail: tailText(stderrText),
      eventSummaries: (eventSummaries.slice(-10)),
      responseSummaries: (responseSummaries.slice(-10)),
    });

    const clearPending = (error: Error): void => {
      for (const pending of pendingCommands.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      pendingCommands.clear();
      for (const waiters of eventWaiters.values()) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        waiters.clear();
      }
      eventWaiters.clear();
    };

    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      spec.preemptionSignal.removeEventListener('abort', onPreemption);
      clearPending(error);
      if (!child.killed) child.kill('SIGTERM');
      rejectPromise(error);
    };

    const settleResolve = (result: PiResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      spec.preemptionSignal.removeEventListener('abort', onPreemption);
      clearPending(new AutopilotPiRunError('settled', 'Pi RPC supervisor settled'));
      child.stdin.end();
      if (!child.killed) child.kill('SIGTERM');
      resolvePromise(result);
    };

    const onPreemption = (): void => {
      settleReject(new AutopilotPiRunError('deadlock-preempted', 'Coordinator deadlock policy requested child stop and owner reset/quarantine', undefined, diagnostics()));
    };
    spec.preemptionSignal.addEventListener('abort', onPreemption, { once: true });
    if (spec.preemptionSignal.aborted) queueMicrotask(onPreemption);

    const wallTimer = setTimeout(() => {
      settleReject(new AutopilotPiRunError('wall-timeout', `Pi RPC wall timeout after ${String(spec.wallMs)} ms`, {
        timeoutMs: spec.wallMs,
      }, diagnostics()));
    }, spec.wallMs);

    const waitForEvent = (type: string, timeoutMs: number): Promise<JsonRecord> => {
      const existing = eventsByType.get(type);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<JsonRecord>((resolveEvent, rejectEvent) => {
        const waiter: PendingEvent = {
          resolve: resolveEvent,
          reject: rejectEvent,
          timer: setTimeout(() => {
            const waiters = eventWaiters.get(type);
            if (waiters !== undefined) {
              waiters.delete(waiter);
              if (waiters.size === 0) eventWaiters.delete(type);
            }
            rejectEvent(new AutopilotPiRunError('rpc-timeout', `timed out waiting for Pi RPC event ${type}`, {
              eventType: type,
              timeoutMs,
            }, diagnostics()));
          }, timeoutMs),
        };
        const current = eventWaiters.get(type);
        if (current === undefined) eventWaiters.set(type, new Set([waiter]));
        else current.add(waiter);
      });
    };

    const sendCommand = (type: string, body: JsonRecord = {}): Promise<RpcResponse> => {
      return new Promise<RpcResponse>((resolveCommand, rejectCommand) => {
        const id = `autopilot-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
        const command: RpcCommand = { ...body, type, id };
        const timer = setTimeout(() => {
          const pending = pendingCommands.get(id);
          if (pending === undefined) return;
          pendingCommands.delete(id);
          pending.reject(new AutopilotPiRunError('rpc-timeout', `Pi RPC command timeout: ${type}`, {
            command: type,
            id,
          }, diagnostics()));
        }, RPC_COMMAND_TIMEOUT_MS);
        pendingCommands.set(id, {
          resolve: resolveCommand,
          reject: rejectCommand,
          timer,
        });
        child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
          if (error === null || error === undefined) return;
          clearTimeout(timer);
          pendingCommands.delete(id);
          rejectCommand(new AutopilotPiRunError('rpc-write-error', `Failed to write Pi RPC command ${type}: ${error.message}`, {
            command: type,
            id,
          }, diagnostics()));
        });
      });
    };

    const handleResponse = (record: JsonRecord): void => {
      const id = typeof record['id'] === 'string' ? record['id'] : '';
      const pending = pendingCommands.get(id);
      const response = toRpcResponse(record);
      responseSummaries.push(projectResponse(response));
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      pendingCommands.delete(id);
      if (response.success) pending.resolve(response);
      else pending.reject(new AutopilotPiRunError('rpc-command-failed', response.error ?? `Pi RPC command ${response.command ?? response.id} failed`, {
        id: response.id,
      }, diagnostics()));
    };

    const handleEvent = (record: JsonRecord): void => {
      const type = typeof record['type'] === 'string' ? record['type'] : 'unknown';
      eventsByType.set(type, record);
      eventSummaries.push(projectEvent(record));
      if (record['isError'] === true) sawErrorEvent = true;
      if (typeof record['errorMessage'] === 'string') {
        sawErrorEvent = true;
        errorMessages.push(record['errorMessage']);
      }
      if (type === 'message_end' || type === 'turn_end') {
        const message = record['message'];
        if (isJsonRecord(message)) {
          lastMessage = message;
          if (message['role'] === 'assistant') lastAssistantMessage = message;
        }
        if (type === 'turn_end') turnCount += 1;
      }
      const statusToolCandidate = toStatusToolResultCandidate(record);
      if (statusToolCandidate !== null) toolResultCandidates.push(statusToolCandidate);
      const waiters = eventWaiters.get(type);
      if (waiters !== undefined) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(record);
        }
        waiters.clear();
        eventWaiters.delete(type);
      }
    };

    const parseLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch (error) {
        throw new AutopilotPiRunError('rpc-parse-error', `Failed to parse Pi RPC frame: ${errorMessage(error)}`, {
          frame: trimmed.slice(0, 200),
        }, diagnostics());
      }
      if (!isJsonRecord(parsed)) return;
      if (parsed['type'] === 'response') handleResponse(parsed);
      else handleEvent(parsed);
    };

    child.stdout.on('data', (chunk: ChildProcessDataChunk) => {
      stdoutBuffer += chunk.toString('utf8');
      while (true) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        try {
          parseLine(line);
        } catch (error) {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });

    child.stderr.on('data', (chunk: ChildProcessDataChunk) => {
      stderrText = tailText(`${stderrText}${chunk.toString('utf8')}`);
    });

    child.on('error', (error) => {
      settleReject(new AutopilotPiRunError('spawn-error', error.message, {}, diagnostics()));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settleReject(new AutopilotPiRunError('child-exit', `Pi child exited before completion: code=${String(code)} signal=${String(signal)}`, {
        code: code ?? -1,
        signal: signal ?? 'none',
      }, diagnostics()));
    });

    void (async () => {
      try {
        const stateResponse = await sendCommand('get_state');
        if (isJsonRecord(stateResponse.data)) lastState = stateResponse.data;
        validatePreSpendPiState(spec, lastState);
        await sendCommand('prompt', { message: prompt });
        await waitForEvent('agent_end', spec.wallMs);
        await sendCommand('get_session_stats').catch(() => undefined);
        const facts = deriveResultFacts(lastState, lastMessage);
        const finalAssistant = deriveFinalAssistantFacts(lastAssistantMessage);
        const initialStateModel = deriveInitialStateModelFacts(lastState);
        settleResolve(({
          isError: sawErrorEvent || facts.stopReason === 'error',
          stopReason: facts.stopReason,
          provider: facts.provider,
          model: facts.model,
          api: facts.api,
          thinkingLevel: facts.thinkingLevel,
          numTurns: turnCount,
          finalAssistantMessage: finalAssistant,
          initialStateModel,
          artifacts: ({
            structuredOutput: ({
              toolResultCandidates: ([...toolResultCandidates]),
            }),
            diagnostics: diagnostics(),
            executionObservationPath: spec.executionObservationPath,
          }),
        }));
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

function toRpcResponse(record: JsonRecord): RpcResponse {
  const id = typeof record['id'] === 'string' ? record['id'] : '';
  const command = typeof record['command'] === 'string' ? record['command'] : undefined;
  const error = typeof record['error'] === 'string' ? record['error'] : undefined;
  return {
    type: 'response',
    id,
    ...(command === undefined ? {} : { command }),
    success: record['success'] === true,
    ...(record['data'] === undefined ? {} : { data: record['data'] }),
    ...(error === undefined ? {} : { error }),
  };
}

function toStatusToolResultCandidate(record: JsonRecord): ToolResultCandidate | null {
  const type = stringField(record, 'type');
  const toolName = stringField(record, 'toolName') ?? stringField(record, 'tool_name');
  if (toolName !== AUTOPILOT_STATUS_TOOL) return null;

  if (type === 'tool_result') {
    return toolResultCandidateFromRecord(record, record);
  }

  if (type === 'tool_execution_end') {
    const result = jsonRecordField(record, 'result');
    return toolResultCandidateFromRecord(record, result);
  }

  return null;
}

function toolResultCandidateFromRecord(
  eventRecord: JsonRecord,
  resultRecord: JsonRecord | undefined,
): ToolResultCandidate {
  const toolName = stringField(eventRecord, 'toolName');
  const toolUnderscore = stringField(eventRecord, 'tool_name');
  const toolCallId = stringField(eventRecord, 'toolCallId');
  const toolCallUnderscore = stringField(eventRecord, 'tool_call_id');
  const rawDetails = resultRecord?.['details'];
  const details = normalizeStatusToolResultDetails(rawDetails, {
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolUnderscore === undefined ? {} : { tool_name: toolUnderscore }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(toolCallUnderscore === undefined ? {} : { tool_call_id: toolCallUnderscore }),
  });
  const detailsConflict =
    booleanField(eventRecord, 'detailsConflict') ??
    (resultRecord === undefined ? undefined : booleanField(resultRecord, 'detailsConflict'));
  return ({
    ...(toolUnderscore === undefined ? {} : { tool_name: toolUnderscore }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolCallUnderscore === undefined ? {} : { tool_call_id: toolCallUnderscore }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(typeof eventRecord['isError'] === 'boolean' ? { isError: eventRecord['isError'] } : {}),
    ...(details === undefined ? {} : { details }),
    ...(detailsConflict === undefined ? {} : { detailsConflict }),
  });
}

interface ResultFacts {
  readonly stopReason: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly api: string | null;
  readonly thinkingLevel: string | null;
}

function validatePreSpendPiState(spec: SpawnSpec, state: JsonRecord | undefined): void {
  if (spec.requestProfile === undefined) return;
  const stateModel = isJsonRecord(state?.['model']) ? state?.['model'] : undefined;
  const request = spec.requestProfile;
  const mismatches: string[] = [];
  const provider = stringField(stateModel, 'provider');
  const model = stringField(stateModel, 'id');
  const api = stringField(stateModel, 'api');
  const thinking = stringField(state, 'thinkingLevel');
  if (provider !== request.provider_id) mismatches.push(`provider_id expected ${request.provider_id}, Pi state observed ${formatNullable(provider ?? null)}`);
  if (model !== request.model_id) mismatches.push(`model_id expected ${request.model_id}, Pi state observed ${formatNullable(model ?? null)}`);
  if (api !== request.api) mismatches.push(`api expected ${request.api}, Pi state observed ${formatNullable(api ?? null)}`);
  if (thinking !== request.thinking) mismatches.push(`thinking expected ${request.thinking}, Pi state observed ${formatNullable(thinking ?? null)}`);
  if (mismatches.length > 0) {
    throw new AutopilotPiRunError('pre-spend-profile-mismatch', `Pi state does not match roster request profile before model spend: ${mismatches.join('; ')}`);
  }
}

function deriveResultFacts(state: JsonRecord | undefined, message: JsonRecord | undefined): ResultFacts {
  const stateModel = isJsonRecord(state?.['model']) ? state?.['model'] : undefined;
  const provider = stringField(message, 'provider') ?? stringField(stateModel, 'provider');
  const model = stringField(message, 'model') ?? stringField(stateModel, 'id');
  const api = stringField(message, 'api') ?? stringField(stateModel, 'api');
  const thinkingLevel = stringField(state, 'thinkingLevel');
  const stopReason = stringField(message, 'stopReason');
  return ({
    stopReason: stopReason ?? null,
    provider: provider ?? null,
    model: model ?? null,
    api: api ?? null,
    thinkingLevel: thinkingLevel ?? null,
  });
}

function deriveFinalAssistantFacts(message: JsonRecord | undefined): PiResult['finalAssistantMessage'] {
  if (message === undefined) return null;
  return {
    provider: stringField(message, 'provider') ?? null,
    model: stringField(message, 'model') ?? null,
    api: stringField(message, 'api') ?? null,
    stopReason: stringField(message, 'stopReason') ?? null,
  };
}

function deriveInitialStateModelFacts(state: JsonRecord | undefined): PiResult['initialStateModel'] {
  const stateModel = isJsonRecord(state?.['model']) ? state?.['model'] : undefined;
  if (stateModel === undefined) return null;
  return {
    provider: stringField(stateModel, 'provider') ?? null,
    model: stringField(stateModel, 'id') ?? null,
    api: stringField(stateModel, 'api') ?? null,
  };
}

function normalizeStatusToolResultDetails(
  rawDetails: unknown,
  eventIdentity: Pick<ToolResultCandidate, 'tool_name' | 'toolName' | 'tool_call_id' | 'toolCallId'>,
): unknown {
  if (!isJsonRecord(rawDetails)) return rawDetails;
  const toolName =
    stringField(rawDetails, 'tool_name') ??
    stringField(rawDetails, 'toolName') ??
    eventIdentity.tool_name ??
    eventIdentity.toolName;
  const toolCallId =
    stringField(rawDetails, 'tool_call_id') ??
    stringField(rawDetails, 'toolCallId') ??
    eventIdentity.tool_call_id ??
    eventIdentity.toolCallId;
  return ({
    ...(toolName === undefined ? {} : { tool_name: toolName }),
    ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    ...rawDetails,
  });
}

function validateAutopilotEmitStatusCarrier(
  piResult: PiResult,
  expectedToolCallId: string,
  expectedStatusSha256: `sha256:${string}`,
): void {
  const candidates = statusToolResultCandidates(piResult);
  if (candidates.length === 0) {
    throw new Error('missing autopilot_emit_status tool-result carrier in Pi RPC artifacts');
  }

  const mismatchReasons: string[] = [];
  let matchingCarrierCount = 0;
  for (const [index, candidate] of candidates.entries()) {
    const mismatchReason = autopilotEmitStatusCandidateMismatch(
      candidate,
      expectedToolCallId,
      expectedStatusSha256,
    );
    if (mismatchReason === null) {
      matchingCarrierCount += 1;
    } else {
      mismatchReasons.push(`candidate ${String(index + 1)}: ${mismatchReason}`);
    }
  }

  if (matchingCarrierCount === 0) {
    throw new Error(
      'no autopilot_emit_status carrier matched accepted receipt/status evidence; ' +
        formatCarrierMismatchReasons(mismatchReasons),
    );
  }
}

function statusToolResultCandidates(piResult: PiResult): readonly ToolResultCandidate[] {
  return (piResult.artifacts.structuredOutput?.toolResultCandidates ?? []).filter(
    (candidate) => (candidate.toolName ?? candidate.tool_name) === AUTOPILOT_STATUS_TOOL,
  );
}

function autopilotEmitStatusCandidateMismatch(
  candidate: ToolResultCandidate,
  expectedToolCallId: string,
  expectedStatusSha256: `sha256:${string}`,
): string | null {
  // Pi may mark a terminating tool-result frame as isError even after the
  // status tool has written valid status+receipt artifacts. The artifact/receipt
  // join below is the authority; do not reject solely on the transport flag.
  if (candidate.detailsConflict === true) return 'details conflict across events';
  if (!isJsonRecord(candidate.details)) {
    return 'details are missing or not a JSON object';
  }
  const details = candidate.details;
  return (
    detailMismatch(details, 'tool_name', AUTOPILOT_STATUS_TOOL) ??
    detailMismatch(details, 'tool_call_id', expectedToolCallId) ??
    detailMismatch(details, 'status_sha256', expectedStatusSha256) ??
    detailMismatch(details, 'terminating', true)
  );
}

function formatCarrierMismatchReasons(reasons: readonly string[]): string {
  if (reasons.length === 0) return 'no candidate diagnostics available';
  const shown = reasons.slice(0, 4).join('; ');
  const suffix = reasons.length > 4 ? `; ${String(reasons.length - 4)} more candidate(s) omitted` : '';
  return boundedDiagnosticText(`${shown}${suffix}`, FAILURE_REASON_LIMIT);
}

function detailMismatch(
  details: JsonRecord,
  field: string,
  expected: string | boolean,
): string | null {
  const actual = details[field];
  if (actual === expected) return null;
  return `${field} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

function isSuccessVerdict(status: AutopilotStatusEntry): boolean {
  return status.verdict === 'DONE' || status.verdict === 'PASS';
}

function isBenignTerminalStatusCompletion(
  piResult: PiResult,
  expectedToolCallId: string,
  expectedStatusSha256: `sha256:${string}`,
): boolean {
  if (piResult.artifacts.diagnostics.errorMessages.length > 0) return false;
  if (
    piResult.stopReason !== null &&
    piResult.stopReason !== 'toolUse' &&
    piResult.stopReason !== 'stop'
  ) {
    return false;
  }
  try {
    validateAutopilotEmitStatusCarrier(piResult, expectedToolCallId, expectedStatusSha256);
    return true;
  } catch {
    return false;
  }
}

function formatPiResultFailureDiagnostics(piResult: PiResult): string {
  const diagnostics = piResult.artifacts.diagnostics;
  const parts = [
    `stop_reason=${formatNullable(piResult.stopReason)}`,
    `provider=${formatNullable(piResult.provider)}`,
    `model=${formatNullable(piResult.model)}`,
    `api=${formatNullable(piResult.api)}`,
    `thinking=${formatNullable(piResult.thinkingLevel)}`,
    `turns=${String(piResult.numTurns)}`,
  ];
  appendDiagnosticList(parts, 'error_messages', diagnostics.errorMessages);
  appendDiagnosticText(parts, 'stderr_tail', diagnostics.stderrTail);
  appendDiagnosticJsonList(parts, 'last_events', diagnostics.eventSummaries);
  appendDiagnosticJsonList(parts, 'last_responses', diagnostics.responseSummaries);
  return boundedDiagnosticText(parts.join('; '), FAILURE_REASON_LIMIT);
}

function formatPiRunErrorDiagnostics(error: AutopilotPiRunError): string {
  const parts: string[] = [];
  if (error.details !== undefined) appendDiagnosticText(parts, 'details', safeJsonString(error.details));
  if (error.rpcRunArtifacts !== undefined) {
    appendDiagnosticList(parts, 'error_messages', error.rpcRunArtifacts.errorMessages);
    appendDiagnosticText(parts, 'stderr_tail', error.rpcRunArtifacts.stderrTail);
    appendDiagnosticJsonList(parts, 'last_events', error.rpcRunArtifacts.eventSummaries);
    appendDiagnosticJsonList(parts, 'last_responses', error.rpcRunArtifacts.responseSummaries);
  }
  if (parts.length === 0) return '';
  return `; ${boundedDiagnosticText(parts.join('; '), FAILURE_REASON_LIMIT)}`;
}

function appendDiagnosticText(parts: string[], label: string, value: string): void {
  if (value.length === 0) return;
  parts.push(`${label}=${JSON.stringify(boundedDiagnosticText(value, DIAGNOSTIC_TEXT_LIMIT))}`);
}

function appendDiagnosticList(parts: string[], label: string, values: readonly string[]): void {
  const bounded = values
    .filter((value) => value.length > 0)
    .slice(-3)
    .map((value) => boundedDiagnosticText(value, DIAGNOSTIC_TEXT_LIMIT));
  if (bounded.length > 0) parts.push(`${label}=${JSON.stringify(bounded)}`);
}

function appendDiagnosticJsonList(parts: string[], label: string, values: readonly unknown[]): void {
  const bounded = values.slice(-5).map((value) => boundedDiagnosticText(safeJsonString(value), DIAGNOSTIC_TEXT_LIMIT));
  if (bounded.length > 0) parts.push(`${label}=${JSON.stringify(bounded)}`);
}

function formatNullable(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(boundedDiagnosticText(value, DIAGNOSTIC_TEXT_LIMIT));
}

function boundedDiagnosticText(value: string, limit: number): string {
  const compact = redactSensitiveText(value).replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit)}…<truncated>`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+\/-]+/giu, '$1<redacted>')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|credential|secret)\s*[:=]\s*)[^\s,;"'}]+/giu, '$1<redacted>')
    .replace(/\b(?:sk|pk|rk|ghp|github_pat)_[A-Za-z0-9_\-]{12,}\b/gu, '<redacted-token>')
    .replace(/\b[A-Za-z0-9_-]*token[A-Za-z0-9_-]*\b\s*[:=]\s*[^\s,;"'}]+/giu, 'token=<redacted>');
}

function tailText(value: string): string {
  if (value.length <= DIAGNOSTIC_TEXT_LIMIT) return value;
  return value.slice(value.length - DIAGNOSTIC_TEXT_LIMIT);
}

function safeJsonString(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function projectEvent(record: JsonRecord): JsonRecord {
  const out: Record<string, unknown> = { type: stringField(record, 'type') ?? 'unknown' };
  for (const field of ['isError', 'errorMessage', 'stopReason', 'toolName', 'tool_call_id', 'toolCallId']) {
    if (record[field] !== undefined) out[field] = record[field];
  }
  const message = record['message'];
  if (isJsonRecord(message)) {
    out['message'] = {
      provider: stringField(message, 'provider'),
      model: stringField(message, 'model'),
      api: stringField(message, 'api'),
      stopReason: stringField(message, 'stopReason'),
    };
  }
  return (out);
}

function projectResponse(response: RpcResponse): JsonRecord {
  return ({
    type: response.type,
    id: response.id,
    command: response.command ?? null,
    success: response.success,
    ...(response.error === undefined ? {} : { error: response.error }),
  });
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord | undefined, field: string): string | undefined {
  if (record === undefined) return undefined;
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(record: JsonRecord, field: string): boolean | undefined {
  const value = record[field];
  return typeof value === 'boolean' ? value : undefined;
}

function jsonRecordField(record: JsonRecord, field: string): JsonRecord | undefined {
  const value = record[field];
  return isJsonRecord(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
