import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_HALT_PERCENT,
  AUTOPILOT_CONTEXT_HALT_PERCENT_ENV,
  createContextBudgetTool,
  evaluateContextBudget,
  formatContextBudgetReport,
  resolveContextHaltPercent,
  type ContextBudgetToolContext,
  type ContextUsageLike,
} from '../../src/core/context-budget.ts';
import { CONTEXT_BUDGET_TOOL_NAME } from '../../src/core/names.ts';

void describe('context budget core', () => {
  void it('returns ok below the default gate', () => {
    const report = evaluateContextBudget({ tokens: 40_000, contextWindow: 200_000, percent: 20 });
    assert.equal(report.gate, 'ok');
    assert.equal(report.percent, 20);
    assert.equal(report.thresholdPercent, DEFAULT_CONTEXT_HALT_PERCENT);
  });

  void it('halts at the inclusive threshold', () => {
    const report = evaluateContextBudget({ tokens: 170_000, contextWindow: 200_000, percent: 85 });
    assert.equal(report.gate, 'halt');
    assert.match(report.summary, /HALT/);
  });

  void it('rounds reported percentage to one decimal', () => {
    const report = evaluateContextBudget({ tokens: 184_466, contextWindow: 200_000, percent: 92.233 });
    assert.equal(report.percent, 92.2);
  });

  void it('reports unknown when usage is absent', () => {
    const report = evaluateContextBudget(undefined);
    assert.equal(report.gate, 'unknown');
    assert.equal(report.contextWindow, null);
  });

  void it('reports unknown when percentage is unavailable', () => {
    const usage: ContextUsageLike = { tokens: null, contextWindow: 200_000, percent: null };
    const report = evaluateContextBudget(usage);
    assert.equal(report.gate, 'unknown');
    assert.equal(report.contextWindow, 200_000);
  });

  void it('rejects invalid thresholds loudly', () => {
    assert.throws(() => evaluateContextBudget(undefined, 0), RangeError);
    assert.throws(() => evaluateContextBudget(undefined, 101), RangeError);
    assert.throws(() => evaluateContextBudget(undefined, Number.NaN), RangeError);
  });

  void it('formats a parseable JSON report', () => {
    const report = evaluateContextBudget({ tokens: 170_000, contextWindow: 200_000, percent: 85 });
    const parsed: unknown = JSON.parse(formatContextBudgetReport(report));
    assert.ok(typeof parsed === 'object' && parsed !== null);
  });

  void it('reads only the Autopilot threshold env var', () => {
    assert.equal(resolveContextHaltPercent({}), DEFAULT_CONTEXT_HALT_PERCENT);
    assert.equal(resolveContextHaltPercent({ AUTOPILOT_CONTEXT_HALT_PERCENT: '   ' }), DEFAULT_CONTEXT_HALT_PERCENT);
    assert.equal(resolveContextHaltPercent({ AUTOPILOT_CONTEXT_HALT_PERCENT: '90' }), 90);
    assert.equal(resolveContextHaltPercent({ AUTOPILOT_CONTEXT_HALT_PERCENT: '72.5' }), 72.5);
    assert.equal(resolveContextHaltPercent({ HLO_CONTEXT_HALT_PERCENT: '90' }), DEFAULT_CONTEXT_HALT_PERCENT);
    assert.throws(
      () => resolveContextHaltPercent({ AUTOPILOT_CONTEXT_HALT_PERCENT: 'not-a-number' }),
      RangeError,
    );
  });

  void it('names and describes the package-owned context_budget tool with the bound threshold', () => {
    const tool = createContextBudgetTool(72.5);
    assert.equal(tool.name, CONTEXT_BUDGET_TOOL_NAME);
    assert.match(tool.description, new RegExp(AUTOPILOT_CONTEXT_HALT_PERCENT_ENV.replace('AUTOPILOT_', '') + '|72\\.5'));
    assert.deepEqual(tool.parameters, { type: 'object', properties: {} });
  });

  void it('tool executes against the supplied context usage', async () => {
    const tool = createContextBudgetTool(DEFAULT_CONTEXT_HALT_PERCENT);
    const ctx: ContextBudgetToolContext = {
      getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
    };
    const result = await tool.execute('call-1', {}, undefined, undefined, ctx);
    assert.equal(result.details.gate, 'ok');
    assert.match(result.content[0].text, /"gate":"ok"/);
  });
});
