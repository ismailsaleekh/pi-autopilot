import { createContextBudgetTool, resolveContextHaltPercent } from "./core/context-budget.js";
import { AUTOPILOT_COMMAND, AUTOPILOT_HANDOFF_COMMAND, AUTOPILOT_ONBOARD_COMMAND, CONTEXT_BUDGET_TOOL_NAME, } from "./core/names.js";
import { parseAutopilotArgs, runnerInvocationFromModuleUrl, runtimeRootForWorkstream } from "./core/paths.js";
import { AutopilotParallelRuntimeError, prepareAutopilotWorkstream } from "./core/parallel-runtime.js";
import { handoffUsage, onboardUsage, renderAutopilotPrompt, renderHandoffPrompt, renderOnboardPrompt, } from "./core/prompts.js";
function notify(ctx, message, kind) {
    ctx.ui.notify(message, kind);
}
export default function autopilotExtension(pi) {
    let contextBudgetRegistered = false;
    let activeAutopilotWorkstream = null;
    let activeAutopilotRuntimeRoot = null;
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
            }
            catch (error) {
                notify(ctx, `Autopilot could not activate context_budget: ${error instanceof Error ? error.message : String(error)}`, 'error');
                return;
            }
            let prepared;
            try {
                prepared = await prepareAutopilotWorkstream({
                    workstream: parsed.value.workstream,
                    sourceCwd: ctx.cwd ?? process.cwd(),
                });
            }
            catch (error) {
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
            }
            catch (error) {
                notify(ctx, `Autopilot prepared ${prepared.active.workstream_run} but could not deliver the parent prompt: ${error instanceof Error ? error.message : String(error)}`, 'error');
                return;
            }
            notify(ctx, `Autopilot activated for ${parsed.value.workstream} (${prepared.active.workstream_run}).`, 'info');
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
                notify(ctx, `No active Autopilot workstream in this session. Start with /${AUTOPILOT_COMMAND} <workstream>. ${handoffUsage()}`, 'warning');
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
