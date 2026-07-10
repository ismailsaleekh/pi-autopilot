import { createContextBudgetTool, resolveContextHaltPercent } from "./core/context-budget.js";
import { AUTOPILOT_ABORT_COMMAND, AUTOPILOT_CLAIM_GC_COMMAND, AUTOPILOT_CLOSE_COMMAND, AUTOPILOT_COMMAND, AUTOPILOT_CONFIG_COMMAND, AUTOPILOT_HANDOFF_COMMAND, AUTOPILOT_INJECT_COMMAND, AUTOPILOT_ONBOARD_COMMAND, CONTEXT_BUDGET_TOOL_NAME, } from "./core/names.js";
import { parseAutopilotAbortArgs, parseAutopilotArgs, parseAutopilotClaimGcArgs, parseAutopilotCloseArgs, parseAutopilotConfigArgs, parseAutopilotInjectArgs, runnerInvocationFromModuleUrl, runtimeRootForWorkstream } from "./core/paths.js";
import { AutopilotCloseError, abortAutopilotWorkstream, closeAutopilotWorkstream } from "./core/close-runtime.js";
import { runAutopilotClaimGc } from "./core/claim-gc.js";
import { readSchedulerConfig, writeSchedulerConfig } from "./core/scheduler-config.js";
import { AUTOPILOT_PARENT_MODEL_ASSIGNMENT } from "./core/model-roster.js";
import { evaluateAutopilotWorktreeToolCall, } from "./core/git-guard.js";
import { AutopilotParallelRuntimeError, prepareAutopilotWorkstream } from "./core/parallel-runtime.js";
import { handoffUsage, onboardUsage, renderAutopilotPrompt, renderHandoffPrompt, renderOnboardPrompt, } from "./core/prompts.js";
function notify(ctx, message, kind) {
    ctx.ui.notify(message, kind);
}
export default function autopilotExtension(pi) {
    let contextBudgetRegistered = false;
    let worktreeGuardRegistered = false;
    let activeAutopilotWorkstream = null;
    let activeAutopilotRuntimeRoot = null;
    let activeAutopilotWorktreePath = null;
    let activeAutopilotWorkstreamRun = null;
    function activateContextBudget() {
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
    async function activateParentModelRoster(ctx) {
        const assignment = AUTOPILOT_PARENT_MODEL_ASSIGNMENT;
        const slash = assignment.model.indexOf('/');
        const provider = assignment.model.slice(0, slash);
        const modelId = assignment.model.slice(slash + 1);
        if (slash <= 0 ||
            modelId.length === 0 ||
            ctx.modelRegistry === undefined ||
            pi.setModel === undefined ||
            pi.setThinkingLevel === undefined ||
            pi.getThinkingLevel === undefined) {
            notify(ctx, `Autopilot cannot enforce parent model roster ${assignment.model} at ${assignment.thinking}: Pi model-selection APIs are unavailable.`, 'error');
            return false;
        }
        const model = ctx.modelRegistry.find(provider, modelId);
        if (model === undefined) {
            notify(ctx, `Autopilot cannot enforce parent model roster: ${assignment.model} is not registered in this Pi installation.`, 'error');
            return false;
        }
        let selected;
        try {
            selected = await pi.setModel(model);
        }
        catch (error) {
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
    function registerWorktreeGuardIfSupported() {
        if (worktreeGuardRegistered || pi.on === undefined)
            return;
        pi.on('tool_call', (event, toolCtx) => {
            if (activeAutopilotWorktreePath === null)
                return undefined;
            return evaluateAutopilotWorktreeToolCall(event, toolCtx, {
                worktreeRoot: activeAutopilotWorktreePath,
                label: 'Autopilot worktree guard',
                allowedWriteRoots: activeAutopilotRuntimeRoot === null ? [] : [activeAutopilotRuntimeRoot],
            });
        });
        worktreeGuardRegistered = true;
    }
    async function prepareAndActivateWorkstream(input) {
        try {
            activateContextBudget();
        }
        catch (error) {
            notify(input.ctx, `${input.contextBudgetErrorPrefix}: ${error instanceof Error ? error.message : String(error)}`, 'error');
            return null;
        }
        if (!(await activateParentModelRoster(input.ctx)))
            return null;
        let prepared;
        try {
            prepared = await prepareAutopilotWorkstream({
                workstream: input.workstream,
                sourceCwd: input.ctx.cwd ?? process.cwd(),
            });
        }
        catch (error) {
            const message = error instanceof AutopilotParallelRuntimeError ? error.message : error instanceof Error ? error.message : String(error);
            notify(input.ctx, `${input.prepareErrorPrefix}: ${message}`, 'error');
            return null;
        }
        activeAutopilotWorkstream = prepared.active.workstream;
        activeAutopilotRuntimeRoot = prepared.runtimeRoot;
        activeAutopilotWorktreePath = prepared.mainWorktreePath;
        activeAutopilotWorkstreamRun = prepared.active.workstream_run;
        registerWorktreeGuardIfSupported();
        return prepared;
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
            if (prepared === null)
                return;
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
            }
            catch (error) {
                notify(ctx, `Autopilot prepared ${prepared.active.workstream_run} but could not deliver the parent prompt: ${error instanceof Error ? error.message : String(error)}`, 'error');
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
            if (prepared === null)
                return;
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
                });
                const blockerText = result.blockers.length === 0 ? '' : `\nBlockers:\n${result.blockers.map((blocker) => `- ${blocker}`).join('\n')}`;
                const summary = [
                    `Autopilot close ${result.outcome} for ${result.workstream_run}.`,
                    `Branch: ${result.branch}`,
                    `Target: ${result.target_branch ?? 'detached-HEAD'}`,
                    `Changed paths: ${String(result.changed_paths.length)}`,
                    result.close_result_path === null ? null : `Close result: ${result.close_result_path}`,
                    blockerText.length === 0 ? null : blockerText,
                ].filter((line) => line !== null).join('\n');
                pi.sendUserMessage(summary, { deliverAs: 'followUp' });
                notify(ctx, `Autopilot close ${result.outcome} for ${result.workstream_run}.`, result.outcome === 'closed' ? 'info' : result.outcome === 'dry-run' ? 'info' : 'warning');
            }
            catch (error) {
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
                ].filter((line) => line !== null).join('\n');
                pi.sendUserMessage(summary, { deliverAs: 'followUp' });
                notify(ctx, `Autopilot abort ${result.outcome} for ${result.workstream_run}.`, result.outcome === 'aborted' ? 'info' : result.outcome === 'dry-run' ? 'info' : 'warning');
            }
            catch (error) {
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
            }
            catch (error) {
                notify(ctx, `Autopilot config failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
            }
        },
    });
    pi.registerCommand(AUTOPILOT_CLAIM_GC_COMMAND, {
        description: 'Evidence-backed Autopilot claim garbage collection: /autopilot-claim-gc --dry-run|--apply',
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
                const summary = `Autopilot claim GC ${result.mode}: stale=${String(staleCount)} blocked=${String(blockedCount)} released=${String(result.released_claims.length)} evidence=${result.evidence_path ?? 'none'}`;
                pi.sendUserMessage(summary, { deliverAs: 'followUp' });
                notify(ctx, summary, blockedCount === 0 ? 'info' : 'warning');
            }
            catch (error) {
                notify(ctx, `Autopilot claim GC failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
            }
        },
    });
    pi.registerCommand(AUTOPILOT_ONBOARD_COMMAND, {
        description: 'Generate paste-ready Autopilot onboarding instructions: /autopilot-onboard <workstream> [handoff refs]',
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
        description: 'Create an Autopilot context handoff for the current active workstream: /autopilot-handoff [comments]',
        handler: (args, ctx) => {
            if (activeAutopilotWorkstream === null) {
                notify(ctx, `No active Autopilot workstream in this session. Start with /${AUTOPILOT_COMMAND} <workstream>, or after resuming an existing session run /${AUTOPILOT_INJECT_COMMAND} <workstream>. ${handoffUsage()}`, 'warning');
                return Promise.resolve();
            }
            try {
                activateContextBudget();
            }
            catch (error) {
                notify(ctx, `Autopilot could not activate context_budget for handoff: ${error instanceof Error ? error.message : String(error)}`, 'error');
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
