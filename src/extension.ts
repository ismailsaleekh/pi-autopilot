import { createContextBudgetTool, resolveContextHaltPercent } from './core/context-budget.ts';
import {
  AUTOPILOT_ABORT_COMMAND,
  AUTOPILOT_CLOSE_COMMAND,
  AUTOPILOT_COMMAND,
  AUTOPILOT_HANDOFF_COMMAND,
  AUTOPILOT_ONBOARD_COMMAND,
  CONTEXT_BUDGET_TOOL_NAME,
} from './core/names.ts';
import { parseAutopilotAbortArgs, parseAutopilotArgs, parseAutopilotCloseArgs, runnerInvocationFromModuleUrl, runtimeRootForWorkstream } from './core/paths.ts';
import { AutopilotCloseError, abortAutopilotWorkstream, closeAutopilotWorkstream } from './core/close-runtime.ts';
import { AutopilotParallelRuntimeError, prepareAutopilotWorkstream } from './core/parallel-runtime.ts';
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

export interface ExtensionCommandContextLike {
  readonly ui: ExtensionUiLike;
  readonly cwd?: string;
}

export interface ExtensionCommandDefinitionLike {
  readonly description: string;
  handler(args: string, ctx: ExtensionCommandContextLike): Promise<void>;
}

export interface ExtensionHostLike {
  registerCommand(name: string, definition: ExtensionCommandDefinitionLike): void;
  registerTool(tool: ReturnType<typeof createContextBudgetTool>): void;
  getActiveTools?(): readonly string[];
  setActiveTools?(toolNames: readonly string[]): void;
  sendUserMessage(content: string, options: { readonly deliverAs: 'followUp' }): void;
}

function notify(ctx: ExtensionCommandContextLike, message: string, kind: NotificationKind): void {
  ctx.ui.notify(message, kind);
}

export default function autopilotExtension(pi: ExtensionHostLike): void {
  let contextBudgetRegistered = false;
  let activeAutopilotWorkstream: string | null = null;
  let activeAutopilotRuntimeRoot: string | null = null;
  let activeAutopilotWorkstreamRun: string | null = null;

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

  pi.registerCommand(AUTOPILOT_COMMAND, {
    description: 'Start or resume Autopilot orchestration: /autopilot <workstream> [task intro]',
    handler: async (args, ctx) => {
      const parsed = parseAutopilotArgs(args);
      if (!parsed.ok) {
        notify(ctx, parsed.message, 'warning');
        return;
      }

      try {
        activateContextBudget();
      } catch (error) {
        notify(
          ctx,
          `Autopilot could not activate context_budget: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        return;
      }

      let prepared;
      try {
        prepared = await prepareAutopilotWorkstream({
          workstream: parsed.value.workstream,
          sourceCwd: ctx.cwd ?? process.cwd(),
        });
      } catch (error) {
        const message = error instanceof AutopilotParallelRuntimeError ? error.message : error instanceof Error ? error.message : String(error);
        notify(ctx, `Autopilot could not prepare isolated worktree: ${message}`, 'error');
        return;
      }

      const runtimeRoot = prepared.runtimeRoot;
      activeAutopilotWorkstream = parsed.value.workstream;
      activeAutopilotRuntimeRoot = runtimeRoot;
      activeAutopilotWorkstreamRun = prepared.active.workstream_run;
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
        });
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
        });
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
          `No active Autopilot workstream in this session. Start with /${AUTOPILOT_COMMAND} <workstream>. ${handoffUsage()}`,
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
      notify(ctx, `Autopilot handoff requested for ${activeAutopilotWorkstream}.`, 'info');
      return Promise.resolve();
    },
  });
}
