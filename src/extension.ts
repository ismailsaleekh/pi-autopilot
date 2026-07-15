import { randomUUID } from 'node:crypto';

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
import { parseAutopilotAbortArgs, parseAutopilotArgs, parseAutopilotClaimGcArgs, parseAutopilotCloseArgs, parseAutopilotConfigArgs, parseAutopilotCoordinationArgs, parseAutopilotInjectArgs, runnerInvocationFromModuleUrl, runtimeRootForWorkstream } from './core/paths.ts';
import { AutopilotCloseError, abortAutopilotWorkstream, closeAutopilotWorkstream } from './core/close-runtime.ts';
import { runAutopilotClaimGc } from './core/claim-gc.ts';
import { readSchedulerConfig, writeSchedulerConfig } from './core/scheduler-config.ts';
import { AUTOPILOT_PARENT_MODEL_ASSIGNMENT } from './core/model-roster.ts';
import {
  evaluateAutopilotWorktreeToolCall,
  type AutopilotGuardDecision,
  type AutopilotToolCallContextLike,
  type AutopilotToolCallEventLike,
} from './core/git-guard.ts';
import { AutopilotParallelRuntimeError, coordinationRootForRepo, prepareAutopilotWorkstream, recoverAutopilotWorktreeSagas, resolveRepoIdentity, type PreparedAutopilotWorkstream } from './core/parallel-runtime.ts';
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
  renderAutopilotPrompt,
  renderHandoffPrompt,
  renderOnboardPrompt,
} from './core/prompts.ts';

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

export interface ExtensionEventRegistrar {
  (eventName: 'tool_call', handler: ExtensionToolCallHandler): void;
  (eventName: 'session_start' | 'session_shutdown', handler: ExtensionLifecycleHandler): void;
}

export type AutopilotParentToolDefinition = ReturnType<typeof createContextBudgetTool> | ClaimResponseToolDefinition;

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

function notify(ctx: ExtensionCommandContextLike, message: string, kind: NotificationKind): void {
  ctx.ui.notify(message, kind);
}

export default function autopilotExtension(pi: ExtensionHostLike): void {
  let contextBudgetRegistered = false;
  let claimResponseToolRegistered = false;
  let worktreeGuardRegistered = false;
  let activeAutopilotWorkstream: string | null = null;
  let activeAutopilotRuntimeRoot: string | null = null;
  let activeAutopilotWorktreePath: string | null = null;
  let activeAutopilotWorkstreamRun: string | null = null;
  let sessionBridge: AutopilotSessionBridge | null = null;
  let lifecycleSessionId = `pi-session-${randomUUID()}`;
  let handoffRequested = false;

  function activateContextBudget(): void {
    if (!contextBudgetRegistered) {
      const threshold = resolveContextHaltPercent(process.env);
      pi.registerTool(createContextBudgetTool(threshold));
      contextBudgetRegistered = true;
    }

    if (pi.getActiveTools !== undefined && pi.setActiveTools !== undefined) {
      const activeTools = pi.getActiveTools();
      if (!activeTools.includes(CONTEXT_BUDGET_TOOL_NAME)) {
        pi.setActiveTools([...activeTools, CONTEXT_BUDGET_TOOL_NAME]);
      }
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

  async function activateParentModelRoster(ctx: ExtensionCommandContextLike): Promise<boolean> {
    const assignment = AUTOPILOT_PARENT_MODEL_ASSIGNMENT;
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
    } catch (error) {
      notify(ctx, `Autopilot cannot select parent roster model ${assignment.model}: ${error instanceof Error ? error.message : String(error)}`, 'error');
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
  }

  function rawSessionId(ctx: ExtensionCommandContextLike): string {
    const sessionId = ctx.sessionManager?.getSessionId();
    return sessionId === undefined || sessionId.length === 0 ? lifecycleSessionId : sessionId;
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
    readonly contextBudgetErrorPrefix: string;
    readonly prepareErrorPrefix: string;
  }): Promise<PreparedAutopilotWorkstream | null> {
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

    if (!(await activateParentModelRoster(input.ctx))) return null;

    let prepared: PreparedAutopilotWorkstream;
    try {
      prepared = await prepareAutopilotWorkstream({
        workstream: input.workstream,
        sourceCwd: input.ctx.cwd ?? process.cwd(),
        coordinationSessionId: rawSessionId(input.ctx),
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

    if (!(await attachSessionBridge(prepared, input.ctx))) return null;

    activeAutopilotWorkstream = prepared.active.workstream;
    activeAutopilotRuntimeRoot = prepared.runtimeRoot;
    activeAutopilotWorktreePath = prepared.mainWorktreePath;
    activeAutopilotWorkstreamRun = prepared.active.workstream_run;
    registerWorktreeGuardIfSupported();
    return prepared;
  }

  if (pi.on !== undefined) {
    pi.on('session_start', (_event, ctx) => {
      const restored = ctx.sessionManager?.getSessionId();
      lifecycleSessionId = restored === undefined || restored.length === 0 ? `pi-session-${randomUUID()}` : restored;
    });
    pi.on('session_shutdown', async (event, ctx) => {
      if (sessionBridge === null) return;
      try {
        if (handoffRequested) await sessionBridge.prepareHandoff();
        else await sessionBridge.close(typeof event['reason'] === 'string' ? event['reason'] : 'session-shutdown');
      } catch (error) {
        notify(ctx, `Autopilot session bridge shutdown failed loudly: ${error instanceof Error ? error.message : String(error)}`, 'error');
      } finally {
        const contextPath = sessionBridge.attachment.contextPath;
        if (process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV] === contextPath) delete process.env[AUTOPILOT_COORDINATOR_SESSION_CONTEXT_ENV];
        sessionBridge = null;
        deactivateClaimResponseTool();
        clearActiveAutopilotState();
      }
    });
  }

  pi.registerCommand(AUTOPILOT_COMMAND, {
    description: 'Start or resume Autopilot orchestration: /autopilot <workstream> [task intro]',
    handler: async (args, ctx) => {
      const parsed = parseAutopilotArgs(args);
      if (!parsed.ok) {
        notify(ctx, parsed.message, 'warning');
        return;
      }

      const prepared = await prepareAndActivateWorkstream({
        workstream: parsed.value.workstream,
        ctx,
        contextBudgetErrorPrefix: 'Autopilot could not activate context_budget',
        prepareErrorPrefix: 'Autopilot could not prepare isolated worktree',
      });
      if (prepared === null) return;

      const runtimeRoot = prepared.runtimeRoot;
      const prompt = renderAutopilotPrompt({
        workstream: parsed.value.workstream,
        runtimeRoot,
        runnerInvocation: runnerInvocationFromModuleUrl(import.meta.url),
        taskIntro: parsed.value.remainder,
        workstreamRun: prepared.active.workstream_run,
        sourceRepo: prepared.active.source_repo,
        worktreePath: prepared.mainWorktreePath,
        branch: prepared.active.branch,
        repoKey: prepared.active.repo_key,
        targetBranch: prepared.active.target_branch,
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
      notify(ctx, `Autopilot activated for ${parsed.value.workstream} (${prepared.active.workstream_run}).`, 'info');
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

      const prepared = await prepareAndActivateWorkstream({
        workstream: parsed.value.workstream,
        ctx,
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
        notify(ctx, `Autopilot coordination ${parsed.value.action} failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });

  pi.registerCommand(AUTOPILOT_ONBOARD_COMMAND, {
    description:
      'Generate paste-ready Autopilot onboarding instructions: /autopilot-onboard <workstream> [handoff refs]',
    handler: (args, ctx) => {
      const parsed = parseAutopilotArgs(args);
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
