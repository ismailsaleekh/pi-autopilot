import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOPILOT_COMMAND,
  AUTOPILOT_RUNNER_BIN,
  AUTOPILOT_STATUS_TOOL,
  CONTEXT_BUDGET_TOOL_NAME,
} from '../../src/core/names.ts';
import { renderRestartPrompt } from '../../src/core/prompts.ts';

function restartPrompt(): string {
  return renderRestartPrompt({
    workstream: 'demo',
    runtimeRoot: '.pi/autopilot/demo',
    notes: 'resume after validation wave',
  });
}

function legacyRuntimePattern(): RegExp {
  return new RegExp(`${'.pi'}/` + ['h', 'lo'].join(''));
}

void describe('Autopilot restart prompt', () => {
  void it('is a read-only brief generator rather than a parent or launcher', () => {
    const prompt = restartPrompt();
    assert.match(prompt, /restart-brief generator/);
    assert.match(prompt, /read-only/);
    assert.match(prompt, /Do not start child agents or background tasks/);
    assert.match(prompt, /Do not create, edit, move, delete/);
    assert.match(prompt, /Do not run source gates, tests, builds, provider calls, network calls/);
    assert.equal(prompt.includes(`Do not call \`${AUTOPILOT_RUNNER_BIN}\``), true);
  });

  void it('generates a future slash command block with startup and machine-truth requirements', () => {
    const prompt = restartPrompt();
    assert.match(prompt, new RegExp(`/${AUTOPILOT_COMMAND} demo`));
    assert.equal(prompt.includes(`require \`${CONTEXT_BUDGET_TOOL_NAME}\` first`), true);
    assert.match(prompt, /runtime root `\.pi\/autopilot\/demo`/);
    assert.match(prompt, /state\.json/);
    assert.match(prompt, /events\.jsonl/);
    assert.match(prompt, /validated status\+receipt evidence/);
    assert.match(prompt, /markdown notes are hints, not truth/);
  });

  void it('keeps restart output on Autopilot names only', () => {
    const prompt = restartPrompt();
    assert.match(prompt, new RegExp(AUTOPILOT_RUNNER_BIN));
    assert.equal(prompt.includes(AUTOPILOT_STATUS_TOOL), false);
    assert.equal(legacyRuntimePattern().test(prompt), false);
  });
});
