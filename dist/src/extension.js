import { createContextBudgetTool, resolveContextHaltPercent } from "./core/context-budget.js";
import { AUTOPILOT_COMMAND, AUTOPILOT_HANDOFF_COMMAND, AUTOPILOT_ONBOARD_COMMAND, CONTEXT_BUDGET_TOOL_NAME, } from "./core/names.js";
import { parseAutopilotArgs, runnerInvocationFromModuleUrl, runtimeRootForWorkstream } from "./core/paths.js";
import { handoffUsage, onboardUsage, renderAutopilotPrompt, renderHandoffPrompt, renderOnboardPrompt, } from "./core/prompts.js";
function notify(ctx, message, kind) {
    ctx.ui.notify(message, kind);
}
export default function autopilotExtension(pi) {
    let contextBudgetRegistered = false;
    let activeAutopilotWorkstream = null;
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
        handler: (args, ctx) => {
            const parsed = parseAutopilotArgs(args);
            if (!parsed.ok) {
                notify(ctx, parsed.message, 'warning');
                return Promise.resolve();
            }
            try {
                activateContextBudget();
            }
            catch (error) {
                notify(ctx, `Autopilot could not activate context_budget: ${error instanceof Error ? error.message : String(error)}`, 'error');
                return Promise.resolve();
            }
            const runtimeRoot = runtimeRootForWorkstream(parsed.value.workstream);
            activeAutopilotWorkstream = parsed.value.workstream;
            const prompt = renderAutopilotPrompt({
                workstream: parsed.value.workstream,
                runtimeRoot,
                runnerInvocation: runnerInvocationFromModuleUrl(import.meta.url),
                taskIntro: parsed.value.remainder,
            });
            pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
            notify(ctx, `Autopilot activated for ${parsed.value.workstream}.`, 'info');
            return Promise.resolve();
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
            const runtimeRoot = runtimeRootForWorkstream(activeAutopilotWorkstream);
            const prompt = renderHandoffPrompt({
                workstream: activeAutopilotWorkstream,
                runtimeRoot,
                comments: args.trim(),
            });
            pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
            notify(ctx, `Autopilot handoff requested for ${activeAutopilotWorkstream}.`, 'info');
            return Promise.resolve();
        },
    });
}
