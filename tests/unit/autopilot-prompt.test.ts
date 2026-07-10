import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AUTOPILOT_ABORT_COMMAND, AUTOPILOT_CLOSE_COMMAND, AUTOPILOT_STATUS_TOOL, CONTEXT_BUDGET_TOOL_NAME } from '../../src/core/names.ts';
import { renderAutopilotPrompt } from '../../src/core/prompts.ts';

function parentPrompt(): string {
  return renderAutopilotPrompt({
    workstream: 'demo',
    runtimeRoot: '.pi/autopilot/demo',
    runnerInvocation: '/opt/pi-autopilot/bin/autopilot-agent-run.mjs',
    taskIntro: 'ship parent prompt hardening',
  });
}

function legacyRuntimePattern(): RegExp {
  return new RegExp(`${'.pi'}/` + ['h', 'lo'].join(''));
}

void describe('Autopilot parent prompt', () => {
  void it('requires context_budget before reads, resume, or launches', () => {
    const prompt = parentPrompt();
    const gateIndex = prompt.indexOf(`call \`${CONTEXT_BUDGET_TOOL_NAME}\` with no arguments`);
    const readIndex = prompt.indexOf('resume from `.pi/autopilot/demo/state.json`');
    const launchIndex = prompt.indexOf('Start child work only through');
    assert.equal(gateIndex !== -1, true);
    assert.equal(readIndex !== -1, true);
    assert.equal(launchIndex !== -1, true);
    assert.equal(gateIndex < readIndex, true);
    assert.equal(gateIndex < launchIndex, true);
  });

  void it('pins resume and launch authority to Autopilot machine state and injected runner', () => {
    const prompt = parentPrompt();
    assert.match(prompt, /Runtime root: `\.pi\/autopilot\/demo`/);
    assert.match(prompt, /state\.json/);
    assert.match(prompt, /events\.jsonl/);
    assert.match(prompt, /machine truth/);
    assert.match(prompt, /exact injected invocation `\/opt\/pi-autopilot\/bin\/autopilot-agent-run\.mjs <unit-spec\.json>`/);
    assert.match(prompt, /Do not call `autopilot-agent-run` directly unless it is the injected invocation/);
    assert.match(prompt, new RegExp(`/${AUTOPILOT_CLOSE_COMMAND}`));
    assert.match(prompt, new RegExp(`/${AUTOPILOT_ABORT_COMMAND}`));
  });

  void it('rejects bypass evidence, raw child launches, outside-worktree git, and metered routes', () => {
    const prompt = parentPrompt();
    assert.match(prompt, /validated status and receipt pair/);
    assert.match(prompt, /assistant-text JSON, markdown reports, logs, screenshots, or self-certification/);
    assert.match(prompt, /Do not hand-assemble raw child Pi launches/);
    assert.match(prompt, /raw Pi commands/);
    assert.match(prompt, /Git discipline is worktree-scoped/);
    assert.match(prompt, /git operations outside/);
    assert.match(prompt, /metered frontier routes/);
    assert.equal(prompt.includes(AUTOPILOT_STATUS_TOOL), false);
    assert.equal(legacyRuntimePattern().test(prompt), false);
  });

  void it('injects the complete fixed parent and child model roster', () => {
    const prompt = parentPrompt();
    assert.match(prompt, /parent\/orchestrator: openai-codex\/gpt-5\.6-sol at xhigh/u);
    assert.match(prompt, /strategy: openai-codex\/gpt-5\.6-sol at xhigh/u);
    assert.match(prompt, /implement: openai-codex\/gpt-5\.6-terra at high/u);
    assert.match(prompt, /validate: openai-codex\/gpt-5\.6-sol at xhigh/u);
    assert.match(prompt, /fix: openai-codex\/gpt-5\.6-terra at high/u);
    assert.match(prompt, /adjudicate: openai-codex\/gpt-5\.6-sol at xhigh/u);
    assert.match(prompt, /bughunt: openai-codex\/gpt-5\.6-sol at xhigh/u);
    assert.match(prompt, /extract: openai-codex\/gpt-5\.6-luna at high/u);
    assert.match(prompt, /Never substitute another model or thinking level/u);
  });

  void it('contains package-owned perfect-quality rules', () => {
    const prompt = parentPrompt();
    assert.match(prompt, /Perfect-quality contract/);
    assert.match(prompt, /band-aids/);
    assert.match(prompt, /hacks/);
    assert.match(prompt, /silent fallbacks/);
    assert.match(prompt, /fake-green tests/);
    assert.match(prompt, /fixture tampering/);
    assert.match(prompt, /deferred consumers/);
    assert.match(prompt, /self-certifying/);
    assert.match(prompt, /route adjudication/);
  });
});
