import { CONTEXT_BUDGET_TOOL_NAME } from "./names.js";
/** Default context percentage at or above which Autopilot must stop starting child work. */
export const DEFAULT_CONTEXT_HALT_PERCENT = 85;
export const AUTOPILOT_CONTEXT_HALT_PERCENT_ENV = 'AUTOPILOT_CONTEXT_HALT_PERCENT';
function roundToOne(value) {
    return Math.round(value * 10) / 10;
}
function percentText(value) {
    return `${roundToOne(value).toFixed(1)}%`;
}
export function evaluateContextBudget(usage, thresholdPercent = DEFAULT_CONTEXT_HALT_PERCENT) {
    if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent > 100) {
        throw new RangeError(`thresholdPercent must be a finite number in (0, 100]; received ${String(thresholdPercent)}`);
    }
    if (usage === undefined) {
        return {
            gate: 'unknown',
            percent: null,
            tokens: null,
            contextWindow: null,
            thresholdPercent,
            summary: 'context usage unavailable — treat as HALT-and-recheck: start no new child work this turn, then re-check next turn.',
        };
    }
    if (usage.percent === null || !Number.isFinite(usage.percent)) {
        return {
            gate: 'unknown',
            percent: null,
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            thresholdPercent,
            summary: 'context usage unknown after compaction or before usage is reported — treat as HALT-and-recheck.',
        };
    }
    const roundedPercent = roundToOne(usage.percent);
    if (usage.percent >= thresholdPercent) {
        return {
            gate: 'halt',
            percent: roundedPercent,
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            thresholdPercent,
            summary: `context ${percentText(usage.percent)} of ${String(usage.contextWindow)} tokens ` +
                `(>= ${String(thresholdPercent)}% gate): HALT — start no new child work, drain running work, then hand off.`,
        };
    }
    return {
        gate: 'ok',
        percent: roundedPercent,
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        thresholdPercent,
        summary: `context ${percentText(usage.percent)} of ${String(usage.contextWindow)} tokens ` +
            `(< ${String(thresholdPercent)}% gate): ok to start dependency-cleared, file-disjoint work.`,
    };
}
export function formatContextBudgetReport(report) {
    return JSON.stringify(report);
}
export function resolveContextHaltPercent(env) {
    const raw = env[AUTOPILOT_CONTEXT_HALT_PERCENT_ENV];
    if (raw === undefined || raw.trim().length === 0)
        return DEFAULT_CONTEXT_HALT_PERCENT;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
        throw new RangeError(`${AUTOPILOT_CONTEXT_HALT_PERCENT_ENV} must be a number in (0, 100]; received ${JSON.stringify(raw)}`);
    }
    return parsed;
}
export function createContextBudgetTool(thresholdPercent) {
    return {
        name: CONTEXT_BUDGET_TOOL_NAME,
        label: 'Context Budget',
        description: 'Return this Autopilot parent session context-window usage and halt gate. ' +
            `gate is "halt" at/above ${String(thresholdPercent)}%, "unknown" when usage is unavailable, ` +
            'otherwise "ok". Takes no arguments.',
        promptSnippet: 'Read this Autopilot parent session context-window usage and halt gate.',
        promptGuidelines: [
            'Call context_budget at the start of every Autopilot parent turn before reading or starting child work.',
            'If gate is halt or unknown, start no new child work; drain running work, write/update handoff, and stop.',
        ],
        parameters: { type: 'object', properties: {} },
        execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
            const report = evaluateContextBudget(ctx.getContextUsage(), thresholdPercent);
            return Promise.resolve({
                content: [{ type: 'text', text: formatContextBudgetReport(report) }],
                details: report,
            });
        },
    };
}
