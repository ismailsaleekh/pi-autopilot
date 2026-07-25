import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createContextBudgetTool, resolveContextHaltPercent } from './core/context-budget.ts';
import {
  AUTOPILOT_ABORT_COMMAND,
  AUTOPILOT_CLAIM_GC_COMMAND,
  AUTOPILOT_CLOSE_COMMAND,
  AUTOPILOT_COMMAND,
  AUTOPILOT_CONFIG_COMMAND,
  AUTOPILOT_COORDINATION_COMMAND,
  AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV,
  AUTOPILOT_HANDOFF_COMMAND,
  AUTOPILOT_INJECT_COMMAND,
  AUTOPILOT_ONBOARD_COMMAND,
  CONTEXT_BUDGET_TOOL_NAME,
  AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME,
} from './core/names.ts';
import { buildAutopilotWorkstreamRun, parseAutopilotAbortArgs, parseAutopilotArgs, parseAutopilotLaunchArgs, parseAutopilotClaimGcArgs, parseAutopilotCloseArgs, parseAutopilotConfigArgs, parseAutopilotCoordinationArgs, parseAutopilotInjectArgs, runnerInvocationFromModuleUrl, runtimeRootForWorkstream, type ParsedAutopilotArgs } from './core/paths.ts';
import { AutopilotCloseError, abortAutopilotWorkstream, closeAutopilotWorkstream } from './core/close-runtime.ts';
import { runAutopilotClaimGc } from './core/claim-gc.ts';
import { readSchedulerConfig, writeSchedulerConfig } from './core/scheduler-config.ts';
import {
  evaluateAutopilotWorktreeToolCall,
  type AutopilotGuardDecision,
  type AutopilotToolCallContextLike,
  type AutopilotToolCallEventLike,
} from './core/git-guard.ts';
import { AUTOPILOT_STATE_ROOT_ENV, AutopilotParallelRuntimeError, coordinationRootForRepo, prepareAutopilotWorkstream, readActiveAutopilots, readCoordinatorActiveAutopilots, recoverAutopilotWorktreeSagas, resolveAutopilotStateRoot, resolveRepoIdentity, withAutopilotFileLock, worktreeRootForRepo, writeActiveAutopilots, type ActiveAutopilotRow, type PreparedAutopilotWorkstream, type ProcessEnvLike } from './core/parallel-runtime.ts';
import { CoordinatorClient } from './core/coordination/client.ts';
import { CoordinationRuntimeError, formatCoordinationRuntimeError } from './core/coordination/failures.ts';
import { createClaimResponseTool, type ClaimResponseToolDefinition } from './core/coordination/claim-response-tool.ts';
import { ClaimNegotiationClient } from './core/coordination/negotiation.ts';
import { replayPendingCoordinatorReconciliation } from './core/coordination/reconciliation.ts';
import { reconcileRetainedFailedUnitAuthority } from './core/unit-failure.ts';
import { AutopilotSessionBridge, type CoordinationMessageInjection } from './core/coordination/supervisor.ts';
import { ensureMainWorktreeSagaRegistered } from './core/coordination/worktree-saga.ts';
import {
  handoffUsage,
  onboardUsage,
  renderAutopilotBootstrapPlanPrompt,
  renderAutopilotPrompt,
  renderHandoffPrompt,
  renderOnboardPrompt,
} from './core/prompts.ts';
import { parseD65LaunchManifest, launchManifestBytesSha256, D65_LAUNCH_MANIFEST_MAX_BYTES, type D65LaunchManifest } from './core/coordination/d65-launch-manifest.ts';
import { SpawnedD65LaunchSigner, type D65LaunchSigner } from './core/coordination/d65-launch-signer.ts';
import {
  beginD65LaunchBootstrap,
  detectD65CharterComplete,
  D65_CHARTER_ROOTS,
  launchEnv,
  publishD65FirstGraphAndSuccessorHeartbeat,
  registerD65LaunchPolicyAndInitialHeartbeat,
  resolveD65LaunchPhase,
  activateD65RuntimeRosterFromManifest,
  publishD65RuntimeRosterSnapshot,
  writeD65ContextBudgetReceipt,
  type D65LaunchBootstrapResult,
} from './core/coordination/d65-launch-integration.ts';
import { readImmutableFileBytes } from './core/coordination/immutable-file.ts';
import { coordinationCutoverCommitted } from './core/coordination/migration-paths.ts';
import {
  autopilotRosterContractCanonicalJson,
  autopilotRosterContractHashField,
  autopilotRosterContractSha256OmittingOwnField,
  isAutopilotRosterContractSchemaVersion,
  parseAutopilotRosterContract,
  parseAutopilotRosterContractJson,
  type AutopilotRosterContractBySchemaVersion,
} from './core/roster/contracts.ts';
import { isLaunchableRosterCandidate } from './core/roster/activation-fence.ts';
import {
  publishCustomRosterCertificationAuthority,
  readCustomRosterCertificationAuthority,
  verifyCustomRosterManifestForRoster,
} from './core/roster/custom-certification.ts';
import { isCentrallyTrustedW4CertifiedRoster } from './core/roster/providers/index.ts';
import { loadPackagedLiveCertificationManifests } from './core/roster/live-certification-manifests.ts';
import { createAutopilotRosterSetupTool } from './core/roster/setup-tool.ts';
import { createRosterSetupReceiptFactory, type AutopilotRosterSetupReceipt } from './core/roster/setup-receipt.ts';
import { resolveAutopilotRosterSetupSkillPackage, type VerifiedAutopilotRosterSetupSkillPackage } from './core/roster/skill-package.ts';
import { parseProviderRoster, seedRosterByCandidate, type QualificationManifest, type RosterCandidate } from './core/roster/provider-recipes.ts';
import { resolveAndCommitPreRunSelection, type RunSelectionAuthority } from './core/roster/run-selection.ts';
import { publishRuntimeRosterSnapshot, recoverRuntimeRosterSelection } from './core/roster/snapshot.ts';
import { authorizeExistingRunRosterTransitionInput, buildExistingRunRosterTransitionProposal, commitApprovedExistingRunRosterTransition, consumeCommittedExistingRunRosterTransition, resolveCommittedExistingRunRosterTransitionChain, savedRosterRefForSelection, type ExistingRunRosterSuccessorAttemptAuthority, type ExistingRunRosterTransitionProposal, type ExistingRunRosterTransitionRunRef } from './core/roster/transition.ts';
import { ROSTER_DIAGNOSTIC_CODES, canonicalSha256, rosterDiagnostic, type Digest, type RosterDiagnostic, type RosterDiagnosticCode } from './core/roster/route-policies.ts';
import { resolveNewRun, type NewRunResolutionSource, type PreRunSelection, type SavedRosterAuthority } from './core/roster/resolve.ts';
import { RosterStorage, formatAuthorityPath, resolveRosterScopePaths, rosterRevisionPath, type RosterDefaultReadResult, type RosterSha256, type RosterStorageCodec, type RosterStorageDiagnostic, type RosterStorageScope, type SavedRosterRef } from './core/roster/storage.ts';
import { readAuthorityFileIfPresent } from './core/roster/transaction.ts';

export type NotificationKind = 'info' | 'warning' | 'error';

export interface ExtensionUiLike {
  notify(message: string, kind?: NotificationKind): void;
}

export interface ExtensionModelLike {
  readonly provider: string;
  readonly id: string;
}

export interface ExtensionModelRegistryLike {
  find(provider: string, modelId: string): ExtensionModelLike | undefined;
  getAll?(): readonly unknown[];
  getError?(): string | undefined;
  getProviderAuthStatus?(provider: string): { readonly configured: boolean; readonly source?: string | undefined };
  isUsingOAuth?(model: ExtensionModelLike): boolean;
}

export interface ExtensionSessionManagerLike {
  getSessionId(): string;
}

export interface ExtensionCommandContextLike {
  readonly ui: ExtensionUiLike;
  readonly cwd?: string;
  readonly modelRegistry?: ExtensionModelRegistryLike;
  readonly sessionManager?: ExtensionSessionManagerLike;
  isIdle?(): boolean;
  isProjectTrusted?(): boolean | Promise<boolean>;
}

export interface ExtensionCommandDefinitionLike {
  readonly description: string;
  handler(args: string, ctx: ExtensionCommandContextLike): Promise<void>;
}

export type ExtensionToolCallHandler = (
  event: AutopilotToolCallEventLike,
  ctx: AutopilotToolCallContextLike,
) => AutopilotGuardDecision | Promise<AutopilotGuardDecision>;

export type ExtensionLifecycleHandler = (
  event: Readonly<Record<string, unknown>>,
  ctx: ExtensionCommandContextLike,
) => void | Promise<void>;

export type ExtensionResourcesDiscoverHandler = (
  event: Readonly<Record<string, unknown>>,
  ctx: ExtensionCommandContextLike,
) => void | { readonly skillPaths?: readonly string[] } | Promise<void | { readonly skillPaths?: readonly string[] }>;

export type ExtensionInputHandler = (
  event: { readonly text?: string; readonly source?: string },
  ctx: ExtensionCommandContextLike,
) => void | { readonly action: 'continue' | 'handled' | 'transform'; readonly text?: string } | Promise<void | { readonly action: 'continue' | 'handled' | 'transform'; readonly text?: string }>;

export interface ExtensionEventRegistrar {
  (eventName: 'tool_call', handler: ExtensionToolCallHandler): void;
  (eventName: 'session_start' | 'session_shutdown', handler: ExtensionLifecycleHandler): void;
  (eventName: 'resources_discover', handler: ExtensionResourcesDiscoverHandler): void;
  (eventName: 'input', handler: ExtensionInputHandler): void;
  // `agent_settled` fires when Pi will not continue running automatically. The
  // D65 launch path uses it to publish the first complete graph after the
  // bootstrap-plan-only turn settles.
  (eventName: 'agent_settled', handler: ExtensionLifecycleHandler): void;
}

export type AutopilotRosterSetupToolBundle = ReturnType<typeof createAutopilotRosterSetupTool>;
export type AutopilotParentToolDefinition = ReturnType<typeof createContextBudgetTool> | ClaimResponseToolDefinition | AutopilotRosterSetupToolBundle['tool'];

export interface ExtensionHostLike {
  registerCommand(name: string, definition: ExtensionCommandDefinitionLike): void;
  registerTool(tool: AutopilotParentToolDefinition): void;
  getActiveTools?(): readonly string[];
  setActiveTools?(toolNames: readonly string[]): void;
  setModel?(model: ExtensionModelLike): Promise<boolean>;
  getThinkingLevel?(): string;
  setThinkingLevel?(level: 'high' | 'xhigh'): void;
  sendUserMessage(content: string, options: { readonly deliverAs: 'followUp' }): void;
  sendMessage?(message: CoordinationMessageInjection, options: { readonly deliverAs: 'steer' | 'followUp'; readonly triggerTurn: boolean }): void;
  on?: ExtensionEventRegistrar;
}

export interface ResolvedAutopilotRosterSelection {
  readonly source: NewRunResolutionSource | 'existing-run-selection';
  readonly existingRun: boolean;
  readonly scope: RosterStorageScope;
  readonly roster_id: string;
  readonly roster_revision: number;
  readonly roster_sha256: Digest;
  readonly assignment_set_sha256: Digest;
  readonly config_sha256: Digest;
  readonly workstream_run?: string | undefined;
  readonly pre_run_selection?: PreRunSelection | undefined;
  readonly pre_run_selection_path?: string | undefined;
  readonly selection_bytes?: Uint8Array | null | undefined;
  readonly launch_fence?: Awaited<ReturnType<typeof resolveAndCommitPreRunSelection>>['launch_fence'] | undefined;
  readonly runtime_mirror_path?: string | null | undefined;
  readonly custom_launch_diagnostics?: readonly RosterDiagnostic[] | undefined;
  readonly successor_attempt_authority?: ExistingRunRosterSuccessorAttemptAuthority | undefined;
  readonly parent: {
    readonly model: string;
    readonly thinking: 'high' | 'xhigh';
  };
}

export type AutopilotRosterActivationResolution =
  | { readonly status: 'resolved'; readonly selection: ResolvedAutopilotRosterSelection; readonly diagnostics: readonly RosterDiagnostic[] }
  | { readonly status: 'setup-required'; readonly source: 'agent-first-onboarding'; readonly diagnostics: readonly RosterDiagnostic[] }
  | { readonly status: 'transition-approval-required'; readonly source: 'existing-run-selection'; readonly proposal: ExistingRunRosterTransitionProposal; readonly run: ExistingRunRosterTransitionRunRef; readonly active: ActiveAutopilotRow; readonly originalCommand: string; readonly diagnostics: readonly RosterDiagnostic[] }
  | { readonly status: 'blocked'; readonly source: NewRunResolutionSource | 'existing-run-selection'; readonly diagnostics: readonly RosterDiagnostic[] };

export interface AutopilotRosterActivationResolveInput {
  readonly parsed: ParsedAutopilotArgs;
  readonly ctx: ExtensionCommandContextLike;
  readonly originalCommand: string;
  readonly env: ProcessEnvLike;
  readonly plannedWorkstreamRun: string;
  readonly now: Date;
}

export interface AutopilotRosterActivationStore {
  resolve(input: AutopilotRosterActivationResolveInput): Promise<AutopilotRosterActivationResolution>;
}

export interface AutopilotExtensionDependencies {
  readonly rosterActivationStore?: AutopilotRosterActivationStore | undefined;
  readonly rosterStateRoot?: string | undefined;
  readonly prepareAutopilotWorkstream?: ((input: Parameters<typeof prepareAutopilotWorkstream>[0]) => ReturnType<typeof prepareAutopilotWorkstream>) | undefined;
  readonly publishRuntimeRosterSnapshot?: ((input: Parameters<typeof publishRuntimeRosterSnapshot>[0]) => ReturnType<typeof publishRuntimeRosterSnapshot>) | undefined;
  readonly attachSessionBridge?: ((prepared: PreparedAutopilotWorkstream, ctx: ExtensionCommandContextLike) => Promise<boolean>) | undefined;
  readonly resolveSetupSkillPackage?: ((moduleUrl?: string) => VerifiedAutopilotRosterSetupSkillPackage) | undefined;
  readonly createRosterSetupTool?: ((options: Parameters<typeof createAutopilotRosterSetupTool>[0]) => AutopilotRosterSetupToolBundle) | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * Resolve the external operator launch signer for a sealed D65 manifest. The
   * default spawns the `autopilot-launch-signer` CLI whose command/config is
   * named by the sealed manifest's evidence root. Tests inject a signer double
   * that still produces externally signed bytes through the same contract.
   */
  readonly resolveLaunchSigner?: ((manifest: D65LaunchManifest, env: ProcessEnvLike) => D65LaunchSigner) | undefined;
}

type RosterContract = AutopilotRosterContractBySchemaVersion['autopilot.roster.v1'];

type RosterConfigContract = AutopilotRosterContractBySchemaVersion['autopilot.roster_config.v1'];

type AuthorityRead = {
  readonly authority: SavedRosterAuthority;
  readonly selection: ResolvedAutopilotRosterSelection | null;
};

type PinnedExistingRunSelectionRead =
  | { readonly ok: true; readonly selection: ResolvedAutopilotRosterSelection; readonly recovered_selection: PreRunSelection; readonly external_selection_path: string; readonly runtime_mirror_path: string }
  | { readonly ok: false; readonly recovered_selection: PreRunSelection | null; readonly external_selection_path: string | null; readonly runtime_mirror_path: string | null; readonly diagnostics: readonly RosterDiagnostic[]; readonly file_state: 'missing' | 'hash-mismatch' | 'recovery-failed' };

const ZERO_ROSTER_SHA = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const;
const SETUP_TOOL_NAME = 'autopilot_manage_rosters' as const;
const LIVE_PARENT_STATUSES = new Set<string>(['active', 'paused', 'merging', 'blocked']);

const productionRosterStorageCodec: RosterStorageCodec<AutopilotRosterSetupReceipt> = Object.freeze({
  hashBytes(bytes: Uint8Array): RosterSha256 {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('roster authority bytes must be an object');
    const schemaVersion = (parsed as Readonly<Record<string, unknown>>)['schema_version'];
    if (typeof schemaVersion !== 'string' || !isAutopilotRosterContractSchemaVersion(schemaVersion)) throw new Error('unknown roster authority schema_version');
    const hashField = autopilotRosterContractHashField(schemaVersion);
    if (hashField === null) return autopilotRosterContractSha256OmittingOwnField({ value: parsed, unused_hash_field: ZERO_ROSTER_SHA }, 'unused_hash_field') as RosterSha256;
    return autopilotRosterContractSha256OmittingOwnField(parsed, hashField) as RosterSha256;
  },
  decodeRoster(bytes: Uint8Array) {
    const roster = parseAutopilotRosterContractJson('autopilot.roster.v1', Buffer.from(bytes).toString('utf8'));
    return {
      scope: roster.scope,
      selected_scope: roster.selected_scope,
      roster_id: roster.roster_id,
      roster_revision: roster.roster_revision,
      roster_sha256: roster.roster_sha256 as RosterSha256,
      assignment_set_sha256: roster.assignment_set_sha256 as RosterSha256,
    };
  },
  decodeConfig(bytes: Uint8Array) {
    const config = parseAutopilotRosterContractJson('autopilot.roster_config.v1', Buffer.from(bytes).toString('utf8'));
    return configAuthorityProjection(config);
  },
  decodeSelection(bytes: Uint8Array) {
    const selection = parseAutopilotRosterContractJson('autopilot.pre_run_selection.v1', Buffer.from(bytes).toString('utf8'));
    return {
      repo_id: selection.repo_id,
      workstream_run: selection.workstream_run,
      scope: selection.scope,
      roster_id: selection.roster_id,
      roster_revision: selection.roster_revision,
      roster_sha256: selection.roster_sha256 as RosterSha256,
      assignment_set_sha256: selection.assignment_set_sha256 as RosterSha256,
      config_sha256: selection.config_sha256 as RosterSha256,
      selection_sha256: selection.selection_sha256 as RosterSha256,
    };
  },
  createSetupReceipt: createRosterSetupReceiptFactory(),
});

function configAuthorityProjection(config: RosterConfigContract): NonNullable<RosterDefaultReadResult['config']> {
  return {
    scope: config.scope,
    default_roster_id: config.default_roster_id,
    default_roster_revision: config.default_roster_revision,
    default_roster_sha256: config.default_roster_sha256 as RosterSha256,
    rosters: config.rosters.map((ref) => ({
      roster_id: ref.roster_id,
      roster_revision: ref.roster_revision,
      roster_sha256: ref.roster_sha256 as RosterSha256,
      assignment_set_sha256: ref.assignment_set_sha256 as RosterSha256,
      path: ref.path,
    })),
    previous_config_sha256: config.previous_config_sha256 as RosterSha256 | null,
    config_sha256: config.config_sha256 as RosterSha256,
  };
}

function createProductionRosterStorage(stateRoot: string | undefined): RosterStorage<AutopilotRosterSetupReceipt> {
  return stateRoot === undefined
    ? new RosterStorage({ codec: productionRosterStorageCodec })
    : new RosterStorage({ codec: productionRosterStorageCodec, stateRoot });
}

function rosterDiagnosticForCode(code: string): RosterDiagnostic {
  if ((ROSTER_DIAGNOSTIC_CODES as readonly string[]).includes(code)) return rosterDiagnostic(code as RosterDiagnosticCode);
  return rosterDiagnostic('ROSTER_READBACK_MISMATCH');
}

function dedupeRosterDiagnostics(codes: readonly string[]): readonly RosterDiagnostic[] {
  const byCode = new Map<string, RosterDiagnostic>();
  for (const code of codes) {
    const diagnostic = rosterDiagnosticForCode(code);
    byCode.set(diagnostic.code, diagnostic);
  }
  return [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code));
}

function storageDiagnosticsAsRosterDiagnostics(diagnostics: readonly RosterStorageDiagnostic[]): readonly RosterDiagnostic[] {
  return dedupeRosterDiagnostics(diagnostics.map((diagnostic) => diagnostic.code));
}

function authorityFor(input: {
  readonly source: Exclude<NewRunResolutionSource, 'agent-first-onboarding'>;
  readonly state: SavedRosterAuthority['state'];
  readonly scope: RosterStorageScope;
  readonly ref?: SavedRosterRef | undefined;
  readonly trusted?: boolean | undefined;
}): SavedRosterAuthority {
  const base = {
    source: input.source,
    state: input.state,
    scope: input.scope,
    roster_id: input.ref?.roster_id ?? null,
    roster_revision: input.ref?.roster_revision ?? null,
    roster_sha256: input.ref?.roster_sha256 ?? null,
    assignment_set_sha256: input.ref?.assignment_set_sha256 ?? null,
  } satisfies Omit<SavedRosterAuthority, 'trusted'>;
  return input.trusted === undefined ? base : { ...base, trusted: input.trusted };
}

function originalAutopilotCommand(args: string): string {
  const trimmed = args.trim();
  return trimmed.length === 0 ? `/${AUTOPILOT_COMMAND}` : `/${AUTOPILOT_COMMAND} ${trimmed}`;
}

function setupRequiredResolution(): AutopilotRosterActivationResolution {
  return { status: 'setup-required', source: 'agent-first-onboarding', diagnostics: [] };
}

function blockedResolution(source: NewRunResolutionSource | 'existing-run-selection', codes: readonly string[]): AutopilotRosterActivationResolution {
  return { status: 'blocked', source, diagnostics: dedupeRosterDiagnostics(codes) };
}

function runSelectionAuthority(read: AuthorityRead | null | undefined): RunSelectionAuthority | null {
  if (read === null || read === undefined) return null;
  return {
    source: read.authority.source,
    state: read.authority.state,
    scope: read.authority.scope,
    roster_id: read.authority.roster_id,
    roster_revision: read.authority.roster_revision,
    roster_sha256: read.authority.roster_sha256 as RosterSha256 | null,
    assignment_set_sha256: read.authority.assignment_set_sha256 as RosterSha256 | null,
    config_sha256: (read.selection?.config_sha256 as RosterSha256 | undefined) ?? null,
    ...(read.authority.trusted === undefined ? {} : { trusted: read.authority.trusted }),
  };
}

function rosterSelectionReadiness(selection: ResolvedAutopilotRosterSelection): readonly RosterDiagnostic[] {
  if (selection.custom_launch_diagnostics !== undefined && selection.custom_launch_diagnostics.length > 0) return selection.custom_launch_diagnostics;
  if (selection.parent.model.length === 0) return dedupeRosterDiagnostics(['ROSTER_READBACK_MISMATCH']);
  return [];
}

function trustedProjectRoot(ctx: ExtensionCommandContextLike): string {
  return ctx.cwd ?? process.cwd();
}

async function projectTrusted(ctx: ExtensionCommandContextLike): Promise<boolean> {
  if (ctx.isProjectTrusted === undefined) return false;
  try {
    return await ctx.isProjectTrusted() === true;
  } catch {
    return false;
  }
}

function trustedProjectContext(ctx: ExtensionCommandContextLike): { readonly root: string; readonly isProjectTrusted: () => boolean | Promise<boolean> } {
  return { root: trustedProjectRoot(ctx), isProjectTrusted: () => projectTrusted(ctx) };
}

function transitionRunRef(active: ActiveAutopilotRow): ExistingRunRosterTransitionRunRef {
  return {
    repo_id: active.repo_key,
    workstream: active.workstream,
    workstream_run: active.workstream_run,
    main_worktree_path: active.main_worktree_path,
    runtime_root: active.runtime_root,
    source_repo: active.source_repo,
  };
}

async function readFreshActiveRunForTransition(input: {
  readonly expected: ActiveAutopilotRow;
  readonly ctx: ExtensionCommandContextLike;
  readonly env: ProcessEnvLike;
}): Promise<ActiveAutopilotRow | null> {
  const repo = resolveRepoIdentity(input.ctx.cwd ?? process.cwd());
  if (repo.repoKey !== input.expected.repo_key) return null;
  const stateRoot = resolveAutopilotStateRoot(input.env);
  const rows = coordinationCutoverCommitted(stateRoot, repo.repoKey)
    ? await readCoordinatorActiveAutopilots(repo, worktreeRootForRepo(repo.repoKey, input.env), input.env)
    : await readActiveAutopilots(coordinationRootForRepo(repo.repoKey, input.env));
  const matches = rows.filter((row) => row.autopilot_id === input.expected.autopilot_id && row.workstream_run === input.expected.workstream_run);
  if (matches.length !== 1) return null;
  const fresh = matches[0];
  if (fresh === undefined || !sameActiveRunForTransition(fresh, input.expected) || fresh.status !== input.expected.status) return null;
  return fresh;
}

function sameActiveRunForTransition(left: ActiveAutopilotRow, right: ActiveAutopilotRow): boolean {
  return left.schema_version === right.schema_version &&
    left.coordination_authority === right.coordination_authority &&
    left.autopilot_id === right.autopilot_id &&
    left.workstream === right.workstream &&
    left.workstream_run === right.workstream_run &&
    left.repo_key === right.repo_key &&
    left.source_repo === right.source_repo &&
    left.git_common_dir === right.git_common_dir &&
    left.worktree_root === right.worktree_root &&
    left.main_worktree_path === right.main_worktree_path &&
    left.branch === right.branch &&
    left.runtime_root === right.runtime_root &&
    left.target_branch === right.target_branch &&
    left.target_base_sha === right.target_base_sha &&
    left.origin_url === right.origin_url &&
    left.active_run_epoch === right.active_run_epoch &&
    left.active_epoch_started_at === right.active_epoch_started_at &&
    left.active_run_receipt_id === right.active_run_receipt_id;
}

function resolveScopePathsForActivation(input: {
  readonly scope: RosterStorageScope;
  readonly ctx: ExtensionCommandContextLike;
  readonly stateRoot?: string | undefined;
  readonly trustedProjectRootOverride?: string | undefined;
}) {
  if (input.scope === 'trusted-project') {
    const trustedRoot = input.trustedProjectRootOverride ?? trustedProjectRoot(input.ctx);
    return input.stateRoot === undefined
      ? resolveRosterScopePaths({ scope: input.scope, trustedProjectRoot: trustedRoot })
      : resolveRosterScopePaths({ scope: input.scope, stateRoot: input.stateRoot, trustedProjectRoot: trustedRoot });
  }
  return input.stateRoot === undefined
    ? resolveRosterScopePaths({ scope: input.scope })
    : resolveRosterScopePaths({ scope: input.scope, stateRoot: input.stateRoot });
}

async function customRosterLaunchDiagnostics(input: {
  readonly roster: RosterContract;
  readonly paths: ReturnType<typeof resolveScopePathsForActivation>;
}): Promise<readonly RosterDiagnostic[]> {
  if (input.roster.generation_source !== 'user-custom') return [];
  const customRoster = parseProviderRoster(input.roster);
  const authority = await readCustomRosterCertificationAuthority({ paths: input.paths, roster: customRoster });
  if (!authority.ok) return dedupeRosterDiagnostics(['ROSTER_QUALIFICATION_REQUIRED']);
  if (authority.authority.roster_sha256 !== input.roster.roster_sha256) return dedupeRosterDiagnostics(['ROSTER_READBACK_MISMATCH']);
  const verification = verifyCustomRosterManifestForRoster({ roster: customRoster, manifest: authority.authority.qualification_manifest });
  if (!verification.ok) return dedupeRosterDiagnostics(['ROSTER_QUALIFICATION_REQUIRED']);
  return [];
}

async function loadRosterSelectionFromRef(input: {
  readonly source: ResolvedAutopilotRosterSelection['source'];
  readonly existingRun: boolean;
  readonly scope: RosterStorageScope;
  readonly ref: SavedRosterRef;
  readonly configSha256: Digest;
  readonly ctx: ExtensionCommandContextLike;
  readonly stateRoot?: string | undefined;
  readonly trustedProjectRootOverride?: string | undefined;
}): Promise<{ readonly ok: true; readonly selection: ResolvedAutopilotRosterSelection } | { readonly ok: false; readonly diagnostics: readonly RosterDiagnostic[]; readonly fileState: 'missing' | 'hash-mismatch' }> {
  try {
    const paths = resolveScopePathsForActivation({ scope: input.scope, ctx: input.ctx, stateRoot: input.stateRoot, trustedProjectRootOverride: input.trustedProjectRootOverride });
    const rosterPath = rosterRevisionPath(paths, input.ref);
    const read = await readAuthorityFileIfPresent(rosterPath, paths.authorityRoot);
    if (read === null) return { ok: false, diagnostics: dedupeRosterDiagnostics(['ROSTER_PINNED_SELECTION_UNAVAILABLE']), fileState: 'missing' };
    const observedHash = await productionRosterStorageCodec.hashBytes(read.bytes);
    if (observedHash !== input.ref.roster_sha256) return { ok: false, diagnostics: dedupeRosterDiagnostics(['ROSTER_READBACK_MISMATCH']), fileState: 'hash-mismatch' };
    const roster = parseAutopilotRosterContractJson('autopilot.roster.v1', Buffer.from(read.bytes).toString('utf8'));
    if (
      roster.scope !== input.scope ||
      roster.selected_scope !== input.scope ||
      roster.roster_id !== input.ref.roster_id ||
      roster.roster_revision !== input.ref.roster_revision ||
      roster.roster_sha256 !== input.ref.roster_sha256 ||
      roster.assignment_set_sha256 !== input.ref.assignment_set_sha256
    ) {
      return { ok: false, diagnostics: dedupeRosterDiagnostics(['ROSTER_READBACK_MISMATCH']), fileState: 'hash-mismatch' };
    }
    const parent = roster.assignments.find((assignment) => assignment.role === 'parent');
    if (parent === undefined || (parent.thinking !== 'high' && parent.thinking !== 'xhigh')) {
      return { ok: false, diagnostics: dedupeRosterDiagnostics(['ROSTER_READBACK_MISMATCH']), fileState: 'hash-mismatch' };
    }
    const customLaunchDiagnostics = await customRosterLaunchDiagnostics({ roster, paths });
    if (customLaunchDiagnostics.length === 0 && roster.generation_source !== 'user-custom' && !rosterIsReady(roster)) {
      return { ok: false, diagnostics: dedupeRosterDiagnostics(['ROSTER_QUALIFICATION_REQUIRED']), fileState: 'hash-mismatch' };
    }
    return {
      ok: true,
      selection: {
        source: input.source,
        existingRun: input.existingRun,
        scope: input.scope,
        roster_id: roster.roster_id,
        roster_revision: roster.roster_revision,
        roster_sha256: roster.roster_sha256 as Digest,
        assignment_set_sha256: roster.assignment_set_sha256 as Digest,
        config_sha256: input.configSha256,
        ...(customLaunchDiagnostics.length === 0 ? {} : { custom_launch_diagnostics: customLaunchDiagnostics }),
        parent: { model: parent.model, thinking: parent.thinking },
      },
    };
  } catch {
    return { ok: false, diagnostics: dedupeRosterDiagnostics(['ROSTER_READBACK_MISMATCH']), fileState: 'hash-mismatch' };
  }
}

async function loadRosterSelectionFromRefAnyScope(input: {
  readonly source: ResolvedAutopilotRosterSelection['source'];
  readonly existingRun: boolean;
  readonly ref: Pick<SavedRosterRef, 'roster_id' | 'roster_revision'> & { readonly roster_sha256: string; readonly assignment_set_sha256: string };
  readonly configSha256: Digest;
  readonly ctx: ExtensionCommandContextLike;
  readonly stateRoot?: string | undefined;
  readonly trustedProjectRootOverride?: string | undefined;
}): Promise<{ readonly ok: true; readonly selection: ResolvedAutopilotRosterSelection } | { readonly ok: false; readonly diagnostics: readonly RosterDiagnostic[]; readonly fileState: 'missing' | 'hash-mismatch' }> {
  const ref: SavedRosterRef = { roster_id: input.ref.roster_id, roster_revision: input.ref.roster_revision, roster_sha256: input.ref.roster_sha256 as RosterSha256, assignment_set_sha256: input.ref.assignment_set_sha256 as RosterSha256 };
  const user = await loadRosterSelectionFromRef({ ...input, ref, scope: 'user' });
  if (user.ok) return user;
  const trusted = await loadRosterSelectionFromRef({ ...input, ref, scope: 'trusted-project' });
  if (trusted.ok) return trusted;
  return user.fileState === 'missing' ? trusted : user;
}

function rosterIsReady(roster: RosterContract): boolean {
  return isCentrallyTrustedW4CertifiedRoster(roster);
}

class ProductionRosterActivationStore implements AutopilotRosterActivationStore {
  readonly #stateRoot: string | undefined;

  public constructor(stateRoot: string | undefined) {
    this.#stateRoot = stateRoot;
  }

  public async resolve(input: AutopilotRosterActivationResolveInput): Promise<AutopilotRosterActivationResolution> {
    const existing = await this.#resolveExistingRunIfPresent(input);
    if (existing !== null) return existing;

    let explicit: AuthorityRead | null = null;
    if (input.parsed.rosterId !== null) {
      explicit = await this.#readExplicitRoster(input.parsed.rosterId, input.ctx);
      return await this.#resolveAndCommitNewRun(input, { explicit });
    }

    const trusted = await this.#readDefaultRoster('trusted-project', input.ctx, 'trusted-project-default');
    const user = await this.#readDefaultRoster('user', input.ctx, 'user-default');
    return await this.#resolveAndCommitNewRun(input, { trusted, user });
  }

  async #resolveAndCommitNewRun(
    input: AutopilotRosterActivationResolveInput,
    authorities: { readonly explicit?: AuthorityRead | null | undefined; readonly trusted?: AuthorityRead | null | undefined; readonly user?: AuthorityRead | null | undefined },
  ): Promise<AutopilotRosterActivationResolution> {
    const selections = new Map<NewRunResolutionSource, ResolvedAutopilotRosterSelection>();
    if (authorities.explicit?.selection !== null && authorities.explicit?.selection !== undefined) selections.set('explicit-roster', authorities.explicit.selection);
    if (authorities.trusted?.selection !== null && authorities.trusted?.selection !== undefined) selections.set('trusted-project-default', authorities.trusted.selection);
    if (authorities.user?.selection !== null && authorities.user?.selection !== undefined) selections.set('user-default', authorities.user.selection);

    const resolution = resolveNewRun({
      ...(authorities.explicit === undefined ? {} : { explicit_roster: authorities.explicit?.authority ?? null }),
      ...(authorities.trusted === undefined ? {} : { trusted_project_default: authorities.trusted?.authority ?? null }),
      ...(authorities.user === undefined ? {} : { user_default: authorities.user?.authority ?? null }),
    });
    if (resolution.status === 'onboarding-required') return setupRequiredResolution();
    if (!resolution.ok) return { status: 'blocked', source: resolution.source, diagnostics: resolution.diagnostics };

    const selected = selections.get(resolution.source);
    if (selected === undefined) return blockedResolution(resolution.source, ['ROSTER_READBACK_MISMATCH']);
    const readiness = rosterSelectionReadiness(selected);
    if (readiness.length > 0) return { status: 'blocked', source: resolution.source, diagnostics: readiness };

    let repoKey: string;
    try {
      repoKey = resolveRepoIdentity(input.ctx.cwd ?? process.cwd()).repoKey;
    } catch {
      return blockedResolution(resolution.source, ['ROSTER_TRANSITION_REQUIRED']);
    }

    const commit = await resolveAndCommitPreRunSelection({
      repo_id: repoKey,
      workstream_run: input.plannedWorkstreamRun,
      explicit_roster: runSelectionAuthority(authorities.explicit),
      trusted_project_default: runSelectionAuthority(authorities.trusted),
      user_default: runSelectionAuthority(authorities.user),
      ...(this.#stateRoot === undefined ? {} : { stateRoot: this.#stateRoot }),
      selected_at: input.now.toISOString(),
      issued_at: input.now.toISOString(),
    });
    if (commit.status === 'setup-required') return setupRequiredResolution();
    if (!commit.ok || commit.selection === null || commit.selection_bytes === null || commit.selection_path === null || commit.launch_fence === null) {
      return { status: 'blocked', source: commit.source, diagnostics: dedupeRosterDiagnostics(commit.diagnostics.map((diagnostic) => diagnostic.code)) };
    }
    if (
      commit.selection.roster_id !== selected.roster_id ||
      commit.selection.roster_revision !== selected.roster_revision ||
      commit.selection.roster_sha256 !== selected.roster_sha256 ||
      commit.selection.assignment_set_sha256 !== selected.assignment_set_sha256 ||
      commit.selection.config_sha256 !== selected.config_sha256
    ) {
      return blockedResolution(resolution.source, ['ROSTER_READBACK_MISMATCH']);
    }
    return {
      status: 'resolved',
      diagnostics: dedupeRosterDiagnostics(commit.diagnostics.map((diagnostic) => diagnostic.code)),
      selection: {
        ...selected,
        existingRun: false,
        workstream_run: commit.selection.workstream_run,
        pre_run_selection: commit.selection,
        pre_run_selection_path: commit.selection_path,
        selection_bytes: commit.selection_bytes,
        launch_fence: commit.launch_fence,
        runtime_mirror_path: null,
      },
    };
  }

  async #readDefaultRoster(
    scope: RosterStorageScope,
    ctx: ExtensionCommandContextLike,
    source: Extract<NewRunResolutionSource, 'trusted-project-default' | 'user-default'>,
  ): Promise<AuthorityRead> {
    if (scope === 'trusted-project' && !(await projectTrusted(ctx))) {
      return { authority: authorityFor({ source, state: 'absent', scope, trusted: false }), selection: null };
    }
    const storage = createProductionRosterStorage(this.#stateRoot);
    const trustedProject = scope === 'trusted-project' ? trustedProjectContext(ctx) : undefined;
    const result = await storage.readDefaultRoster(
      trustedProject === undefined ? { scope } : { scope, trustedProject },
    );
    if (!result.ok) {
      const corrupt = authorityFor({ source, state: 'corrupt', scope, trusted: scope === 'trusted-project' ? true : undefined });
      return { authority: corrupt, selection: null };
    }
    if (result.default_roster === null) {
      return { authority: authorityFor({ source, state: 'absent', scope, trusted: scope === 'trusted-project' ? true : undefined }), selection: null };
    }
    if (result.config_sha256 === null) {
      return { authority: authorityFor({ source, state: 'corrupt', scope, ref: result.default_roster, trusted: scope === 'trusted-project' ? true : undefined }), selection: null };
    }
    const loaded = await loadRosterSelectionFromRef({
      source,
      existingRun: false,
      scope,
      ref: result.default_roster,
      configSha256: result.config_sha256 as Digest,
      ctx,
      stateRoot: this.#stateRoot,
    });
    if (!loaded.ok) {
      return { authority: authorityFor({ source, state: loaded.fileState === 'missing' ? 'missing' : 'corrupt', scope, ref: result.default_roster, trusted: scope === 'trusted-project' ? true : undefined }), selection: null };
    }
    return { authority: authorityFor({ source, state: 'present', scope, ref: result.default_roster, trusted: scope === 'trusted-project' ? true : undefined }), selection: loaded.selection };
  }

  async #readExplicitRoster(rosterId: string, ctx: ExtensionCommandContextLike): Promise<AuthorityRead> {
    const projectTrustedNow = await projectTrusted(ctx);
    if (projectTrustedNow) {
      const project = await this.#readExplicitRosterFromScope(rosterId, 'trusted-project', ctx);
      if (project.authority.state !== 'absent') return project;
    }
    const user = await this.#readExplicitRosterFromScope(rosterId, 'user', ctx);
    if (user.authority.state !== 'absent') return user;
    return { authority: authorityFor({ source: 'explicit-roster', state: 'missing', scope: 'user' }), selection: null };
  }

  async #readExplicitRosterFromScope(rosterId: string, scope: RosterStorageScope, ctx: ExtensionCommandContextLike): Promise<AuthorityRead> {
    const storage = createProductionRosterStorage(this.#stateRoot);
    const trustedProject = scope === 'trusted-project' ? trustedProjectContext(ctx) : undefined;
    const result = await storage.readDefaultRoster(trustedProject === undefined ? { scope } : { scope, trustedProject });
    if (!result.ok) {
      return { authority: authorityFor({ source: 'explicit-roster', state: 'corrupt', scope, trusted: scope === 'trusted-project' ? true : undefined }), selection: null };
    }
    if (result.config === null) {
      return { authority: authorityFor({ source: 'explicit-roster', state: 'absent', scope, trusted: scope === 'trusted-project' ? true : undefined }), selection: null };
    }
    const matches = result.config.rosters.filter((ref) => ref.roster_id === rosterId);
    if (matches.length === 0) {
      return { authority: authorityFor({ source: 'explicit-roster', state: 'absent', scope, trusted: scope === 'trusted-project' ? true : undefined }), selection: null };
    }
    if (matches.length !== 1) {
      return { authority: authorityFor({ source: 'explicit-roster', state: 'corrupt', scope, trusted: scope === 'trusted-project' ? true : undefined }), selection: null };
    }
    const ref = matches[0];
    if (ref === undefined) return { authority: authorityFor({ source: 'explicit-roster', state: 'corrupt', scope, trusted: scope === 'trusted-project' ? true : undefined }), selection: null };
    if (result.config_sha256 === null) return { authority: authorityFor({ source: 'explicit-roster', state: 'corrupt', scope, ref, trusted: scope === 'trusted-project' ? true : undefined }), selection: null };
    const loaded = await loadRosterSelectionFromRef({ source: 'explicit-roster', existingRun: false, scope, ref, configSha256: result.config_sha256 as Digest, ctx, stateRoot: this.#stateRoot });
    if (!loaded.ok) {
      return { authority: authorityFor({ source: 'explicit-roster', state: loaded.fileState === 'missing' ? 'missing' : 'corrupt', scope, ref, trusted: scope === 'trusted-project' ? true : undefined }), selection: null };
    }
    return { authority: authorityFor({ source: 'explicit-roster', state: 'present', scope, ref, trusted: scope === 'trusted-project' ? true : undefined }), selection: { ...loaded.selection, source: 'explicit-roster' } };
  }

  async #resolveExistingRunIfPresent(input: AutopilotRosterActivationResolveInput): Promise<AutopilotRosterActivationResolution | null> {
    const active = await this.#findMatchingActiveRun(input.parsed.workstream, input.ctx, input.env);
    if (active === null) return null;
    if (active === 'failed') return blockedResolution('existing-run-selection', ['ROSTER_TRANSITION_REQUIRED']);
    if (active === 'ambiguous') return blockedResolution('existing-run-selection', ['ROSTER_TRANSITION_REQUIRED']);
    const pinned = await this.#readPinnedSelection(active, input.ctx);
    if (!pinned.ok) {
      const paused = await this.#pauseLegacyActiveRunForRosterTransition(active, input.env);
      if (!paused.ok) return blockedResolution('existing-run-selection', ['ROSTER_PINNED_SELECTION_UNAVAILABLE', 'ROSTER_TRANSITION_REQUIRED']);
      if (input.parsed.rosterId !== null && pinned.recovered_selection !== null) {
        return await this.#resolveOrProposeExistingRunTransition(input, paused.active, pinned.recovered_selection, pinned.external_selection_path, pinned.runtime_mirror_path, pinned.diagnostics);
      }
      return blockedResolution('existing-run-selection', ['ROSTER_PINNED_SELECTION_UNAVAILABLE', 'ROSTER_TRANSITION_REQUIRED']);
    }
    const fromRef = savedRosterRefForSelection({ selection: pinned.recovered_selection, stateRoot: this.#stateRoot, trustedProjectRoot: active.source_repo });
    const chain = await resolveCommittedExistingRunRosterTransitionChain({
      ...(this.#stateRoot === undefined ? {} : { stateRoot: this.#stateRoot }),
      run: transitionRunRef(active),
      initial_from_roster: fromRef,
    });
    if (!chain.ok) return { status: 'blocked', source: 'existing-run-selection', diagnostics: dedupeRosterDiagnostics(chain.diagnostics.map((diagnostic) => diagnostic.code)) };
    if (chain.terminal_successor_attempt_authority !== null) {
      if (input.parsed.rosterId !== null && chain.terminal_roster.roster_id !== input.parsed.rosterId) {
        const paused = await this.#pauseLegacyActiveRunForRosterTransition(active, input.env);
        if (!paused.ok) return blockedResolution('existing-run-selection', ['ROSTER_TRANSITION_REQUIRED']);
        return await this.#resolveOrProposeExistingRunTransition(input, paused.active, pinned.recovered_selection, pinned.external_selection_path, pinned.runtime_mirror_path, [rosterDiagnostic('ROSTER_TRANSITION_REQUIRED')], chain.terminal_roster);
      }
      const terminalLoaded = await loadRosterSelectionFromRefAnyScope({
        source: 'existing-run-selection',
        existingRun: true,
        ref: chain.terminal_roster,
        configSha256: pinned.recovered_selection.config_sha256,
        ctx: input.ctx,
        stateRoot: this.#stateRoot,
        trustedProjectRootOverride: active.source_repo,
      });
      if (!terminalLoaded.ok) return { status: 'blocked', source: 'existing-run-selection', diagnostics: terminalLoaded.diagnostics };
      const terminalReadiness = rosterSelectionReadiness(terminalLoaded.selection);
      if (terminalReadiness.length > 0) return { status: 'blocked', source: 'existing-run-selection', diagnostics: terminalReadiness };
      return {
        status: 'resolved',
        diagnostics: [],
        selection: {
          ...terminalLoaded.selection,
          source: 'existing-run-selection',
          existingRun: true,
          workstream_run: pinned.recovered_selection.workstream_run,
          pre_run_selection: pinned.recovered_selection,
          pre_run_selection_path: pinned.external_selection_path,
          selection_bytes: null,
          launch_fence: null,
          runtime_mirror_path: pinned.runtime_mirror_path,
          successor_attempt_authority: chain.terminal_successor_attempt_authority,
        },
      };
    }
    if (input.parsed.rosterId !== null && pinned.selection.roster_id !== input.parsed.rosterId) {
      const paused = await this.#pauseLegacyActiveRunForRosterTransition(active, input.env);
      if (!paused.ok) return blockedResolution('existing-run-selection', ['ROSTER_TRANSITION_REQUIRED']);
      return await this.#resolveOrProposeExistingRunTransition(input, paused.active, pinned.recovered_selection, pinned.external_selection_path, pinned.runtime_mirror_path, [rosterDiagnostic('ROSTER_TRANSITION_REQUIRED')]);
    }
    const readiness = rosterSelectionReadiness(pinned.selection);
    if (readiness.length > 0) return { status: 'blocked', source: 'existing-run-selection', diagnostics: readiness };
    return { status: 'resolved', selection: pinned.selection, diagnostics: [] };
  }

  async #findMatchingActiveRun(workstream: string, ctx: ExtensionCommandContextLike, env: ProcessEnvLike): Promise<ActiveAutopilotRow | 'ambiguous' | 'failed' | null> {
    try {
      const repo = resolveRepoIdentity(ctx.cwd ?? process.cwd());
      const stateRoot = resolveAutopilotStateRoot(env);
      const rows = coordinationCutoverCommitted(stateRoot, repo.repoKey)
        ? await readCoordinatorActiveAutopilots(repo, worktreeRootForRepo(repo.repoKey, env), env)
        : await readActiveAutopilots(coordinationRootForRepo(repo.repoKey, env));
      const matching = rows.filter((row) => row.repo_key === repo.repoKey && row.workstream === workstream && LIVE_PARENT_STATUSES.has(row.status));
      if (matching.length === 0) return null;
      if (matching.length > 1) return 'ambiguous';
      return matching[0] ?? null;
    } catch {
      return 'failed';
    }
  }

  async #readPinnedSelection(active: ActiveAutopilotRow, ctx: ExtensionCommandContextLike): Promise<PinnedExistingRunSelectionRead> {
    try {
      const recovery = await recoverRuntimeRosterSelection({
        ...(this.#stateRoot === undefined ? {} : { stateRoot: this.#stateRoot }),
        mainWorktreeRoot: active.main_worktree_path,
        workstream: active.workstream,
        repo_id: active.repo_key,
        workstream_run: active.workstream_run,
        spec_identity: null,
        require_spec_identity: false,
      });
      if (!recovery.ok || recovery.selection === null) {
        return {
          ok: false,
          recovered_selection: recovery.selection,
          external_selection_path: recovery.external_selection_path,
          runtime_mirror_path: recovery.runtime_mirror_path,
          diagnostics: dedupeRosterDiagnostics(recovery.diagnostics.map((diagnostic) => diagnostic.code)),
          file_state: 'recovery-failed',
        };
      }
      const selection = recovery.selection;
      const loaded = await loadRosterSelectionFromRef({
        source: 'existing-run-selection',
        existingRun: true,
        scope: selection.scope,
        ref: {
          roster_id: selection.roster_id,
          roster_revision: selection.roster_revision,
          roster_sha256: selection.roster_sha256 as RosterSha256,
          assignment_set_sha256: selection.assignment_set_sha256 as RosterSha256,
        },
        configSha256: selection.config_sha256,
        ctx,
        stateRoot: this.#stateRoot,
        trustedProjectRootOverride: active.source_repo,
      });
      if (!loaded.ok) {
        return {
          ok: false,
          recovered_selection: selection,
          external_selection_path: recovery.external_selection_path,
          runtime_mirror_path: recovery.runtime_mirror_path,
          diagnostics: dedupeRosterDiagnostics([...loaded.diagnostics.map((diagnostic) => diagnostic.code), 'ROSTER_TRANSITION_REQUIRED']),
          file_state: loaded.fileState,
        };
      }
      return {
        ok: true,
        recovered_selection: selection,
        external_selection_path: recovery.external_selection_path,
        runtime_mirror_path: recovery.runtime_mirror_path,
        selection: {
          ...loaded.selection,
          workstream_run: selection.workstream_run,
          pre_run_selection: selection,
          pre_run_selection_path: recovery.external_selection_path,
          selection_bytes: null,
          launch_fence: null,
          runtime_mirror_path: recovery.runtime_mirror_path,
        },
      };
    } catch {
      return { ok: false, recovered_selection: null, external_selection_path: null, runtime_mirror_path: null, diagnostics: dedupeRosterDiagnostics(['ROSTER_READBACK_MISMATCH', 'ROSTER_TRANSITION_REQUIRED']), file_state: 'recovery-failed' };
    }
  }

  async #resolveOrProposeExistingRunTransition(
    input: AutopilotRosterActivationResolveInput,
    active: ActiveAutopilotRow,
    fromSelection: PreRunSelection,
    externalSelectionPath: string | null,
    runtimeMirrorPath: string | null,
    priorDiagnostics: readonly RosterDiagnostic[],
    fromRosterOverride?: ReturnType<typeof savedRosterRefForSelection> | undefined,
  ): Promise<AutopilotRosterActivationResolution> {
    if (input.parsed.rosterId === null) return { status: 'blocked', source: 'existing-run-selection', diagnostics: priorDiagnostics };
    const explicit = await this.#readExplicitRoster(input.parsed.rosterId, input.ctx);
    if (explicit.selection === null) {
      return { status: 'blocked', source: 'existing-run-selection', diagnostics: dedupeRosterDiagnostics([...priorDiagnostics.map((diagnostic) => diagnostic.code), 'ROSTER_TRANSITION_REQUIRED']) };
    }
    const explicitReadiness = rosterSelectionReadiness(explicit.selection);
    if (explicitReadiness.length > 0) {
      return { status: 'blocked', source: 'existing-run-selection', diagnostics: dedupeRosterDiagnostics([...priorDiagnostics.map((diagnostic) => diagnostic.code), ...explicitReadiness.map((diagnostic) => diagnostic.code), 'ROSTER_TRANSITION_REQUIRED']) };
    }
    const run = transitionRunRef(active);
    const fromRef = fromRosterOverride ?? savedRosterRefForSelection({ selection: fromSelection, stateRoot: this.#stateRoot, trustedProjectRoot: active.source_repo });
    const toRef = savedRosterRefForSelection({ selection: explicit.selection, stateRoot: this.#stateRoot, trustedProjectRoot: active.source_repo });
    const consumed = await consumeCommittedExistingRunRosterTransition({
      ...(this.#stateRoot === undefined ? {} : { stateRoot: this.#stateRoot }),
      run,
      from_roster: fromRef,
      to_roster: toRef,
    });
    if (consumed.ok && consumed.successor_attempt_authority !== null) {
      return {
        status: 'resolved',
        diagnostics: dedupeRosterDiagnostics(consumed.diagnostics.map((diagnostic) => diagnostic.code)),
        selection: {
          ...explicit.selection,
          source: 'existing-run-selection',
          existingRun: true,
          workstream_run: fromSelection.workstream_run,
          pre_run_selection: fromSelection,
          pre_run_selection_path: externalSelectionPath ?? undefined,
          selection_bytes: null,
          launch_fence: null,
          runtime_mirror_path: runtimeMirrorPath,
          successor_attempt_authority: consumed.successor_attempt_authority,
        },
      };
    }
    if (consumed.status === 'failed') {
      return { status: 'blocked', source: 'existing-run-selection', diagnostics: dedupeRosterDiagnostics([...priorDiagnostics.map((diagnostic) => diagnostic.code), ...consumed.diagnostics.map((diagnostic) => diagnostic.code)]) };
    }
    const proposal = buildExistingRunRosterTransitionProposal({
      ...(this.#stateRoot === undefined ? {} : { stateRoot: this.#stateRoot }),
      run,
      from_roster: fromRef,
      to_roster: toRef,
      reason: `User requested explicit roster ${input.parsed.rosterId} for existing Autopilot run ${active.workstream_run}.`,
      approved_at: input.now.toISOString(),
    });
    return {
      status: 'transition-approval-required',
      source: 'existing-run-selection',
      proposal,
      run,
      active,
      originalCommand: input.originalCommand,
      diagnostics: dedupeRosterDiagnostics([...priorDiagnostics.map((diagnostic) => diagnostic.code), 'ROSTER_TRANSITION_REQUIRED']),
    };
  }

  async #pauseLegacyActiveRunForRosterTransition(active: ActiveAutopilotRow, env: ProcessEnvLike): Promise<{ readonly ok: true; readonly active: ActiveAutopilotRow } | { readonly ok: false }> {
    if (active.coordination_authority !== 'legacy-path-claims-v1') return { ok: false };
    const coordinationRoot = coordinationRootForRepo(active.repo_key, env);
    const lockPath = `${coordinationRoot}/.locks/activation.lock`;
    try {
      return await withAutopilotFileLock(lockPath, `roster-transition-pause:${active.autopilot_id}:${active.workstream_run}`, async () => {
        const rows = await readActiveAutopilots(coordinationRoot);
        const index = rows.findIndex((row) => row.autopilot_id === active.autopilot_id && row.workstream_run === active.workstream_run);
        if (index < 0) return { ok: false };
        const current = rows[index];
        if (current === undefined || !sameActiveRunForTransition(current, active)) return { ok: false };
        const paused: ActiveAutopilotRow = { ...current, status: 'paused' as const };
        const next = rows.map((row, rowIndex) => rowIndex === index ? paused : row);
        await writeActiveAutopilots(coordinationRoot, next);
        const readback = await readActiveAutopilots(coordinationRoot);
        const confirmed = readback.find((row) => row.autopilot_id === active.autopilot_id && row.workstream_run === active.workstream_run);
        if (confirmed === undefined || confirmed.status !== 'paused' || !sameActiveRunForTransition(confirmed, paused)) return { ok: false };
        return { ok: true as const, active: confirmed };
      });
    } catch {
      return { ok: false };
    }
  }
}

function setupGuidancePrompt(input: {
  readonly package: VerifiedAutopilotRosterSetupSkillPackage;
  readonly activationToken: string;
  readonly originalCommand: string;
}): string {
  return [
    `/skill:${input.package.name}`,
    '',
    'Autopilot roster setup is required before this run can start. The setup lane is active only for the current ordinary Pi session.',
    `Activation token: ${input.activationToken}`,
    `Original command: ${input.originalCommand}`,
    `Packaged setup skill: ${input.package.skillRelativePath} ${input.package.skillSha256}`,
    `Packaged setup payload: ${input.package.payloadRelativePath} ${input.package.payloadSha256}`,
    '',
    'Use the packaged skill instructions below exactly. Stay pre-run: do not create worktrees, start child agents, select models for work, or spend provider calls for Autopilot work. After a successful save, do not auto-start; tell the user to open a fresh Pi session and retry exactly the original command.',
    '',
    '--- PACKAGED SKILL START ---',
    input.package.skillText,
    '--- PACKAGED SKILL END ---',
  ].join('\n');
}

function setupRequiredMessage(codes: readonly RosterDiagnostic[]): string {
  const suffix = codes.length === 0 ? '' : ` Diagnostics: ${codes.map((diagnostic) => diagnostic.code).join(', ')}.`;
  return `Autopilot roster setup is required before this run can start.${suffix} I activated the setup tool for this session only; save requires a fresh Pi session before retrying.`;
}

function setupRestartRequiredMessage(originalCommand: string): string {
  return `Autopilot roster setup was saved in this Pi session. Start a fresh Pi session, then retry exactly the original command: ${originalCommand}`;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  return value as Readonly<Record<string, unknown>>;
}

function provenSavedRosterSetupResult(value: unknown): { readonly originalCommand: string } | null {
  const record = plainRecord(value);
  if (record === null) return null;
  if (record['schema_version'] === 'autopilot.roster_tool_result.v1') return provenSavedRosterSetupResultV1(record);
  if (record['schema_version'] === 'autopilot.roster_tool_result.v2') return provenSavedRosterSetupResultV2(record);
  return null;
}

function provenSavedRosterSetupResultV1(record: Readonly<Record<string, unknown>>): { readonly originalCommand: string } | null {
  try {
    const parsed = parseAutopilotRosterContract('autopilot.roster_tool_result.v1', record);
    if (parsed.action !== 'save' || parsed.ok !== true || parsed.status !== 'saved') return null;
    return provenSavedRosterSetupReceipt(parsed.receipt);
  } catch {
    return null;
  }
}

function provenSavedRosterSetupResultV2(record: Readonly<Record<string, unknown>>): { readonly originalCommand: string } | null {
  try {
    const expectedKeys = new Set([
      'schema_version',
      'action',
      'ok',
      'status',
      'candidate_set',
      'custom_proposal',
      'custom_validation',
      'custom_roster',
      'approval_binding',
      'receipt',
      'custom_receipt',
      'diagnostics',
      'write_count',
      'lock_count',
      'files_touched',
      'result_sha256',
    ]);
    const keys = Object.keys(record);
    if (keys.length !== expectedKeys.size || !keys.every((key) => expectedKeys.has(key))) return null;
    if (record['action'] !== 'save' || record['ok'] !== true || record['status'] !== 'saved') return null;
    const resultSha = typeof record['result_sha256'] === 'string' ? record['result_sha256'] : null;
    if (resultSha === null) return null;
    const preimage = { ...record } as Record<string, unknown>;
    delete preimage['result_sha256'];
    if (canonicalSha256(preimage) !== resultSha) return null;
    const receipt = provenSavedRosterSetupReceipt(record['receipt']);
    if (receipt === null) return null;
    const customReceipt = record['custom_receipt'];
    if (customReceipt !== null && !provenCustomSavedReceiptV2(customReceipt, record['receipt'])) return null;
    return receipt;
  } catch {
    return null;
  }
}

function provenCustomSavedReceiptV2(value: unknown, storageReceipt: unknown): boolean {
  const custom = plainRecord(value);
  const receipt = plainRecord(storageReceipt);
  if (custom === null || receipt === null) return false;
  const expectedKeys = new Set([
    'schema_version',
    'custom_proposal_sha256',
    'validation_result_sha256',
    'roster_sha256',
    'manifest_sha256',
    'approval_sha256',
    'storage_receipt_sha256',
    'config_sha256',
    'custom_authority_path',
    'custom_authority_sha256',
    'zero_secrets',
    'fresh_session_required',
    'receipt_sha256',
  ]);
  const keys = Object.keys(custom);
  if (keys.length !== expectedKeys.size || !keys.every((key) => expectedKeys.has(key))) return false;
  if (custom['schema_version'] !== 'autopilot.custom_roster_setup_receipt.v2') return false;
  if (custom['fresh_session_required'] !== true || custom['zero_secrets'] !== true) return false;
  if (custom['storage_receipt_sha256'] !== receipt['receipt_sha256'] || custom['config_sha256'] !== receipt['config_sha256']) return false;
  const receiptSha = typeof custom['receipt_sha256'] === 'string' ? custom['receipt_sha256'] : null;
  if (receiptSha === null) return false;
  const preimage = { ...custom } as Record<string, unknown>;
  delete preimage['receipt_sha256'];
  return canonicalSha256(preimage) === receiptSha;
}

function provenSavedRosterSetupReceipt(value: unknown): { readonly originalCommand: string } | null {
  try {
    const receipt = parseAutopilotRosterContract('autopilot.roster_setup_receipt.v1', value);
    if (receipt.fresh_session_required !== true || receipt.zero_secrets !== true) return null;
    const originalCommand = receipt.original_command;
    if (originalCommand.length === 0) return null;
    return { originalCommand };
  } catch {
    return null;
  }
}

function formatDiagnostics(diagnostics: readonly RosterDiagnostic[]): string {
  return diagnostics.length === 0 ? 'none' : diagnostics.map((diagnostic) => diagnostic.code).join(', ');
}

function materializeRosterForCandidate(candidate: RosterCandidate, scope: RosterStorageScope): RosterContract {
  if (!isLaunchableRosterCandidate(candidate)) throw new Error('candidate roster is not launchable');
  const seed = seedRosterByCandidate(candidate);
  if (seed === null) throw new Error('candidate roster is unavailable');
  const withoutHash = { ...seed, scope, selected_scope: scope, roster_sha256: ZERO_ROSTER_SHA };
  const roster = {
    ...withoutHash,
    roster_sha256: autopilotRosterContractSha256OmittingOwnField(withoutHash, 'roster_sha256'),
  };
  const parsed = parseAutopilotRosterContract('autopilot.roster.v1', roster);
  if (parsed.roster_sha256 !== candidate.roster_sha256) throw new Error('candidate roster hash drift');
  return parsed;
}

function materializeRosterPublicationForCandidate(input: {
  readonly candidate: RosterCandidate;
  readonly scope: RosterStorageScope;
  readonly customRosters?: ReadonlyMap<Digest, RosterContract> | ReadonlyMap<Digest, unknown> | undefined;
  readonly customRosterBytes?: ReadonlyMap<Digest, Uint8Array> | undefined;
  readonly customManifests?: ReadonlyMap<Digest, QualificationManifest> | undefined;
  readonly customValidations?: ReadonlyMap<Digest, { readonly ok: boolean; readonly status: string; readonly result_sha256: Digest }> | undefined;
}): { readonly roster: RosterContract; readonly bytes: Uint8Array; readonly custom_manifest: QualificationManifest | null; readonly custom_validation_result_sha256: Digest | null } {
  const bytes = input.customRosterBytes?.get(input.candidate.roster_sha256);
  if (bytes === undefined) {
    const roster = materializeRosterForCandidate(input.candidate, input.scope);
    return { roster, bytes: rosterBytes(roster), custom_manifest: null, custom_validation_result_sha256: null };
  }
  const manifest = input.customManifests?.get(input.candidate.roster_sha256);
  const validation = input.customValidations?.get(input.candidate.roster_sha256);
  if (bytes === undefined || manifest === undefined || validation === undefined || validation.ok !== true || validation.status !== 'certified') {
    throw new Error('custom candidate exact validation evidence is unavailable');
  }
  const roster = parseAutopilotRosterContractJson('autopilot.roster.v1', Buffer.from(bytes).toString('utf8'));
  if (
    roster.generation_source !== 'user-custom' ||
    roster.scope !== input.scope ||
    roster.selected_scope !== input.scope ||
    roster.roster_id !== input.candidate.roster_id ||
    roster.roster_revision !== input.candidate.roster_revision ||
    roster.roster_sha256 !== input.candidate.roster_sha256 ||
    roster.assignment_set_sha256 !== input.candidate.assignment_set_sha256
  ) {
    throw new Error('custom candidate roster bytes drifted');
  }
  const providerRoster = parseProviderRoster(roster);
  const verification = verifyCustomRosterManifestForRoster({ roster: providerRoster, manifest });
  if (!verification.ok) throw new Error('custom roster registry verification failed closed');
  return { roster, bytes: Buffer.from(bytes), custom_manifest: manifest, custom_validation_result_sha256: validation.result_sha256 };
}

function rosterBytes(roster: RosterContract): Uint8Array {
  return new TextEncoder().encode(autopilotRosterContractCanonicalJson(roster));
}

function buildRosterConfig(input: {
  readonly scope: RosterStorageScope;
  readonly rosters: readonly RosterContract[];
  readonly default_roster_id: string;
  readonly default_roster_revision: number;
  readonly default_roster_sha256: Digest;
  readonly previous_config_sha256: RosterSha256 | null;
  readonly stateRoot?: string | undefined;
  readonly trustedProjectRoot?: string | undefined;
  readonly now: Date;
}): { readonly config: RosterConfigContract; readonly bytes: Uint8Array } {
  const paths = input.scope === 'trusted-project'
    ? input.stateRoot === undefined
      ? resolveRosterScopePaths({ scope: input.scope, trustedProjectRoot: input.trustedProjectRoot })
      : resolveRosterScopePaths({ scope: input.scope, stateRoot: input.stateRoot, trustedProjectRoot: input.trustedProjectRoot })
    : input.stateRoot === undefined
      ? resolveRosterScopePaths({ scope: input.scope })
      : resolveRosterScopePaths({ scope: input.scope, stateRoot: input.stateRoot });
  const refs = input.rosters.map((roster) => {
    const ref: SavedRosterRef = {
      roster_id: roster.roster_id,
      roster_revision: roster.roster_revision,
      roster_sha256: roster.roster_sha256 as RosterSha256,
      assignment_set_sha256: roster.assignment_set_sha256 as RosterSha256,
    };
    return {
      ...ref,
      path: formatAuthorityPath(rosterRevisionPath(paths, ref), paths.authorityRoot, paths.authorityDisplayRoot),
    };
  });
  const withoutHash = {
    schema_version: 'autopilot.roster_config.v1' as const,
    scope: input.scope,
    default_roster_id: input.default_roster_id,
    default_roster_revision: input.default_roster_revision,
    default_roster_sha256: input.default_roster_sha256,
    rosters: refs,
    previous_config_sha256: input.previous_config_sha256,
    updated_at: input.now.toISOString(),
    config_sha256: ZERO_ROSTER_SHA,
  };
  const config = {
    ...withoutHash,
    config_sha256: autopilotRosterContractSha256OmittingOwnField(withoutHash, 'config_sha256'),
  };
  const parsed = parseAutopilotRosterContract('autopilot.roster_config.v1', config);
  return { config: parsed, bytes: new TextEncoder().encode(autopilotRosterContractCanonicalJson(parsed)) };
}

type TrustedProjectStorageContext = { readonly root: string; readonly isProjectTrusted: () => boolean | Promise<boolean> };

type TrustedProjectResolution =
  | { readonly ok: true; readonly trustedProject: TrustedProjectStorageContext | undefined; readonly trustedProjectRoot: string | undefined }
  | { readonly ok: false; readonly diagnostics: readonly RosterDiagnostic[] };

export async function trustedProjectForRequest(
  request: { readonly scope: RosterStorageScope; readonly trusted_project_root: string | null },
  ctx: unknown,
): Promise<TrustedProjectResolution> {
  if (request.scope !== 'trusted-project') return { ok: true, trustedProject: undefined, trustedProjectRoot: undefined };
  const commandCtx = commandContextFromUnknown(ctx);
  if (commandCtx === null || request.trusted_project_root === null) {
    return { ok: false, diagnostics: [rosterDiagnostic('ROSTER_STORAGE_TRUST_REQUIRED')] };
  }
  const hostRoot = normalizeTrustedProjectRoot(trustedProjectRoot(commandCtx));
  const requestedRoot = normalizeTrustedProjectRoot(request.trusted_project_root);
  if (hostRoot === null || requestedRoot === null || hostRoot !== requestedRoot) {
    return { ok: false, diagnostics: [rosterDiagnostic('ROSTER_STORAGE_TRUST_REQUIRED')] };
  }
  if (!await projectTrusted(commandCtx)) {
    return { ok: false, diagnostics: [rosterDiagnostic('ROSTER_STORAGE_TRUST_REQUIRED')] };
  }
  return {
    ok: true,
    trustedProject: { root: hostRoot, isProjectTrusted: () => projectTrusted(commandCtx) },
    trustedProjectRoot: hostRoot,
  };
}

function commandContextFromUnknown(ctx: unknown): ExtensionCommandContextLike | null {
  if (typeof ctx !== 'object' || ctx === null) return null;
  return ctx as ExtensionCommandContextLike;
}

function normalizeTrustedProjectRoot(path: string): string | null {
  try {
    return realpathSync(resolve(path));
  } catch {
    return null;
  }
}

function notify(ctx: ExtensionCommandContextLike, message: string, kind: NotificationKind): void {
  ctx.ui.notify(message, kind);
}

/**
 * The default external launch signer resolver. It reads a mode-0600
 * `signer-invocation.json` from the sealed program evidence root that names the
 * absolute `command`, optional base `args`, and the signer config path. The
 * runtime never learns the operator private key path; the signer CLI resolves it
 * from its own config. This keeps signing entirely outside runtime authority.
 */
function defaultLaunchSignerResolver(manifest: D65LaunchManifest, env: ProcessEnvLike): D65LaunchSigner {
  const invocationPath = resolve(manifest.program_evidence_root, 'signer-invocation.json');
  const invocationBytes = readImmutableFileBytes({ path: invocationPath, maximumBytes: 65_536, label: 'launch signer invocation', errorCode: 'invalid-request' });
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(invocationBytes)) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('launch signer invocation must be an object');
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['config_path', 'node', 'schema_version', 'signer_bin'];
  if (keys.length !== expected.length || expected.some((field, index) => keys[index] !== field)) throw new Error('launch signer invocation must have exactly schema_version, node, signer_bin, config_path');
  if (record['schema_version'] !== 'autopilot.launch_signer_invocation.v1') throw new Error('launch signer invocation schema is wrong');
  const node = record['node'];
  const signerBin = record['signer_bin'];
  const configPath = record['config_path'];
  // The command is pinned to the current Node executable launching the PACKAGED
  // signer bin (autopilot-launch-signer.mjs) — never an arbitrary executable —
  // and the only permitted argument is `--config <absolute-path>`.
  if (typeof node !== 'string' || node !== process.execPath) throw new Error('launch signer invocation node must equal the current Node executable');
  if (typeof signerBin !== 'string' || !signerBin.startsWith('/') || !/[\\/]bin[\\/]autopilot-launch-signer\.mjs$/u.test(signerBin)) throw new Error('launch signer invocation signer_bin must be the packaged autopilot-launch-signer.mjs bin');
  const signerBinReal = realpathSync(signerBin);
  const expectedSignerBin = realpathSync(fileURLToPath(new URL('../bin/autopilot-launch-signer.mjs', import.meta.url)));
  if (signerBinReal !== expectedSignerBin) throw new Error('launch signer invocation signer_bin is not this package\'s autopilot-launch-signer.mjs');
  if (typeof configPath !== 'string' || !configPath.startsWith('/')) throw new Error('launch signer invocation config_path must be an absolute path');
  return new SpawnedD65LaunchSigner({ command: node, baseArgs: [signerBin, '--config', configPath], env });
}

export default function autopilotExtension(pi: ExtensionHostLike, dependencies: AutopilotExtensionDependencies = {}): void {
  const rosterActivationStore = dependencies.rosterActivationStore ?? new ProductionRosterActivationStore(dependencies.rosterStateRoot);
  const prepareWorkstream = dependencies.prepareAutopilotWorkstream ?? prepareAutopilotWorkstream;
  const publishRosterSnapshot = dependencies.publishRuntimeRosterSnapshot ?? publishRuntimeRosterSnapshot;
  const resolveSetupSkillPackage = dependencies.resolveSetupSkillPackage ?? resolveAutopilotRosterSetupSkillPackage;
  const createRosterSetupTool = dependencies.createRosterSetupTool ?? createAutopilotRosterSetupTool;
  const clock = dependencies.now ?? (() => new Date());

  let contextBudgetRegistration: { readonly kind: 'base' } | { readonly kind: 'd65'; readonly workstream_run: string; readonly session_id: string; readonly program_evidence_root: string } | null = null;
  let claimResponseToolRegistered = false;
  let worktreeGuardRegistered = false;
  let activeAutopilotWorkstream: string | null = null;
  let activeAutopilotRuntimeRoot: string | null = null;
  let activeAutopilotWorktreePath: string | null = null;
  let activeAutopilotWorkstreamRun: string | null = null;
  let activeAutopilotRosterSelection: ResolvedAutopilotRosterSelection | null = null;
  let sessionBridge: AutopilotSessionBridge | null = null;
  let lifecycleSessionId = `pi-session-${randomUUID()}`;
  let handoffRequested = false;
  const resolveLaunchSigner = dependencies.resolveLaunchSigner ?? defaultLaunchSignerResolver;
  // The pending D65 bootstrap-plan-only launch. While set, the next
  // `agent_settled` publishes the first complete graph + successor heartbeat and
  // delivers the ordinary continuation turn. It is cleared on completion,
  // failure, or session shutdown.
  let adoptedD65StateRoot: { readonly value: string; readonly previous: string | undefined } | null = null;
  let pendingD65Launch: {
    readonly manifest: D65LaunchManifest;
    readonly bootstrap: D65LaunchBootstrapResult;
    readonly signer: D65LaunchSigner;
    readonly taskIntro: string;
    inFlight: boolean;
  } | null = null;
  // The D65 bootstrap-only effect fence: while set, the worktree guard restricts
  // write-capable tool calls to EXACTLY the five charter paths plus the
  // package-owned auxiliary roots. Set before the bootstrap-plan turn and cleared
  // only after graph 2 (ordinary dispatch).
  let d65BootstrapFence: { readonly charterPaths: readonly string[]; readonly auxiliaryRoots: readonly string[] } | null = null;
  let rosterSetupBundle: AutopilotRosterSetupToolBundle | null = null;
  let rosterSetupActivationToken: string | null = null;
  let rosterSetupSkillPath: string | null = null;
  let rosterSetupFreshSessionFence: { readonly originalCommand: string } | false = false;
  let pendingRosterTransition: { readonly proposal: ExistingRunRosterTransitionProposal; readonly run: ExistingRunRosterTransitionRunRef; readonly active: ActiveAutopilotRow; readonly originalCommand: string } | null = null;

  function ensureContextBudgetActive(): void {
    if (pi.getActiveTools !== undefined && pi.setActiveTools !== undefined) {
      const activeTools = pi.getActiveTools();
      if (!activeTools.includes(CONTEXT_BUDGET_TOOL_NAME)) pi.setActiveTools([...activeTools, CONTEXT_BUDGET_TOOL_NAME]);
    }
  }

  function activateContextBudget(): void {
    if (contextBudgetRegistration?.kind !== 'base') {
      const threshold = resolveContextHaltPercent(process.env);
      pi.registerTool(createContextBudgetTool(threshold));
      contextBudgetRegistration = { kind: 'base' };
    }
    ensureContextBudgetActive();
  }

  /**
   * Replace any previously registered base/other-run context_budget definition
   * with the wrapper bound to THIS manifest and durable D65 session. Pi refreshes
   * same-name dynamic registrations immediately; after bootstrap the base tool is
   * restored so a later manifest can never inherit this run's receipt closure.
   */
  function activateD65ContextBudget(manifest: D65LaunchManifest, sessionId: string): void {
    if (contextBudgetRegistration?.kind !== 'd65' || contextBudgetRegistration.workstream_run !== manifest.workstream_run || contextBudgetRegistration.session_id !== sessionId || contextBudgetRegistration.program_evidence_root !== manifest.program_evidence_root) {
      const threshold = resolveContextHaltPercent(process.env);
      const base = createContextBudgetTool(threshold);
      const wrapped: typeof base = {
        ...base,
        execute: async (toolCallId, params, signal, onUpdate, toolCtx) => {
          const result = await base.execute(toolCallId, params, signal, onUpdate, toolCtx);
          writeD65ContextBudgetReceipt(manifest, { ...result.details, tool_call_id: toolCallId, session_id: sessionId });
          return result;
        },
      };
      pi.registerTool(wrapped);
      contextBudgetRegistration = { kind: 'd65', workstream_run: manifest.workstream_run, session_id: sessionId, program_evidence_root: manifest.program_evidence_root };
    }
    ensureContextBudgetActive();
  }

  function restoreBaseContextBudget(manifest: D65LaunchManifest): void {
    if (contextBudgetRegistration?.kind !== 'd65' || contextBudgetRegistration.workstream_run !== manifest.workstream_run || contextBudgetRegistration.program_evidence_root !== manifest.program_evidence_root) return;
    const threshold = resolveContextHaltPercent(process.env);
    pi.registerTool(createContextBudgetTool(threshold));
    contextBudgetRegistration = { kind: 'base' };
    ensureContextBudgetActive();
  }

  function restoreD65ContextBudgetForExit(manifest: D65LaunchManifest): string {
    try {
      restoreBaseContextBudget(manifest);
      return '';
    } catch (error) {
      return ` Context-budget wrapper restoration also failed: ${error instanceof Error ? error.message : String(error)}.`;
    }
  }

  function activateClaimResponseTool(): void {
    if (!claimResponseToolRegistered) {
      pi.registerTool(createClaimResponseTool(() => {
        const context = sessionBridge?.attachment.context;
        if (context === undefined) return null;
        return new ClaimNegotiationClient(new CoordinatorClient({ env: { ...process.env, AUTOPILOT_STATE_ROOT: context.state_root } }), context);
      }));
      claimResponseToolRegistered = true;
    }
    if (pi.getActiveTools !== undefined && pi.setActiveTools !== undefined) {
      const activeTools = pi.getActiveTools();
      if (!activeTools.includes(AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME)) pi.setActiveTools([...activeTools, AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME]);
    }
  }

  function deactivateClaimResponseTool(): void {
    if (pi.getActiveTools === undefined || pi.setActiveTools === undefined) return;
    const activeTools = pi.getActiveTools();
    if (activeTools.includes(AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME)) pi.setActiveTools(activeTools.filter((name) => name !== AUTOPILOT_RESPOND_CLAIM_REQUEST_TOOL_NAME));
  }

  function deactivateRosterSetupTool(): void {
    if (rosterSetupBundle !== null && rosterSetupActivationToken !== null) {
      rosterSetupBundle.controller.deactivate(rosterSetupActivationToken);
    }
    if (pi.getActiveTools !== undefined && pi.setActiveTools !== undefined) {
      const activeTools = pi.getActiveTools();
      if (activeTools.includes(SETUP_TOOL_NAME)) pi.setActiveTools(activeTools.filter((name) => name !== SETUP_TOOL_NAME));
    }
    rosterSetupActivationToken = null;
    rosterSetupSkillPath = null;
  }

  function resetRosterSetupForSession(): void {
    deactivateRosterSetupTool();
    rosterSetupBundle = null;
    rosterSetupFreshSessionFence = false;
    pendingRosterTransition = null;
  }

  function ensureRosterSetupBundle(): AutopilotRosterSetupToolBundle {
    if (rosterSetupBundle !== null) return rosterSetupBundle;
    const bundle = createRosterSetupTool({
      qualificationManifests: loadPackagedLiveCertificationManifests(),
      saveApproved: async (input) => {
        const request = input.request;
        const stateRoot = dependencies.rosterStateRoot;
        const trustedProjectResolution = await trustedProjectForRequest(request, input.ctx);
        if (!trustedProjectResolution.ok) {
          return {
            ok: false,
            status: 'blocked' as const,
            receipt: null,
            diagnostics: trustedProjectResolution.diagnostics,
            write_count: 0,
            lock_count: 0,
            files_touched: [],
          };
        }
        const trustedProject = trustedProjectResolution.trustedProject;
        const trustedProjectRootForStorage = trustedProjectResolution.trustedProjectRoot;
        try {
          const storage = createProductionRosterStorage(stateRoot);
          const read = await storage.readDefaultRoster(trustedProject === undefined ? { scope: request.scope } : { scope: request.scope, trustedProject });
          if (!read.ok) {
            return {
              ok: false,
              status: read.status === 'blocked' ? 'blocked' as const : 'failed' as const,
              receipt: null,
              diagnostics: storageDiagnosticsAsRosterDiagnostics(read.diagnostics),
              write_count: read.write_count,
              lock_count: read.lock_count,
              files_touched: read.files_touched,
            };
          }
          const candidatesByHash = new Map(input.candidate_set.candidates.map((candidate) => [candidate.roster_sha256, candidate]));
          const publications = input.approved_roster_sha256s.map((sha) => {
            const candidate = candidatesByHash.get(sha);
            if (candidate === undefined) throw new Error('approved roster hash absent from candidate set');
            return materializeRosterPublicationForCandidate({
              candidate,
              scope: request.scope,
              customRosterBytes: input.custom_roster_bytes_by_sha256,
              customManifests: input.custom_manifests_by_roster_sha256,
              customValidations: input.custom_validation_results_by_roster_sha256,
            });
          });
          const rosters = publications.map((publication) => publication.roster);
          const customAuthorityFiles: string[] = [];
          let customAuthorityPath: string | null = null;
          let customAuthoritySha256: Digest | null = null;
          let customAuthorityWrites = 0;
          for (const publication of publications) {
            if (publication.custom_manifest === null || publication.custom_validation_result_sha256 === null) continue;
            const paths = request.scope === 'trusted-project'
              ? stateRoot === undefined
                ? resolveRosterScopePaths({ scope: request.scope, trustedProjectRoot: trustedProjectRootForStorage })
                : resolveRosterScopePaths({ scope: request.scope, stateRoot, trustedProjectRoot: trustedProjectRootForStorage })
              : stateRoot === undefined
                ? resolveRosterScopePaths({ scope: request.scope })
                : resolveRosterScopePaths({ scope: request.scope, stateRoot });
            const published = await publishCustomRosterCertificationAuthority({
              paths,
              roster: parseProviderRoster(publication.roster),
              validation_result_sha256: publication.custom_validation_result_sha256,
              manifest: publication.custom_manifest,
            });
            if (!published.ok) {
              return {
                ok: false,
                status: published.status === 'blocked' ? 'blocked' as const : 'failed' as const,
                receipt: null,
                diagnostics: published.diagnostics,
                write_count: published.write_count,
                lock_count: published.lock_count,
                files_touched: published.files_touched,
              };
            }
            customAuthorityWrites += published.write_count;
            if (published.display_path !== null) customAuthorityFiles.push(...published.files_touched);
            customAuthorityPath = published.display_path;
            customAuthoritySha256 = published.authority?.authority_sha256 ?? null;
          }
          const config = buildRosterConfig({
            scope: request.scope,
            rosters,
            default_roster_id: input.default_roster_id,
            default_roster_revision: input.default_roster_revision,
            default_roster_sha256: input.default_roster_sha256,
            previous_config_sha256: read.config_sha256,
            stateRoot,
            trustedProjectRoot: trustedProjectRootForStorage,
            now: clock(),
          });
          const saved = await storage.saveApprovedDefault({
            scope: request.scope,
            ...(trustedProject === undefined ? {} : { trustedProject }),
            approved_candidate_set_sha256: request.candidate_set_sha256 ?? input.candidate_set.candidate_set_sha256,
            current_candidate_set_sha256: input.candidate_set.candidate_set_sha256,
            approved_roster_sha256s: input.approved_roster_sha256s,
            roster_bytes: publications.map((publication) => publication.bytes),
            config_bytes: config.bytes,
            expected_previous_config_sha256: read.config_sha256,
            default_roster_id: input.default_roster_id,
            default_roster_revision: input.default_roster_revision,
            default_roster_sha256: input.default_roster_sha256,
            original_command: request.original_command,
          });
          return {
            ok: saved.ok,
            status: saved.status === 'saved' ? 'saved' as const : saved.status === 'blocked' ? 'blocked' as const : 'failed' as const,
            receipt: saved.receipt?.receipt ?? null,
            diagnostics: storageDiagnosticsAsRosterDiagnostics(saved.diagnostics),
            write_count: saved.write_count + customAuthorityWrites,
            lock_count: saved.lock_count,
            files_touched: [...customAuthorityFiles, ...saved.files_touched],
            custom_authority_path: customAuthorityPath,
            custom_authority_sha256: customAuthoritySha256,
          };
        } catch {
          return {
            ok: false,
            status: 'failed' as const,
            receipt: null,
            diagnostics: [rosterDiagnostic('ROSTER_READBACK_MISMATCH')],
            write_count: 0,
            lock_count: 0,
            files_touched: [],
          };
        }
      },
    });
    const baseTool = bundle.tool;
    const wrappedTool: AutopilotRosterSetupToolBundle['tool'] = {
      ...baseTool,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const output = await baseTool.execute(toolCallId, params, signal, onUpdate, ctx);
        const saved = provenSavedRosterSetupResult(output.details);
        if (saved !== null) {
          rosterSetupFreshSessionFence = { originalCommand: saved.originalCommand };
          deactivateRosterSetupTool();
        }
        return output;
      },
    };
    const wrappedBundle: AutopilotRosterSetupToolBundle = { ...bundle, tool: wrappedTool };
    pi.registerTool(wrappedBundle.tool);
    rosterSetupBundle = wrappedBundle;
    return wrappedBundle;
  }

  async function activateRosterSetup(ctx: ExtensionCommandContextLike, originalCommand: string, diagnostics: readonly RosterDiagnostic[]): Promise<void> {
    if (pi.getActiveTools === undefined || pi.setActiveTools === undefined) {
      notify(ctx, 'Autopilot roster setup is required, but Pi active-tool APIs are unavailable; no run state was created.', 'error');
      return;
    }
    let setupPackage: VerifiedAutopilotRosterSetupSkillPackage;
    try {
      setupPackage = resolveSetupSkillPackage();
    } catch {
      notify(ctx, 'Autopilot roster setup is required, but the packaged setup skill failed closed verification; no run state was created.', 'error');
      return;
    }
    const bundle = ensureRosterSetupBundle();
    const activation = bundle.controller.activate(rawSessionId(ctx));
    const token = activation.ok ? activation.activation_token : bundle.controller.currentActivationToken();
    if (token === null) {
      notify(ctx, 'Autopilot roster setup is unavailable in this session; start a fresh Pi session and retry setup.', 'error');
      return;
    }
    rosterSetupActivationToken = token;
    rosterSetupSkillPath = dirname(setupPackage.skillPath);
    const activeTools = pi.getActiveTools();
    if (!activeTools.includes(SETUP_TOOL_NAME)) pi.setActiveTools([...activeTools, SETUP_TOOL_NAME]);
    pi.sendUserMessage(setupGuidancePrompt({ package: setupPackage, activationToken: token, originalCommand }), { deliverAs: 'followUp' });
    notify(ctx, setupRequiredMessage(diagnostics), 'warning');
  }

  function activateRosterTransitionApproval(ctx: ExtensionCommandContextLike, resolution: Extract<AutopilotRosterActivationResolution, { readonly status: 'transition-approval-required' }>): void {
    if (pi.on === undefined) {
      pendingRosterTransition = null;
      notify(ctx, 'Autopilot existing-run roster transition requires user-input approval authority, but this Pi host exposes no input event boundary. No transition was recorded.', 'error');
      return;
    }
    pendingRosterTransition = { proposal: resolution.proposal, run: resolution.run, active: resolution.active, originalCommand: resolution.originalCommand };
    pi.sendUserMessage(resolution.proposal.presentation, { deliverAs: 'followUp' });
    notify(ctx, `Autopilot existing-run roster transition requires exact user approval before retry. Diagnostics: ${formatDiagnostics(resolution.diagnostics)}.`, 'warning');
  }

  async function activateParentModelRoster(ctx: ExtensionCommandContextLike, assignment: ResolvedAutopilotRosterSelection['parent']): Promise<boolean> {
    const slash = assignment.model.indexOf('/');
    const provider = assignment.model.slice(0, slash);
    const modelId = assignment.model.slice(slash + 1);
    if (
      slash <= 0 ||
      modelId.length === 0 ||
      ctx.modelRegistry === undefined ||
      pi.setModel === undefined ||
      pi.setThinkingLevel === undefined ||
      pi.getThinkingLevel === undefined
    ) {
      notify(ctx, `Autopilot cannot enforce parent model roster ${assignment.model} at ${assignment.thinking}: Pi model-selection APIs are unavailable.`, 'error');
      return false;
    }
    const model = ctx.modelRegistry.find(provider, modelId);
    if (model === undefined) {
      notify(ctx, `Autopilot cannot enforce parent model roster: ${assignment.model} is not registered in this Pi installation.`, 'error');
      return false;
    }
    let selected: boolean;
    try {
      selected = await pi.setModel(model);
    } catch {
      notify(ctx, `Autopilot cannot select parent roster model ${assignment.model}: Pi model selection failed closed.`, 'error');
      return false;
    }
    if (!selected) {
      notify(ctx, `Autopilot cannot select parent roster model ${assignment.model}: no usable subscription authentication is available.`, 'error');
      return false;
    }
    pi.setThinkingLevel(assignment.thinking);
    if (pi.getThinkingLevel() !== assignment.thinking) {
      notify(ctx, `Autopilot cannot enforce parent thinking level ${assignment.thinking} for ${assignment.model}.`, 'error');
      return false;
    }
    return true;
  }

  function registerWorktreeGuardIfSupported(): void {
    if (worktreeGuardRegistered || pi.on === undefined) return;
    pi.on('tool_call', (event, toolCtx) => {
      if (activeAutopilotWorktreePath === null) return undefined;
      // D65 bootstrap-only effect fence (audit item G): while the bootstrap-plan
      // turn is pending, write-capable tool calls may affect EXACTLY the five
      // charter paths plus package-owned auxiliary roots — never the whole
      // runtime root. After graph 2, ordinary scope resumes.
      if (d65BootstrapFence !== null) {
        return evaluateAutopilotWorktreeToolCall(event, toolCtx, {
          worktreeRoot: activeAutopilotWorktreePath,
          label: 'Autopilot D65 bootstrap fence',
          bootstrapCharterPaths: d65BootstrapFence.charterPaths,
          bootstrapAllowedAuxiliaryRoots: d65BootstrapFence.auxiliaryRoots,
        });
      }
      return evaluateAutopilotWorktreeToolCall(event, toolCtx, {
        worktreeRoot: activeAutopilotWorktreePath,
        label: 'Autopilot worktree guard',
        allowedWriteRoots: activeAutopilotRuntimeRoot === null ? [] : [activeAutopilotRuntimeRoot],
      });
    });
    worktreeGuardRegistered = true;
  }

  function clearActiveAutopilotState(): void {
    activeAutopilotWorkstream = null;
    activeAutopilotRuntimeRoot = null;
    activeAutopilotWorktreePath = null;
    activeAutopilotWorkstreamRun = null;
    activeAutopilotRosterSelection = null;
    d65BootstrapFence = null;
  }

  function rawSessionId(ctx: ExtensionCommandContextLike): string {
    const sessionId = ctx.sessionManager?.getSessionId();
    return sessionId === undefined || sessionId.length === 0 ? lifecycleSessionId : sessionId;
  }

  function failIfRosterSetupRestartRequired(ctx: ExtensionCommandContextLike): boolean {
    if (rosterSetupFreshSessionFence === false) return false;
    notify(ctx, setupRestartRequiredMessage(rosterSetupFreshSessionFence.originalCommand), 'error');
    return true;
  }

  async function attachSessionBridge(prepared: PreparedAutopilotWorkstream, ctx: ExtensionCommandContextLike): Promise<boolean> {
    if (sessionBridge !== null && sessionBridge.attachment.context.workstream_run === prepared.active.workstream_run) {
      activateClaimResponseTool();
      await recoverAutopilotWorktreeSagas({ active: prepared.active });
      await ensureMainWorktreeSagaRegistered({ active: prepared.active });
      await replayPendingCoordinatorReconciliation({ active: prepared.active });
      await sessionBridge.reconcileOwnedRun('same-session-resume-before-mailbox-and-dispatch');
      await reconcileRetainedFailedUnitAuthority({ context: { repo: prepared.repo, active: prepared.active, coordinationRoot: coordinationRootForRepo(prepared.active.repo_key), claimsPath: '', claimEventsPath: '' } });
      await sessionBridge.reconcileOwnedRun('failed-unit-authority-repair-before-mailbox-and-dispatch');
      await sessionBridge.drainMailbox();
      process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = sessionBridge.attachment.contextPath;
      return true;
    }
    const sendMessage = pi.sendMessage;
    if (sendMessage === undefined) {
      notify(ctx, 'Autopilot cannot attach its durable run supervisor because Pi sendMessage is unavailable.', 'error');
      return false;
    }
    if (sessionBridge !== null) {
      const priorContextPath = sessionBridge.attachment.contextPath;
      await sessionBridge.close('replaced-by-autopilot-activation');
      if (process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] === priorContextPath) delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
      sessionBridge = null;
      deactivateClaimResponseTool();
      clearActiveAutopilotState();
    }
    try {
      sessionBridge = await AutopilotSessionBridge.start({
        repo: prepared.repo,
        active: prepared.active,
        rawSessionId: rawSessionId(ctx),
        recoverOwnedOperations: async (contextPath) => {
          const env = { ...process.env, [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: contextPath };
          await recoverAutopilotWorktreeSagas({ active: prepared.active, env });
          await ensureMainWorktreeSagaRegistered({ active: prepared.active, env });
        },
        onAttachedBeforeMailbox: (bridge) => {
          sessionBridge = bridge;
          activateClaimResponseTool();
        },
        sink: {
          send: (message, delivery, triggerTurn) => sendMessage(message, { deliverAs: delivery, triggerTurn }),
          isIdle: () => ctx.isIdle?.() ?? true,
        },
      });
      process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = sessionBridge.attachment.contextPath;
      await recoverAutopilotWorktreeSagas({ active: prepared.active });
      await ensureMainWorktreeSagaRegistered({ active: prepared.active });
      await replayPendingCoordinatorReconciliation({ active: prepared.active });
      await reconcileRetainedFailedUnitAuthority({ context: { repo: prepared.repo, active: prepared.active, coordinationRoot: coordinationRootForRepo(prepared.active.repo_key), claimsPath: '', claimEventsPath: '' } });
      await sessionBridge.reconcileOwnedRun('pending-evidence-replay-before-mailbox-and-dispatch');
      await sessionBridge.reconcileOwnedRun('failed-unit-authority-repair-before-mailbox-and-dispatch');
      await sessionBridge.drainMailbox();
      handoffRequested = false;
      return true;
    } catch (error) {
      const failedBridge = sessionBridge;
      if (failedBridge !== null) {
        const contextPath = failedBridge.attachment.contextPath;
        if (process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] === contextPath) delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
        await failedBridge.close('attachment-reconciliation-failed').catch((closeError: unknown) => {
          notify(ctx, `Autopilot durable run supervisor cleanup also failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`, 'error');
        });
      }
      const attachmentFailure = error instanceof CoordinationRuntimeError ? formatCoordinationRuntimeError(error) : error instanceof Error ? error.message : String(error);
      notify(ctx, `Autopilot durable run supervisor attachment failed: ${attachmentFailure}`, 'error');
      sessionBridge = null;
      deactivateClaimResponseTool();
      clearActiveAutopilotState();
      return false;
    }
  }

  function phase37PrepareSelection(selection: ResolvedAutopilotRosterSelection): Parameters<typeof prepareAutopilotWorkstream>[0]['phase37RosterSelection'] | null {
    if (selection.pre_run_selection === undefined) return null;
    if (selection.existingRun) return { mode: 'existing-run', selection: selection.pre_run_selection };
    if (selection.selection_bytes === null || selection.selection_bytes === undefined || selection.launch_fence === null || selection.launch_fence === undefined) return null;
    return {
      mode: 'new-run',
      selection: selection.pre_run_selection,
      selectionBytes: selection.selection_bytes,
      launchFence: selection.launch_fence,
    };
  }

  async function retireTerminalSessionBridge(workstreamRun: string, ctx: ExtensionCommandContextLike): Promise<void> {
    if (sessionBridge !== null && sessionBridge.attachment.context.workstream_run === workstreamRun) {
      const bridge = sessionBridge;
      const contextPath = bridge.attachment.contextPath;
      try { await bridge.acceptTerminalDetach(); }
      catch (error) { notify(ctx, `Autopilot terminal run closed, but local session-bridge fencing failed loudly: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
      if (process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] === contextPath) delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
      sessionBridge = null;
      deactivateClaimResponseTool();
    }
    if (activeAutopilotWorkstreamRun === workstreamRun) clearActiveAutopilotState();
  }

  async function prepareAndActivateWorkstream(input: {
    readonly workstream: string;
    readonly ctx: ExtensionCommandContextLike;
    readonly rosterSelection: ResolvedAutopilotRosterSelection;
    readonly now: Date;
    readonly contextBudgetErrorPrefix: string;
    readonly prepareErrorPrefix: string;
  }): Promise<PreparedAutopilotWorkstream | null> {
    const phase37Selection = phase37PrepareSelection(input.rosterSelection);
    if (phase37Selection === null || input.rosterSelection.workstream_run === undefined) {
      notify(input.ctx, 'Autopilot roster selection is missing readback-authenticated Phase 37 launch evidence. No run state was created.', 'error');
      return null;
    }

    let prepared: PreparedAutopilotWorkstream;
    try {
      prepared = await prepareWorkstream({
        workstream: input.workstream,
        workstreamRun: input.rosterSelection.workstream_run,
        sourceCwd: input.ctx.cwd ?? process.cwd(),
        coordinationSessionId: rawSessionId(input.ctx),
        now: input.now,
        phase37RosterRequired: true,
        phase37RosterSelection: phase37Selection,
      });
    } catch (error) {
      const message = error instanceof CoordinationRuntimeError
        ? formatCoordinationRuntimeError(error)
        : error instanceof AutopilotParallelRuntimeError
          ? error.message
          : error instanceof Error ? error.message : String(error);
      const recoveryFence = error instanceof AutopilotParallelRuntimeError && error.code === 'migration-recovery-required'
        ? ' Ordinary Autopilot activation remains disabled; use an explicit recovery-only supervisor session with exact evidence.'
        : '';
      notify(input.ctx, `${input.prepareErrorPrefix}: ${message}${recoveryFence}`, 'error');
      return null;
    }

    if (!input.rosterSelection.existingRun) {
      const selectionBytes = input.rosterSelection.selection_bytes;
      const selection = input.rosterSelection.pre_run_selection;
      if (selectionBytes === null || selectionBytes === undefined || selection === undefined) {
        notify(input.ctx, 'Autopilot roster selection bytes are unavailable for runtime snapshot publication. Parent activation was not started.', 'error');
        return null;
      }
      const snapshot = await publishRosterSnapshot({
        mainWorktreeRoot: prepared.mainWorktreePath,
        workstream: input.workstream,
        selection_bytes: selectionBytes,
        expected_selection_sha256: selection.selection_sha256 as RosterSha256,
      });
      if (!snapshot.ok) {
        notify(input.ctx, `Autopilot runtime roster snapshot failed closed: ${formatDiagnostics(dedupeRosterDiagnostics(snapshot.diagnostics.map((diagnostic) => diagnostic.code)))}. Parent activation was not started.`, 'error');
        return null;
      }
    }

    try {
      activateContextBudget();
    } catch (error) {
      notify(
        input.ctx,
        `${input.contextBudgetErrorPrefix}: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      return null;
    }

    if (!(await activateParentModelRoster(input.ctx, input.rosterSelection.parent))) return null;
    if (!(await (dependencies.attachSessionBridge ?? attachSessionBridge)(prepared, input.ctx))) return null;

    activeAutopilotWorkstream = prepared.active.workstream;
    activeAutopilotRuntimeRoot = prepared.runtimeRoot;
    activeAutopilotWorktreePath = prepared.mainWorktreePath;
    activeAutopilotWorkstreamRun = prepared.active.workstream_run;
    activeAutopilotRosterSelection = input.rosterSelection;
    registerWorktreeGuardIfSupported();
    return prepared;
  }

  /**
   * Load and strictly parse a sealed D65 launch manifest from an absolute path.
   * The file must be a bounded, one-link, no-follow regular file; a relative
   * path, oversized file, symlink, or unknown field rejects. No fallback.
   */
  function loadLaunchManifest(absolutePath: string): { readonly manifest: D65LaunchManifest; readonly loadedManifestSha256: `sha256:${string}` } {
    // Descriptor-safe no-follow read with before/open/after inode-size-link
    // identity checks, so a rename/swap between the mode check and the read
    // cannot substitute the bytes the launcher admits.
    const bytes = readImmutableFileBytes({ path: absolutePath, maximumBytes: D65_LAUNCH_MANIFEST_MAX_BYTES, label: 'launch manifest', errorCode: 'invalid-request' });
    const manifest = parseD65LaunchManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
    // Preserve and persist the exact loaded manifest bytes digest so a restart
    // proves it consumed the SAME manifest (it is bound into private launch
    // evidence at attach time and rejected if it diverges).
    const loadedManifestSha256 = launchManifestBytesSha256(bytes);
    return { manifest, loadedManifestSha256 };
  }

  /**
   * Drive stages 1-6 of the D65 launch from a sealed manifest: attach-run with
   * bootstrap_graph through ONE session, create the main worktree, register the
   * operator-signed policy, accept the initial governing heartbeat, then deliver
   * the bootstrap-plan-only parent prompt. The single session bridge is NOT
   * adopted yet: the periodic session heartbeat must stay off until graph
   * sequence 2 is accepted (the 9-event bootstrap window). Returns true when the
   * bootstrap-plan turn was dispatched.
   */
  async function activateD65Launch(input: { readonly manifest: D65LaunchManifest; readonly loadedManifestSha256: `sha256:${string}`; readonly ctx: ExtensionCommandContextLike; readonly taskIntro: string }): Promise<boolean> {
    const { manifest, ctx } = input;
    // Bootstrap uses a local sealed environment. Do NOT contaminate ambient
    // process.env before ordinary session adoption succeeds: every early failure
    // must leave later legacy commands on their original state authority.
    const env = launchEnv(manifest, process.env);
    let signer: D65LaunchSigner;
    try {
      signer = resolveLaunchSigner(manifest, env);
    } catch (error) {
      notify(ctx, `Autopilot could not resolve the external launch signer: ${error instanceof Error ? error.message : String(error)}. No run state was created.`, 'error');
      return false;
    }
    // DERIVE THE EXACT DURABLE PHASE FIRST, before any signature request or
    // parent-model call. The phase is computed only from durable coordinator +
    // Git authority (never from in-memory state) so a crash/response loss at any
    // boundary replays the exact next effect. A divergent/ambiguous authority
    // fails closed here with no mutation.
    let phase: Awaited<ReturnType<typeof resolveD65LaunchPhase>>;
    try {
      phase = await resolveD65LaunchPhase({ manifest, env });
    } catch (error) {
      const message = error instanceof CoordinationRuntimeError ? formatCoordinationRuntimeError(error) : error instanceof Error ? error.message : String(error);
      notify(ctx, `Autopilot D65 launch phase resolution failed closed: ${message}. No run state was mutated.`, 'error');
      return false;
    }
    // Select the EXACT sealed parent model/thinking before any parent model call,
    // so the bootstrap-plan turn cannot run on an ambient (possibly paid) model.
    // Its exact identity is derived from the authenticated sealed roster bytes.
    let parentAssignment: { readonly model: string; readonly thinking: 'high' | 'xhigh' };
    try {
      parentAssignment = activateD65RuntimeRosterFromManifest({ manifest, env });
    } catch (error) {
      const message = error instanceof CoordinationRuntimeError ? formatCoordinationRuntimeError(error) : error instanceof Error ? error.message : String(error);
      notify(ctx, `Autopilot D65 launch roster authority failed closed: ${message}. No parent model call was made.`, 'error');
      return false;
    }
    if (!(await activateParentModelRoster(ctx, parentAssignment))) return false;
    // Drive stages 1-5 (attach + main worktree + policy + initial heartbeat) to
    // completion. Every one of these is idempotent, so re-running after a crash
    // replays the exact effect and never creates a second session/generation.
    let bootstrap: D65LaunchBootstrapResult;
    try {
      bootstrap = await beginD65LaunchBootstrap({ manifest, rawSessionId: rawSessionId(ctx), env, loadedManifestSha256: input.loadedManifestSha256 });
      await registerD65LaunchPolicyAndInitialHeartbeat({ manifest, attachment: bootstrap.attachment, signer, env });
      // Publish the exact runtime roster snapshot (from the authenticated sealed
      // roster bytes) before graph 2 so the ordinary v2 child path can author
      // authenticated specs from it. Idempotent create-only publication.
      await publishD65RuntimeRosterSnapshot({ manifest, env });
      // The durable session now exists, but no parent model call has occurred.
      // Replace any pre-existing base/other-run tool with THIS session-bound
      // wrapper before dispatching the bootstrap-plan turn.
      activateD65ContextBudget(manifest, bootstrap.attachment.context.session_id);
    } catch (error) {
      const message = error instanceof CoordinationRuntimeError ? formatCoordinationRuntimeError(error) : error instanceof Error ? error.message : String(error);
      const cleanup = restoreD65ContextBudgetForExit(manifest);
      notify(ctx, `Autopilot D65 launch bootstrap failed closed: ${message}. No parent model call was made.${cleanup}`, 'error');
      return false;
    }
    activeAutopilotWorkstream = manifest.workstream;
    activeAutopilotRuntimeRoot = manifest.runtime_root;
    activeAutopilotWorktreePath = manifest.main_worktree_path;
    activeAutopilotWorkstreamRun = manifest.workstream_run;
    // Install the bootstrap-only effect fence (audit item G): write-capable model
    // tool calls may affect EXACTLY the five charter paths and NOTHING else — not
    // the whole runtime root. The roster snapshot and graph publication are
    // package-written (not model tool calls), so no auxiliary model-write root is
    // granted. Any other write/edit target permanently fences the launch.
    d65BootstrapFence = {
      charterPaths: D65_CHARTER_ROOTS.map((root) => join(manifest.runtime_root, root)),
      auxiliaryRoots: [],
    };
    registerWorktreeGuardIfSupported();
    pendingD65Launch = { manifest, bootstrap, signer, taskIntro: input.taskIntro, inFlight: false };
    // Re-resolve the phase from durable authority now that stages 1-5 are
    // committed. If the first complete graph (sequence 2) already exists (restart
    // after graph publication), the bootstrap-plan turn is OVER: mechanically
    // complete the launch and deliver the ORDINARY continuation turn instead of a
    // second planning call. If the charter roots already exist but graph 2 does
    // not (restart after charter creation), also complete mechanically without
    // another planning call. Otherwise deliver the bootstrap-plan-only turn.
    let postPhase: Awaited<ReturnType<typeof resolveD65LaunchPhase>>;
    try {
      postPhase = await resolveD65LaunchPhase({ manifest, env });
    } catch (error) {
      pendingD65Launch = null;
      const message = error instanceof CoordinationRuntimeError ? formatCoordinationRuntimeError(error) : error instanceof Error ? error.message : String(error);
      const cleanup = restoreD65ContextBudgetForExit(manifest);
      notify(ctx, `Autopilot D65 launch phase re-resolution failed closed: ${message}.${cleanup}`, 'error');
      return false;
    }
    void phase;
    if (postPhase.kind === 'first-graph-required' || postPhase.kind === 'successor-heartbeat-required' || postPhase.kind === 'ordinary') {
      await completeD65LaunchIfReady(ctx);
      return true;
    }
    const prompt = renderAutopilotBootstrapPlanPrompt({
      workstream: manifest.workstream,
      runtimeRoot: manifest.runtime_root,
      workstreamRun: manifest.workstream_run,
      worktreePath: manifest.main_worktree_path,
      taskIntro: input.taskIntro,
    });
    try {
      pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
    } catch (error) {
      pendingD65Launch = null;
      const cleanup = restoreD65ContextBudgetForExit(manifest);
      notify(ctx, `Autopilot D65 launch prepared ${manifest.workstream_run} but could not deliver the bootstrap-plan prompt: ${error instanceof Error ? error.message : String(error)}.${cleanup}`, 'error');
      return false;
    }
    notify(ctx, `Autopilot D65 launch bootstrap active for ${manifest.workstream} (${manifest.workstream_run}); awaiting the bootstrap-plan turn.`, 'info');
    return true;
  }

  /**
   * Stage 7-9, fired on `agent_settled` after the bootstrap-plan turn: validate
   * the five charter roots, publish the first complete graph (sequence 2), accept
   * the successor governing heartbeat, adopt the single session bridge (starting
   * its periodic heartbeat now), and deliver the ordinary continuation turn.
   * Idempotent and fail-closed; child dispatch is impossible until this succeeds.
   */
  async function completeD65LaunchIfReady(ctx: ExtensionCommandContextLike): Promise<void> {
    const pending = pendingD65Launch;
    if (pending === null || pending.inFlight) return;
    let charterComplete: boolean;
    try {
      charterComplete = detectD65CharterComplete(pending.manifest);
    } catch (error) {
      pendingD65Launch = null;
      const cleanup = restoreD65ContextBudgetForExit(pending.manifest);
      notify(ctx, `Autopilot D65 bootstrap parent violated the charter scope: ${error instanceof Error ? error.message : String(error)}. The launch is fenced; no child work occurred.${cleanup}`, 'error');
      return;
    }
    if (!charterComplete) return; // parent has not yet written the five charter roots; wait for the next settle.
    pending.inFlight = true;
    try {
      await publishD65FirstGraphAndSuccessorHeartbeat({ manifest: pending.manifest, attachment: pending.bootstrap.attachment, signer: pending.signer, env: launchEnv(pending.manifest, process.env) });
    } catch (error) {
      pending.inFlight = false;
      const message = error instanceof CoordinationRuntimeError ? formatCoordinationRuntimeError(error) : error instanceof Error ? error.message : String(error);
      notify(ctx, `Autopilot D65 first-graph publication failed closed: ${message}. The run stays bootstrap-only; no child work is possible.`, 'error');
      return;
    }
    // Graph 2 is accepted: no later model turn may write another bootstrap
    // receipt. Restore the ordinary base tool before lifting the effect fence.
    try {
      restoreBaseContextBudget(pending.manifest);
    } catch (error) {
      pending.inFlight = false;
      notify(ctx, `Autopilot D65 graph 2 was accepted but context_budget wrapper restoration failed closed: ${error instanceof Error ? error.message : String(error)}. Ordinary dispatch remains fenced.`, 'error');
      return;
    }
    // Keep the bootstrap-only effect fence until exact session adoption succeeds;
    // graph 2 alone must not open ordinary model-write scope.
    // Adopt the exact single session; the periodic heartbeat starts only now.
    const sendMessage = pi.sendMessage;
    if (sendMessage === undefined) {
      pending.inFlight = false;
      notify(ctx, 'Autopilot cannot adopt its durable run supervisor because Pi sendMessage is unavailable.', 'error');
      return;
    }
    let adopted: AutopilotSessionBridge | null = null;
    try {
      adopted = await AutopilotSessionBridge.adopt({
        attachment: pending.bootstrap.attachment,
        env: launchEnv(pending.manifest, process.env),
        recoverOwnedOperations: async (contextPath) => {
          const env = { ...launchEnv(pending.manifest, process.env), [AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV]: contextPath };
          await recoverAutopilotWorktreeSagas({ active: pending.bootstrap.active, env });
          await ensureMainWorktreeSagaRegistered({ active: pending.bootstrap.active, env });
        },
        sink: {
          send: (message, delivery, triggerTurn) => sendMessage(message, { deliverAs: delivery, triggerTurn }),
          isIdle: () => ctx.isIdle?.() ?? true,
        },
      });
      activateClaimResponseTool();
      sessionBridge = adopted;
      // Only successful ordinary adoption changes ambient process authority and
      // opens the ordinary runtime guard.
      adoptedD65StateRoot = { value: pending.manifest.state_root, previous: process.env[AUTOPILOT_STATE_ROOT_ENV] };
      process.env[AUTOPILOT_STATE_ROOT_ENV] = pending.manifest.state_root;
      process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] = adopted.attachment.contextPath;
      d65BootstrapFence = null;
    } catch (error) {
      pending.inFlight = false;
      let cleanup = '';
      if (adopted !== null) {
        try { await adopted.close('d65-adoption-failed'); }
        catch (cleanupError) { cleanup = ` Adopted bridge cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}.`; }
      }
      const message = error instanceof CoordinationRuntimeError ? formatCoordinationRuntimeError(error) : error instanceof Error ? error.message : String(error);
      notify(ctx, `Autopilot D65 launch session adoption failed closed: ${message}.${cleanup}`, 'error');
      return;
    }
    const runtimeRoot = pending.manifest.runtime_root;
    const continuation = renderAutopilotPrompt({
      workstream: pending.manifest.workstream,
      runtimeRoot,
      runnerInvocation: runnerInvocationFromModuleUrl(import.meta.url),
      taskIntro: pending.taskIntro,
      workstreamRun: pending.manifest.workstream_run,
      sourceRepo: pending.manifest.canonical_root,
      worktreePath: pending.manifest.main_worktree_path,
      branch: pending.manifest.run_branch,
      repoKey: pending.manifest.repo_key,
      targetBranch: pending.manifest.target_branch,
      rosterTransition: null,
    });
    pendingD65Launch = null;
    try {
      pi.sendUserMessage(continuation, { deliverAs: 'followUp' });
    } catch (error) {
      notify(ctx, `Autopilot D65 launch reached ordinary dispatch for ${pending.manifest.workstream_run} but could not deliver the continuation prompt: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
    notify(ctx, `Autopilot D65 launch complete for ${pending.manifest.workstream} (${pending.manifest.workstream_run}); ordinary child dispatch is now permitted.`, 'info');
  }

  if (pi.on !== undefined) {
    pi.on('session_start', (_event, ctx) => {
      resetRosterSetupForSession();
      const restored = ctx.sessionManager?.getSessionId();
      lifecycleSessionId = restored === undefined || restored.length === 0 ? `pi-session-${randomUUID()}` : restored;
    });
    pi.on('agent_settled', async (_event, ctx) => {
      // After the D65 bootstrap-plan-only turn settles, publish the first
      // complete graph and enable ordinary dispatch. No-op when no launch is
      // pending. Errors are surfaced loudly and leave the run bootstrap-fenced.
      await completeD65LaunchIfReady(ctx);
    });
    pi.on('resources_discover', () => {
      if (rosterSetupSkillPath === null) return undefined;
      return { skillPaths: [rosterSetupSkillPath] };
    });
    pi.on('input', async (event, ctx) => {
      if (typeof event.text !== 'string') return undefined;
      if (rosterSetupBundle !== null && rosterSetupActivationToken !== null) {
        const presentation = rosterSetupBundle.hostAuthorization.currentApprovalPresentation();
        if (presentation !== null) {
          const approved = rosterSetupBundle.hostAuthorization.authorizeInput({
            activation_token: rosterSetupActivationToken,
            source: event.source,
            text: event.text,
          });
          if (!approved.ok || approved.approval_token === null) {
            notify(ctx, `Autopilot roster setup approval was not accepted: ${approved.reason}.`, 'warning');
            return { action: 'continue' };
          }
          return {
            action: 'transform',
            text: `${event.text}\n\nAutopilot roster setup host authorization accepted for the current package-bound presentation. approval_token: ${approved.approval_token}`,
          };
        }
      }
      if (pendingRosterTransition === null) return undefined;
      const pending = pendingRosterTransition;
      const authorized = authorizeExistingRunRosterTransitionInput({ proposal: pending.proposal, source: event.source, text: event.text });
      const approval = authorized.approval;
      if (!authorized.ok || approval === null) {
        notify(ctx, `Autopilot roster transition approval was not accepted: ${authorized.reason}.`, 'warning');
        return { action: 'continue' };
      }
      const commitAfterFreshRead = async (): Promise<Awaited<ReturnType<typeof commitApprovedExistingRunRosterTransition>> | null> => {
        let freshActive: ActiveAutopilotRow | null = null;
        try {
          freshActive = await readFreshActiveRunForTransition({ expected: pending.active, ctx, env: process.env });
        } catch {
          freshActive = null;
        }
        if (freshActive === null) return null;
        return await commitApprovedExistingRunRosterTransition({
          ...(dependencies.rosterStateRoot === undefined ? {} : { stateRoot: dependencies.rosterStateRoot }),
          run: transitionRunRef(freshActive),
          proposal: pending.proposal,
          approval,
          expected_active_run: transitionRunRef(freshActive),
        });
      };
      const committed = pending.active.coordination_authority === 'legacy-path-claims-v1'
        ? await withAutopilotFileLock(`${coordinationRootForRepo(pending.active.repo_key, process.env)}/.locks/activation.lock`, `roster-transition-commit:${pending.active.autopilot_id}:${pending.active.workstream_run}`, commitAfterFreshRead)
        : await commitAfterFreshRead();
      if (committed === null) {
        notify(ctx, 'Autopilot roster transition failed closed: active run identity/status drifted before approval commit.', 'error');
        return { action: 'handled' };
      }
      if (!committed.ok) {
        notify(ctx, `Autopilot roster transition failed closed: ${formatDiagnostics(dedupeRosterDiagnostics(committed.diagnostics.map((diagnostic) => diagnostic.code)))}.`, 'error');
        return { action: 'handled' };
      }
      const retryCommand = pending.originalCommand;
      pendingRosterTransition = null;
      pi.sendUserMessage(`Autopilot roster transition recorded at ${committed.transition_display_path}. Start a fresh retry with exactly: ${retryCommand}\nSuccessor attempts must be freshly validated before close.`, { deliverAs: 'followUp' });
      notify(ctx, `Autopilot roster transition ${committed.transition?.transition_id ?? 'recorded'} committed; retry the original command.`, 'info');
      return { action: 'handled' };
    });
    pi.on('session_shutdown', async (event, ctx) => {
      deactivateRosterSetupTool();
      // A D65 launch interrupted before graph sequence 2 leaves its durable
      // bootstrap authority intact; a fresh `/autopilot ... --launch-manifest`
      // in a new session recovers it idempotently. Restore the ordinary tool and
      // clear only in-memory launch state.
      const interruptedD65 = pendingD65Launch;
      pendingD65Launch = null;
      if (interruptedD65 !== null) {
        const cleanup = restoreD65ContextBudgetForExit(interruptedD65.manifest);
        if (cleanup.length > 0) notify(ctx, cleanup.trim(), 'error');
      }
      if (sessionBridge === null) {
        clearActiveAutopilotState();
        return;
      }
      try {
        if (handoffRequested) await sessionBridge.prepareHandoff();
        else await sessionBridge.close(typeof event['reason'] === 'string' ? event['reason'] : 'session-shutdown');
      } catch (error) {
        notify(ctx, `Autopilot session bridge shutdown failed loudly: ${error instanceof Error ? error.message : String(error)}`, 'error');
      } finally {
        const contextPath = sessionBridge.attachment.contextPath;
        if (process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] === contextPath) delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
        if (adoptedD65StateRoot !== null && process.env[AUTOPILOT_STATE_ROOT_ENV] === adoptedD65StateRoot.value) {
          if (adoptedD65StateRoot.previous === undefined) delete process.env[AUTOPILOT_STATE_ROOT_ENV];
          else process.env[AUTOPILOT_STATE_ROOT_ENV] = adoptedD65StateRoot.previous;
        }
        adoptedD65StateRoot = null;
        sessionBridge = null;
        deactivateClaimResponseTool();
        clearActiveAutopilotState();
      }
    });
  }

  pi.registerCommand(AUTOPILOT_COMMAND, {
    description: 'Start or resume Autopilot orchestration: /autopilot <workstream> [--roster <id>] [task intro]',
    handler: async (args, ctx) => {
      const parsed = parseAutopilotLaunchArgs(args);
      if (!parsed.ok) {
        notify(ctx, parsed.message, 'warning');
        return;
      }

      const originalCommand = originalAutopilotCommand(args);
      if (failIfRosterSetupRestartRequired(ctx)) return;

      // Closed D65 launch mode: when `--launch-manifest <absolute-path>` is
      // present, `/autopilot` consumes the sealed prelaunch package rather than
      // regenerating a run. The legacy path below is unchanged when it is absent.
      if (parsed.value.launchManifestPath !== null) {
        let loaded: { readonly manifest: D65LaunchManifest; readonly loadedManifestSha256: `sha256:${string}` };
        try {
          loaded = loadLaunchManifest(parsed.value.launchManifestPath);
        } catch (error) {
          notify(ctx, `Autopilot launch manifest is invalid: ${error instanceof Error ? error.message : String(error)}. No run state was created.`, 'error');
          return;
        }
        if (loaded.manifest.workstream !== parsed.value.workstream) {
          notify(ctx, `Autopilot launch manifest workstream ${loaded.manifest.workstream} does not match the command workstream ${parsed.value.workstream}. No run state was created.`, 'error');
          return;
        }
        await activateD65Launch({ manifest: loaded.manifest, loadedManifestSha256: loaded.loadedManifestSha256, ctx, taskIntro: parsed.value.remainder });
        return;
      }

      // Legacy path: reduce to the exact byte-unchanged legacy result shape.
      const legacyParsed: ParsedAutopilotArgs = { workstream: parsed.value.workstream, remainder: parsed.value.remainder, rosterId: parsed.value.rosterId };
      const activationNow = clock();
      const plannedWorkstreamRun = buildAutopilotWorkstreamRun(legacyParsed.workstream, activationNow);
      const rosterResolution = await rosterActivationStore.resolve({ parsed: legacyParsed, ctx, originalCommand, env: process.env, plannedWorkstreamRun, now: activationNow });
      if (rosterResolution.status === 'setup-required') {
        await activateRosterSetup(ctx, originalCommand, rosterResolution.diagnostics);
        return;
      }
      if (rosterResolution.status === 'transition-approval-required') {
        activateRosterTransitionApproval(ctx, rosterResolution);
        return;
      }
      if (rosterResolution.status === 'blocked') {
        notify(ctx, `Autopilot roster resolution failed closed at ${rosterResolution.source}: ${formatDiagnostics(rosterResolution.diagnostics)}. No run state was created.`, 'error');
        return;
      }

      const prepared = await prepareAndActivateWorkstream({
        workstream: legacyParsed.workstream,
        ctx,
        rosterSelection: rosterResolution.selection,
        now: activationNow,
        contextBudgetErrorPrefix: 'Autopilot could not activate context_budget',
        prepareErrorPrefix: 'Autopilot could not prepare isolated worktree',
      });
      if (prepared === null) return;

      const runtimeRoot = prepared.runtimeRoot;
      const prompt = renderAutopilotPrompt({
        workstream: legacyParsed.workstream,
        runtimeRoot,
        runnerInvocation: runnerInvocationFromModuleUrl(import.meta.url),
        taskIntro: legacyParsed.remainder,
        workstreamRun: prepared.active.workstream_run,
        sourceRepo: prepared.active.source_repo,
        worktreePath: prepared.mainWorktreePath,
        branch: prepared.active.branch,
        repoKey: prepared.active.repo_key,
        targetBranch: prepared.active.target_branch,
        rosterTransition: rosterResolution.selection.successor_attempt_authority === undefined ? null : {
          transition_id: rosterResolution.selection.successor_attempt_authority.transition_id,
          transition_sha256: rosterResolution.selection.successor_attempt_authority.transition_sha256,
          transition_artifact_sha256: rosterResolution.selection.successor_attempt_authority.transition_artifact_sha256,
          runtime_transition_ref: rosterResolution.selection.successor_attempt_authority.runtime_transition_ref,
          from_roster_id: rosterResolution.selection.successor_attempt_authority.from_roster.roster_id,
          to_roster_id: rosterResolution.selection.successor_attempt_authority.to_roster.roster_id,
          to_roster_revision: rosterResolution.selection.successor_attempt_authority.to_roster.roster_revision,
          to_roster_sha256: rosterResolution.selection.successor_attempt_authority.to_roster.roster_sha256,
        },
      });
      try {
        pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
      } catch (error) {
        notify(
          ctx,
          `Autopilot prepared ${prepared.active.workstream_run} but could not deliver the parent prompt: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        return;
      }
      notify(ctx, `Autopilot activated for ${legacyParsed.workstream} (${prepared.active.workstream_run}).`, 'info');
    },
  });

  pi.registerCommand(AUTOPILOT_INJECT_COMMAND, {
    description: 'Refresh Autopilot session binding without queueing the parent prompt: /autopilot-inject <workstream>',
    handler: async (args, ctx) => {
      const parsed = parseAutopilotInjectArgs(args);
      if (!parsed.ok) {
        notify(ctx, parsed.message, 'warning');
        return;
      }

      const autopilotEquivalent: ParsedAutopilotArgs = { workstream: parsed.value.workstream, remainder: '', rosterId: null };
      const originalCommand = `/${AUTOPILOT_COMMAND} ${parsed.value.workstream}`;
      if (failIfRosterSetupRestartRequired(ctx)) return;
      const activationNow = clock();
      const plannedWorkstreamRun = buildAutopilotWorkstreamRun(parsed.value.workstream, activationNow);
      const rosterResolution = await rosterActivationStore.resolve({ parsed: autopilotEquivalent, ctx, originalCommand, env: process.env, plannedWorkstreamRun, now: activationNow });
      if (rosterResolution.status === 'setup-required') {
        await activateRosterSetup(ctx, originalCommand, rosterResolution.diagnostics);
        return;
      }
      if (rosterResolution.status === 'transition-approval-required') {
        activateRosterTransitionApproval(ctx, rosterResolution);
        return;
      }
      if (rosterResolution.status === 'blocked') {
        notify(ctx, `Autopilot inject roster resolution failed closed at ${rosterResolution.source}: ${formatDiagnostics(rosterResolution.diagnostics)}. No run state was created.`, 'error');
        return;
      }

      const prepared = await prepareAndActivateWorkstream({
        workstream: parsed.value.workstream,
        ctx,
        rosterSelection: rosterResolution.selection,
        now: activationNow,
        contextBudgetErrorPrefix: 'Autopilot inject could not activate context_budget',
        prepareErrorPrefix: 'Autopilot inject could not prepare isolated worktree',
      });
      if (prepared === null) return;

      notify(ctx, `Autopilot injected for ${prepared.active.workstream} (${prepared.active.workstream_run}).`, 'info');
    },
  });

  pi.registerCommand(AUTOPILOT_CLOSE_COMMAND, {
    description: 'Runtime-close an Autopilot workstream: /autopilot-close <workstream> [--run <workstream_run>] [--dry-run]',
    handler: async (args, ctx) => {
      const parsed = parseAutopilotCloseArgs(args);
      if (!parsed.ok) {
        notify(ctx, parsed.message, 'warning');
        return;
      }
      try {
        const result = await closeAutopilotWorkstream({
          workstream: parsed.value.workstream,
          sourceCwd: ctx.cwd ?? process.cwd(),
          workstreamRun: parsed.value.workstreamRun,
          dryRun: parsed.value.dryRun,
          coordinationSessionId: rawSessionId(ctx),
        });
        if (result.outcome === 'closed') await retireTerminalSessionBridge(result.workstream_run, ctx);
        const blockerText = result.blockers.length === 0 ? '' : `\nBlockers:\n${result.blockers.map((blocker) => `- ${blocker}`).join('\n')}`;
        const summary = [
          `Autopilot close ${result.outcome} for ${result.workstream_run}.`,
          `Branch: ${result.branch}`,
          `Target: ${result.target_branch ?? 'detached-HEAD'}`,
          `Changed paths: ${String(result.changed_paths.length)}`,
          result.close_result_path === null ? null : `Close result: ${result.close_result_path}`,
          blockerText.length === 0 ? null : blockerText,
        ].filter((line): line is string => line !== null).join('\n');
        pi.sendUserMessage(summary, { deliverAs: 'followUp' });
        notify(ctx, `Autopilot close ${result.outcome} for ${result.workstream_run}.`, result.outcome === 'closed' ? 'info' : result.outcome === 'dry-run' ? 'info' : 'warning');
      } catch (error) {
        const message = error instanceof AutopilotCloseError ? error.message : error instanceof Error ? error.message : String(error);
        notify(ctx, `Autopilot close failed: ${message}`, 'error');
      }
    },
  });

  pi.registerCommand(AUTOPILOT_ABORT_COMMAND, {
    description: 'Runtime-abort/archive an Autopilot workstream without merging: /autopilot-abort <workstream> [--run <workstream_run>] [--dry-run]',
    handler: async (args, ctx) => {
      const parsed = parseAutopilotAbortArgs(args);
      if (!parsed.ok) {
        notify(ctx, parsed.message, 'warning');
        return;
      }
      try {
        const result = await abortAutopilotWorkstream({
          workstream: parsed.value.workstream,
          sourceCwd: ctx.cwd ?? process.cwd(),
          workstreamRun: parsed.value.workstreamRun,
          dryRun: parsed.value.dryRun,
          coordinationSessionId: rawSessionId(ctx),
        });
        if (result.outcome === 'aborted') await retireTerminalSessionBridge(result.workstream_run, ctx);
        const blockerText = result.blockers.length === 0 ? '' : `\nBlockers:\n${result.blockers.map((blocker) => `- ${blocker}`).join('\n')}`;
        const summary = [
          `Autopilot abort ${result.outcome} for ${result.workstream_run}.`,
          `Branch: ${result.branch}`,
          `Archive ref: ${result.archive_ref ?? 'not archived'}`,
          result.close_result_path === null ? null : `Abort result: ${result.close_result_path}`,
          blockerText.length === 0 ? null : blockerText,
        ].filter((line): line is string => line !== null).join('\n');
        pi.sendUserMessage(summary, { deliverAs: 'followUp' });
        notify(ctx, `Autopilot abort ${result.outcome} for ${result.workstream_run}.`, result.outcome === 'aborted' ? 'info' : result.outcome === 'dry-run' ? 'info' : 'warning');
      } catch (error) {
        const message = error instanceof AutopilotCloseError ? error.message : error instanceof Error ? error.message : String(error);
        notify(ctx, `Autopilot abort failed: ${message}`, 'error');
      }
    },
  });

  pi.registerCommand(AUTOPILOT_CONFIG_COMMAND, {
    description: 'Show or update Autopilot scheduler config: /autopilot-config show | parallel-cap <1..32>',
    handler: async (args, ctx) => {
      if (activeAutopilotWorkstream === null || activeAutopilotRuntimeRoot === null) {
        notify(ctx, `No active Autopilot workstream in this session. Start with /${AUTOPILOT_COMMAND} <workstream> or /${AUTOPILOT_INJECT_COMMAND} <workstream>.`, 'warning');
        return;
      }
      const parsed = parseAutopilotConfigArgs(args);
      if (!parsed.ok) {
        notify(ctx, parsed.message, 'warning');
        return;
      }
      try {
        const config = parsed.value.action === 'show'
          ? await readSchedulerConfig({ runtimeRoot: activeAutopilotRuntimeRoot, workstream: activeAutopilotWorkstream })
          : await writeSchedulerConfig({ runtimeRoot: activeAutopilotRuntimeRoot, workstream: activeAutopilotWorkstream, parallelCap: parsed.value.parallelCap ?? 8, updatedBy: 'autopilot-config' });
        const summary = `Autopilot scheduler config for ${config.workstream}: parallel_cap=${String(config.parallel_cap)} updated_by=${config.updated_by} updated_at=${config.updated_at}`;
        pi.sendUserMessage(summary, { deliverAs: 'followUp' });
        notify(ctx, summary, 'info');
      } catch (error) {
        notify(ctx, `Autopilot config failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });

  pi.registerCommand(AUTOPILOT_CLAIM_GC_COMMAND, {
    description: 'Legacy migration/diagnostic claim repair only: /autopilot-claim-gc --dry-run|--apply',
    handler: async (args, ctx) => {
      const parsed = parseAutopilotClaimGcArgs(args);
      if (!parsed.ok) {
        notify(ctx, parsed.message, 'warning');
        return;
      }
      try {
        const result = await runAutopilotClaimGc({ sourceCwd: ctx.cwd ?? process.cwd(), apply: parsed.value.apply });
        const staleCount = result.candidates.filter((candidate) => candidate.stale).length;
        const blockedCount = result.candidates.filter((candidate) => candidate.blockers.length > 0).length;
        const summary = `Autopilot legacy claim diagnostic ${result.mode}: stale=${String(staleCount)} blocked=${String(blockedCount)} released=${String(result.released_claims.length)} evidence=${result.evidence_path ?? 'none'}; normal Fabric leases reconcile automatically`;
        pi.sendUserMessage(summary, { deliverAs: 'followUp' });
        notify(ctx, summary, blockedCount === 0 ? 'info' : 'warning');
      } catch (error) {
        notify(ctx, `Autopilot claim GC failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });

  pi.registerCommand(AUTOPILOT_COORDINATION_COMMAND, {
    description: 'Inspect the local Autopilot coordinator: /autopilot-coordination status|doctor',
    handler: async (args, ctx) => {
      const parsed = parseAutopilotCoordinationArgs(args);
      if (!parsed.ok) {
        notify(ctx, parsed.message, 'warning');
        return;
      }
      try {
        const client = new CoordinatorClient();
        const repoId = activeAutopilotWorkstreamRun === null ? resolveRepoIdentity(ctx.cwd ?? process.cwd()).repoKey : sessionBridge?.attachment.context.repo_id ?? 'global';
        const response = parsed.value.action === 'doctor'
          ? await client.query('doctor')
          : await client.query('status', repoId, activeAutopilotWorkstreamRun);
        const schema = typeof response.payload['schema_version'] === 'string' ? response.payload['schema_version'] : 'unknown';
        const healthy = response.payload['healthy'];
        const runCount = Array.isArray(response.payload['runs']) ? response.payload['runs'].length : 0;
        const sessionCount = Array.isArray(response.payload['session_leases']) ? response.payload['session_leases'].length : 0;
        const summary = parsed.value.action === 'doctor'
          ? `Autopilot coordinator doctor: schema=${schema} healthy=${String(healthy === true)}.`
          : `Autopilot coordinator status: schema=${schema} runs=${String(runCount)} sessions=${String(sessionCount)}.`;
        notify(ctx, summary, healthy === false ? 'error' : 'info');
      } catch (error) {
        const diagnostic = error instanceof CoordinationRuntimeError
          ? formatCoordinationRuntimeError(error)
          : error instanceof Error ? error.message : String(error);
        notify(ctx, `Autopilot coordination ${parsed.value.action} failed: ${diagnostic}`, 'error');
      }
    },
  });

  pi.registerCommand(AUTOPILOT_ONBOARD_COMMAND, {
    description:
      'Generate paste-ready Autopilot onboarding instructions: /autopilot-onboard <workstream> [handoff refs]',
    handler: (args, ctx) => {
      const parsed = parseAutopilotArgs(args, { parseRoster: false });
      if (!parsed.ok) {
        notify(ctx, onboardUsage(), 'warning');
        return Promise.resolve();
      }
      const runtimeRoot = runtimeRootForWorkstream(parsed.value.workstream);
      const prompt = renderOnboardPrompt({
        workstream: parsed.value.workstream,
        runtimeRoot,
        notes: parsed.value.remainder,
      });
      pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
      notify(ctx, `Autopilot onboard brief requested for ${parsed.value.workstream}.`, 'info');
      return Promise.resolve();
    },
  });

  pi.registerCommand(AUTOPILOT_HANDOFF_COMMAND, {
    description:
      'Create an Autopilot context handoff for the current active workstream: /autopilot-handoff [comments]',
    handler: (args, ctx) => {
      if (activeAutopilotWorkstream === null) {
        notify(
          ctx,
          `No active Autopilot workstream in this session. Start with /${AUTOPILOT_COMMAND} <workstream>, or after resuming an existing session run /${AUTOPILOT_INJECT_COMMAND} <workstream>. ${handoffUsage()}`,
          'warning',
        );
        return Promise.resolve();
      }

      try {
        activateContextBudget();
      } catch (error) {
        notify(
          ctx,
          `Autopilot could not activate context_budget for handoff: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        return Promise.resolve();
      }

      const runtimeRoot = activeAutopilotRuntimeRoot ?? runtimeRootForWorkstream(activeAutopilotWorkstream);
      const runSuffix = activeAutopilotWorkstreamRun === null ? '' : `\nActive workstream run: ${activeAutopilotWorkstreamRun}`;
      const prompt = renderHandoffPrompt({
        workstream: activeAutopilotWorkstream,
        runtimeRoot,
        comments: `${args.trim()}${runSuffix}`.trim(),
      });
      pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
      handoffRequested = true;
      notify(ctx, `Autopilot handoff requested for ${activeAutopilotWorkstream}; durable fencing will commit at session shutdown after handoff artifacts are written.`, 'info');
      return Promise.resolve();
    },
  });
}
