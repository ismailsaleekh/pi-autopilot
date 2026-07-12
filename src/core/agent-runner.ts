import { constants as fsConstants, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcessDataChunk, type ChildProcessLite } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV,
  AUTOPILOT_STATUS_CONTEXT_ENV,
  AUTOPILOT_STATUS_TOOL,
} from './names.ts';
import {
  buildAutopilotProviderIdentity,
  buildAutopilotStatusToolContext,
  deriveAutopilotArtifactRoot,
  parseAutopilotStatusToolContext,
  validateAutopilotStatusEvidence,
  type AutopilotProviderIdentity,
  type AutopilotStatusToolContext,
} from './forced-output/index.ts';
import { AutopilotForcedOutputEvidenceError } from './forced-output/status-evidence.ts';
import { parseAutopilotStatusEntry, parseAutopilotUnitSpec } from './contracts/index.ts';
import type { AutopilotExecutionAudit, AutopilotExecutionCommit, AutopilotStatusEntry, AutopilotUnitSpec } from './contracts/types.ts';
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
  recoverAutopilotWorktreeSagas,
  releaseClaimsForUnit,
  unitWorktreePathForActiveAutopilot,
  resolveActiveAutopilotForSpec,
  type ActiveAutopilotContext,
  type ActiveAutopilotRow,
  type AutopilotPathClaim,
} from './parallel-runtime.ts';
import { rollbackCreatedUnitWorktree } from './worktree-cleanup.ts';
import { AutopilotChildLeaseHandle, registerAutopilotChildAuthority } from './coordination/child-authority.ts';
import {
  assertAutopilotSpecMaterializationDiskGate,
  expandedReadOnlyPathsForAudit,
  materializeAutopilotSpecPaths,
} from './materialization.ts';
import { assertAutopilotSpecQualityGate } from './quality/spec-gate.ts';
import {
  AutopilotPromptTemplateError,
  renderAndMaybeWriteAutopilotPromptSnapshot,
  type AutopilotRenderedPrompt,
} from './prompt-renderer/index.ts';

type JsonRecord = Readonly<Record<string, unknown>>;
type ProcessEnv = Readonly<Record<string, string | undefined>>;
type TimerHandle = ReturnType<typeof setTimeout>;

export type AutopilotAgentRunFailureClass =
  | 'spec-invalid'
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
  readonly spec: AutopilotUnitSpec;
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

export interface AutopilotAgentRunOptions {
  readonly dryRun?: boolean;
  readonly piExecutable?: string;
  readonly env?: ProcessEnv;
  readonly timeoutMsOverride?: number;
  readonly forcePromptSnapshot?: boolean;
}

const AUTOPILOT_AGENT_PI_EXECUTABLE_ENV = 'AUTOPILOT_AGENT_PI_EXECUTABLE';
const DEFAULT_AGENT_WALL_MS = 3_600_000;
const RPC_COMMAND_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_TEXT_LIMIT = 600;
const FAILURE_REASON_LIMIT = 2_400;
const AUTOPILOT_AGENT_STATUS_EXTENSION_PATH = resolveAutopilotStatusExtensionPath(import.meta.url);

function resolveAutopilotStatusExtensionPath(moduleUrl: string): string {
  const sourcePath = fileURLToPath(new URL('../internal/status-extension.ts', moduleUrl));
  if (existsSync(sourcePath)) return sourcePath;
  return fileURLToPath(new URL('../internal/status-extension.js', moduleUrl));
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
  readonly cwd: string;
  readonly toolPolicy: ToolPolicy;
  readonly env: ProcessEnv;
  readonly contextPath: string;
  readonly wallMs: number;
  readonly name: string;
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
  readonly artifacts: {
    readonly structuredOutput?: {
      readonly toolResultCandidates: readonly ToolResultCandidate[];
    };
    readonly diagnostics: PiRunDiagnostics;
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
}

export async function runAutopilotAgentFromSpecPath(
  specPath: string,
  options: AutopilotAgentRunOptions = {},
): Promise<AutopilotAgentRunResult> {
  const lifecycle: ChildAuthorityLifecycle = { handle: null, completed: false };
  try {
    return await runAutopilotAgentFromSpecPathInternal(specPath, options, lifecycle);
  } catch (error) {
    if (lifecycle.handle !== null && !lifecycle.completed) {
      try {
        await lifecycle.handle.markRecoveryRequired();
      } catch (recoveryError) {
        throw new AutopilotAgentRunError('runtime-commit-failed', {
          reason: `child attempt failed (${errorMessage(error)}) and durable child recovery classification also failed: ${errorMessage(recoveryError)}`,
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
  const spec = await readAndValidateSpec(specPath);
  let providerIdentity: AutopilotProviderIdentity;
  let context: AutopilotStatusToolContext;
  try {
    providerIdentity = buildAutopilotProviderIdentity(spec.model, spec.thinking);
    context = buildAutopilotStatusToolContext({ unitSpec: spec, providerIdentity });
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: errorMessage(error),
      specPath,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
    });
  }

  const env = { ...process.env, ...(options.env ?? {}) };
  const runtimePreflight = await preflightSpec(spec, specPath, {
    skipStaleOutputCheck: options.dryRun === true,
    skipClaimAcquire: options.dryRun === true,
    skipSagaRecovery: options.dryRun === true,
    env,
  });
  const auditBaseline = await captureAutopilotExecutionBaseline(spec.cwd);
  const auditOutput = deriveAutopilotExecutionAuditPath(spec);
  const contextPath = deriveAutopilotStatusContextPath(spec);
  await writeStatusContext(contextPath, context);

  let rendered: AutopilotRenderedPrompt;
  try {
    rendered = await renderAndMaybeWriteAutopilotPromptSnapshot({
      spec,
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
      spec,
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
    lifecycle.handle = await registerAutopilotChildAuthority(spec, env);
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: `coordinator child authority preflight failed before model spend: ${errorMessage(error)}`,
      specPath,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
    });
  }

  const childProcessEnv: ProcessEnv = { ...env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: undefined };
  const spawnSpec: SpawnSpec = {
    executable: options.piExecutable ?? resolvePiExecutable(env),
    model: providerIdentity.requested_model_id,
    thinking: providerIdentity.thinking_level,
    cwd: spec.cwd,
    toolPolicy: toolPolicyForRole(spec.role),
    env: childProcessEnv,
    contextPath,
    wallMs: options.timeoutMsOverride ?? timeoutMsForSpec(spec),
    name: `autopilot-${spec.unit_id}-${spec.role}-attempt-${String(spec.attempt)}`,
  };

  let piResult: PiResult;
  try {
    piResult = await runPiPromptWithStatusCarrier(spawnSpec, rendered.text);
  } catch (error) {
    if (error instanceof AutopilotPiRunError) {
      const audit = await writeAttemptAudit(spec, runtimePreflight.context, auditBaseline, null, auditOutput);
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

  let evidence;
  try {
    evidence = await validateAutopilotStatusEvidence({ unitSpec: spec, providerIdentity });
  } catch (error) {
    const audit = await writeAttemptAudit(spec, runtimePreflight.context, auditBaseline, null, auditOutput);
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

  const audit = await writeAttemptAudit(spec, runtimePreflight.context, auditBaseline, evidence.status, auditOutput);

  try {
    validateAutopilotEmitStatusCarrier(
      piResult,
      evidence.receipt.tool_call_id,
      evidence.receipt.status_sha256,
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

  if (!isSuccessVerdict(evidence.status)) {
    throw new AutopilotAgentRunError('status-non-success', {
      reason: `Autopilot status verdict ${evidence.status.verdict}: ${evidence.status.summary}`,
      specPath,
      statusOutput: spec.status_output,
      receiptOutput: spec.receipt_output,
      promptSnapshotPath: rendered.snapshotPath,
      auditOutput,
      auditClassification: audit.classification,
      statusVerdict: evidence.status.verdict,
    });
  }

  if (
    piResult.isError &&
    !isBenignTerminalStatusCompletion(
      piResult,
      evidence.receipt.tool_call_id,
      evidence.receipt.status_sha256,
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

  const childAuthority = lifecycle.handle;
  if (childAuthority === null) throw new AutopilotAgentRunError('runtime-commit-failed', { reason: 'durable child authority disappeared before terminal commit', specPath });
  childAuthority.assertHealthy();
  const receiptBytes = await readFile(spec.receipt_output);
  const evidenceRelative = relative(runtimePreflight.context.active.main_worktree_path, spec.receipt_output).replace(/\\/gu, '/');
  if (evidenceRelative.length === 0 || evidenceRelative.startsWith('../') || evidenceRelative.startsWith('/')) throw new AutopilotAgentRunError('runtime-commit-failed', { reason: 'terminal receipt evidence is outside the durable run worktree', specPath });
  await childAuthority.completeTerminal({ ref: evidenceRelative, sha256: `sha256:${createHash('sha256').update(receiptBytes).digest('hex')}` });
  lifecycle.completed = true;

  return ({
    status: 'success',
    spec,
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

async function readAndValidateSpec(specPath: string): Promise<AutopilotUnitSpec> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(specPath, 'utf8')) as unknown;
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: `unit spec is not readable JSON: ${errorMessage(error)}`,
      specPath,
    });
  }

  try {
    const spec = parseAutopilotUnitSpec(parsed);
    assertAutopilotSpecQualityGate(spec);
    return spec;
  } catch (error) {
    throw new AutopilotAgentRunError('spec-invalid', {
      reason: errorMessage(error),
      specPath,
    });
  }
}

interface RuntimePreflightResult {
  readonly context: ActiveAutopilotContext;
  readonly acquiredClaims: readonly AutopilotPathClaim[];
}

interface RuntimePreflightOptions {
  readonly skipStaleOutputCheck?: boolean;
  readonly skipClaimAcquire?: boolean;
  readonly skipSagaRecovery?: boolean;
  readonly env?: ProcessEnv;
}

async function preflightSpec(
  spec: AutopilotUnitSpec,
  specPath: string,
  options: RuntimePreflightOptions = {},
): Promise<RuntimePreflightResult> {
  const preparedWorktree = await prepareMissingSourceChangingUnitWorktree(spec, options.env ?? process.env, options.skipSagaRecovery === true);
  try {
    return await preflightSpecAfterWorktreePreparation(spec, specPath, options);
  } catch (error) {
    if (preparedWorktree.created) {
      try {
        await rollbackCreatedUnitWorktree({ active: preparedWorktree.active, unitId: preparedWorktree.unitId, attempt: preparedWorktree.attempt, reason: `autopilot-agent-run preflight rollback after failure: ${errorMessage(error)}`, env: options.env ?? process.env });
      } catch (rollbackError) {
        throw preflightRollbackFailure(spec, specPath, error, rollbackError);
      }
    }
    throw error;
  }
}

async function preflightSpecAfterWorktreePreparation(
  spec: AutopilotUnitSpec,
  specPath: string,
  options: RuntimePreflightOptions = {},
): Promise<RuntimePreflightResult> {
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
    await assertAutopilotSpecMaterializationDiskGate({ context: runtimeContext, spec }).catch((error: unknown) => {
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

  const acquiredClaims = options.skipClaimAcquire === true
    ? []
    : await acquireClaimsForUnit({ context: runtimeContext, spec, reason: 'autopilot-agent-run preflight' }).catch((error: unknown) => {
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

  if (options.skipClaimAcquire !== true) {
    await materializeAutopilotSpecPaths({
      context: runtimeContext,
      spec,
      reason: 'autopilot-agent-run preflight materialization',
      ...(options.env === undefined ? {} : { env: options.env }),
    }).catch(async (error: unknown) => {
      if (acquiredClaims.length > 0) {
        await releaseClaimsForUnit({ context: runtimeContext, unitId: spec.unit_id, attempt: spec.attempt, reason: 'autopilot-agent-run materialization failure claim rollback' }).catch(() => undefined);
      }
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

  await mkdir(dirname(spec.status_output), { recursive: true });
  await mkdir(dirname(spec.receipt_output), { recursive: true });
  await mkdir(spec.evidence_dir, { recursive: true });
  return { context: runtimeContext, acquiredClaims };
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
  const activeRows = await readActiveAutopilots(coordinationRootForRepo(repoKey, env));
  const active = activeRows.find((row) => row.workstream === spec.workstream && row.runtime_root === artifactRoot);
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

async function writeStatusContext(path: string, context: AutopilotStatusToolContext): Promise<void> {
  const parsed = parseAutopilotStatusToolContext(JSON.parse(JSON.stringify(context)) as unknown);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

async function writeAttemptAudit(
  spec: AutopilotUnitSpec,
  context: ActiveAutopilotContext,
  baseline: AutopilotExecutionBaseline,
  statusEntry: AutopilotStatusEntry | null,
  auditPath: string,
): Promise<AutopilotExecutionAudit> {
  const readOnlyPaths = await expandedReadOnlyPathsForAudit({ context, spec });
  return await writeAutopilotExecutionAudit({
    unitSpec: { ...spec, read_only_paths: readOnlyPaths },
    baseline,
    statusEntry,
    auditPath,
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

async function runPiPromptWithStatusCarrier(spec: SpawnSpec, prompt: string): Promise<PiResult> {
  validateModelIdentity(spec.model);
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
  ];

  const env = sanitizeAgentEnv(spec.env, spec.contextPath);
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

function sanitizeAgentEnv(env: ProcessEnv, contextPath: string): ProcessEnv {
  const out: Record<string, string | undefined> = { ...env, [AUTOPILOT_STATUS_CONTEXT_ENV]: contextPath };
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
      clearPending(error);
      if (!child.killed) child.kill('SIGTERM');
      rejectPromise(error);
    };

    const settleResolve = (result: PiResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      clearPending(new AutopilotPiRunError('settled', 'Pi RPC supervisor settled'));
      child.stdin.end();
      if (!child.killed) child.kill('SIGTERM');
      resolvePromise(result);
    };

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
        if (isJsonRecord(message)) lastMessage = message;
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
        await sendCommand('prompt', { message: prompt });
        await waitForEvent('agent_end', spec.wallMs);
        await sendCommand('get_session_stats').catch(() => undefined);
        const facts = deriveResultFacts(lastState, lastMessage);
        settleResolve(({
          isError: sawErrorEvent || facts.stopReason === 'error',
          stopReason: facts.stopReason,
          provider: facts.provider,
          model: facts.model,
          api: facts.api,
          thinkingLevel: facts.thinkingLevel,
          numTurns: turnCount,
          artifacts: ({
            structuredOutput: ({
              toolResultCandidates: ([...toolResultCandidates]),
            }),
            diagnostics: diagnostics(),
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
  const compact = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit)}…<truncated>`;
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
