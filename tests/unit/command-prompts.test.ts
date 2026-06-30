import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOPILOT_COMMAND,
  AUTOPILOT_RUNNER_BIN,
  AUTOPILOT_STATUS_TOOL,
  CONTEXT_BUDGET_TOOL_NAME,
} from '../../src/core/names.ts';
import { parseAutopilotArgs, runtimeRootForWorkstream } from '../../src/core/paths.ts';
import { renderAutopilotPrompt, renderRestartPrompt } from '../../src/core/prompts.ts';

function parsedWorkstream(args: string): string {
  const parsed = parseAutopilotArgs(args);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value.workstream;
}

function legacySurfacePattern(): RegExp {
  return /legacy-agent-run|\.pi\/legacy-runtime/u;
}

void describe('Autopilot command parsing and prompts', () => {
  void it('parses a workstream and remaining operator text', () => {
    const parsed = parseAutopilotArgs('demo-workstream launch phase one');
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error(parsed.message);
    assert.equal(parsed.value.workstream, 'demo-workstream');
    assert.equal(parsed.value.remainder, 'launch phase one');
  });

  void it('rejects missing and invalid workstreams', () => {
    assert.equal(parseAutopilotArgs('').ok, false);
    assert.equal(parseAutopilotArgs('-bad').ok, false);
    assert.equal(parseAutopilotArgs('../bad').ok, false);
  });

  void it('builds the project runtime root', () => {
    assert.equal(parsedWorkstream('demo'), 'demo');
    assert.equal(runtimeRootForWorkstream('demo'), '.pi/autopilot/demo');
  });

  void it('renders parent prompt with required Autopilot surfaces and no child-only tool exposure', () => {
    const prompt = renderAutopilotPrompt({
      workstream: 'demo',
      runtimeRoot: '.pi/autopilot/demo',
      runnerInvocation: '/pkg/bin/autopilot-agent-run.mjs',
      taskIntro: 'focus text',
    });
    assert.match(prompt, new RegExp(CONTEXT_BUDGET_TOOL_NAME));
    assert.match(prompt, /\.pi\/autopilot\/demo/);
    assert.match(prompt, /\/pkg\/bin\/autopilot-agent-run\.mjs <unit-spec\.json>/);
    assert.match(prompt, /resume from `\.pi\/autopilot\/demo\/state\.json`/);
    assert.match(prompt, /markdown as authoritative truth/);
    assert.match(prompt, /only through the exact injected invocation/);
    assert.match(prompt, /status artifact and receipt artifact/);
    assert.match(prompt, /raw Pi commands/);
    assert.match(prompt, /mutate git state/);
    assert.match(prompt, /metered frontier routes/);
    assert.match(prompt, /autopilot\.status\.v1/);
    assert.equal(new RegExp(AUTOPILOT_STATUS_TOOL).test(prompt), false);
    assert.equal(legacySurfacePattern().test(prompt), false);
    assert.match(prompt, /focus text/);
  });

  void it('renders restart prompt as read-only instructions', () => {
    const prompt = renderRestartPrompt({
      workstream: 'demo',
      runtimeRoot: '.pi/autopilot/demo',
      notes: 'handoff refs',
    });
    assert.match(prompt, new RegExp(`/${AUTOPILOT_COMMAND} demo`));
    assert.match(prompt, /Do not start child agents/);
    assert.match(prompt, /Do not create, edit, move, delete/);
    assert.match(prompt, /read-only/);
    assert.match(prompt, /state\.json/);
    assert.match(prompt, /events\.jsonl/);
    assert.match(prompt, /validated status\+receipt evidence/);
    assert.match(prompt, new RegExp(AUTOPILOT_RUNNER_BIN));
    assert.equal(legacySurfacePattern().test(prompt), false);
    assert.equal(new RegExp(AUTOPILOT_STATUS_TOOL).test(prompt), false);
  });
});
