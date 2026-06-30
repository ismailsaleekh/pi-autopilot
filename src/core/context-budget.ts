import { CONTEXT_BUDGET_TOOL_NAME } from './names.ts';

/** Default context percentage at or above which Autopilot must stop starting child work. */
export const DEFAULT_CONTEXT_HALT_PERCENT = 85;
export const AUTOPILOT_CONTEXT_HALT_PERCENT_ENV = 'AUTOPILOT_CONTEXT_HALT_PERCENT';

export interface ContextUsageLike {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

export type ContextBudgetGate = 'ok' | 'halt' | 'unknown';

export interface ContextBudgetReport {
  readonly gate: ContextBudgetGate;
  readonly percent: number | null;
  readonly tokens: number | null;
  readonly contextWindow: number | null;
  readonly thresholdPercent: number;
  readonly summary: string;
}

export interface EmptyToolParameters {
  readonly [key: string]: never;
}

export interface ContextBudgetToolResult {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly details: ContextBudgetReport;
}

export interface ContextBudgetToolContext {
  getContextUsage(): ContextUsageLike | undefined;
}

export interface EnvMap {
  readonly [key: string]: string | undefined;
}

export interface ContextBudgetToolDefinition {
  readonly name: typeof CONTEXT_BUDGET_TOOL_NAME;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  readonly parameters: { readonly type: 'object'; readonly properties: EmptyToolParameters };
  execute(
    toolCallId: string,
    params: EmptyToolParameters,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ContextBudgetToolContext,
  ): Promise<ContextBudgetToolResult>;
}

function roundToOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function percentText(value: number): string {
  return `${roundToOne(value).toFixed(1)}%`;
}

export function evaluateContextBudget(
  usage: ContextUsageLike | undefined,
  thresholdPercent: number = DEFAULT_CONTEXT_HALT_PERCENT,
): ContextBudgetReport {
  if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent > 100) {
    throw new RangeError(
      `thresholdPercent must be a finite number in (0, 100]; received ${String(thresholdPercent)}`,
    );
  }

  if (usage === undefined) {
    return {
      gate: 'unknown',
      percent: null,
      tokens: null,
      contextWindow: null,
      thresholdPercent,
      summary:
        'context usage unavailable — treat as HALT-and-recheck: start no new child work this turn, then re-check next turn.',
    };
  }

  if (usage.percent === null || !Number.isFinite(usage.percent)) {
    return {
      gate: 'unknown',
      percent: null,
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      thresholdPercent,
      summary:
        'context usage unknown after compaction or before usage is reported — treat as HALT-and-recheck.',
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
      summary:
        `context ${percentText(usage.percent)} of ${String(usage.contextWindow)} tokens ` +
        `(>= ${String(thresholdPercent)}% gate): HALT — start no new child work, drain running work, then hand off.`,
    };
  }

  return {
    gate: 'ok',
    percent: roundedPercent,
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    thresholdPercent,
    summary:
      `context ${percentText(usage.percent)} of ${String(usage.contextWindow)} tokens ` +
      `(< ${String(thresholdPercent)}% gate): ok to start dependency-cleared, file-disjoint work.`,
  };
}

export function formatContextBudgetReport(report: ContextBudgetReport): string {
  return JSON.stringify(report);
}

export function resolveContextHaltPercent(env: EnvMap): number {
  const raw = env[AUTOPILOT_CONTEXT_HALT_PERCENT_ENV];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_CONTEXT_HALT_PERCENT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    throw new RangeError(
      `${AUTOPILOT_CONTEXT_HALT_PERCENT_ENV} must be a number in (0, 100]; received ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

export function createContextBudgetTool(thresholdPercent: number): ContextBudgetToolDefinition {
  return {
    name: CONTEXT_BUDGET_TOOL_NAME,
    label: 'Context Budget',
    description:
      'Return this Autopilot parent session context-window usage and halt gate. ' +
      `gate is "halt" at/above ${String(thresholdPercent)}%, "unknown" when usage is unavailable, ` +
      'otherwise "ok". Takes no arguments.',
    promptSnippet: 'Read this Autopilot parent session context-window usage and halt gate.',
    promptGuidelines: [
      'Call context_budget at the start of every Autopilot parent turn before reading or starting child work.',
      'If gate is halt or unknown, start no new child work; drain running work, write/update handoff, and stop.',
    ],
    parameters: { type: 'object', properties: {} },
    execute(
      _toolCallId: string,
      _params: EmptyToolParameters,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ContextBudgetToolContext,
    ): Promise<ContextBudgetToolResult> {
      const report = evaluateContextBudget(ctx.getContextUsage(), thresholdPercent);
      return Promise.resolve({
        content: [{ type: 'text', text: formatContextBudgetReport(report) }],
        details: report,
      });
    },
  };
}
