import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOPILOT_COMMAND,
  AUTOPILOT_HANDOFF_COMMAND,
  AUTOPILOT_RUNNER_BIN,
  AUTOPILOT_STATUS_TOOL,
  CONTEXT_BUDGET_TOOL_NAME,
} from '../../src/core/names.ts';
import { renderHandoffPrompt, renderOnboardPrompt } from '../../src/core/prompts.ts';

function onboardPrompt(): string {
  return renderOnboardPrompt({
    workstream: 'demo',
    runtimeRoot: '.pi/autopilot/demo',
    notes: 'resume after validation wave',
  });
}

function handoffPrompt(): string {
  return renderHandoffPrompt({
    workstream: 'demo',
    runtimeRoot: '.pi/autopilot/demo',
    comments: 'operator comment: validate package docs before release',
  });
}

function legacyRuntimePattern(): RegExp {
  return new RegExp(`${'.pi'}/` + ['h', 'lo'].join(''));
}

void describe('Autopilot onboard and handoff prompts', () => {
  void it('keeps onboard as a read-only brief generator rather than a parent or launcher', () => {
    const prompt = onboardPrompt();
    assert.match(prompt, /onboard-brief generator/);
    assert.match(prompt, /read-only/);
    assert.match(prompt, /Do not start child agents or background tasks/);
    assert.match(prompt, /Do not create, edit, move, delete/);
    assert.match(prompt, /Do not run source gates, tests, builds, provider calls, network calls/);
    assert.equal(prompt.includes(`Do not call \`${AUTOPILOT_RUNNER_BIN}\``), true);
  });

  void it('generates a future slash command block with startup and machine-truth requirements', () => {
    const prompt = onboardPrompt();
    assert.match(prompt, new RegExp(`/${AUTOPILOT_COMMAND} demo`));
    assert.equal(prompt.includes(`require \`${CONTEXT_BUDGET_TOOL_NAME}\` first`), true);
    assert.match(prompt, /runtime root `\.pi\/autopilot\/demo`/);
    assert.match(prompt, /handoff\.json/);
    assert.match(prompt, /state\.json/);
    assert.match(prompt, /events\.jsonl/);
    assert.match(prompt, /validated status\+receipt evidence/);
    assert.match(prompt, /markdown notes are hints, not truth/);
  });

  void it('keeps onboard output on Autopilot names only', () => {
    const prompt = onboardPrompt();
    assert.match(prompt, new RegExp(AUTOPILOT_RUNNER_BIN));
    assert.equal(prompt.includes(AUTOPILOT_STATUS_TOOL), false);
    assert.equal(legacyRuntimePattern().test(prompt), false);
  });

  void it('forces handoff to use the current workstream and produce a next Autopilot block', () => {
    const prompt = handoffPrompt();
    assert.match(prompt, new RegExp(`/${AUTOPILOT_HANDOFF_COMMAND}`));
    assert.match(prompt, new RegExp(`/${AUTOPILOT_COMMAND} demo`));
    assert.match(prompt, /current Autopilot parent for workstream `demo`/);
    assert.match(prompt, /first line is exactly/);
    assert.match(prompt, /Next Autopilot command/);
    assert.match(prompt, /operator comment: validate package docs before release/);
    assert.equal(prompt.includes(AUTOPILOT_STATUS_TOOL), false);
  });
});
