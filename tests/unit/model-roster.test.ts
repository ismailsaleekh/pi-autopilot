import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AUTOPILOT_ROLE_VALUES, type AutopilotRole } from '../../src/core/contracts/types.ts';
import {
  AUTOPILOT_PARENT_MODEL_ASSIGNMENT,
  AUTOPILOT_ROLE_MODEL_ROSTER,
  autopilotModelAssignmentForRole,
  autopilotModelRosterIssues,
  renderAutopilotModelRoster,
} from '../../src/core/model-roster.ts';

const EXPECTED_ROSTER: Readonly<
  Record<AutopilotRole, { readonly model: string; readonly thinking: 'high' | 'xhigh' }>
> = {
  strategy: { model: 'openai-codex/gpt-5.6-sol', thinking: 'xhigh' },
  implement: { model: 'openai-codex/gpt-5.6-terra', thinking: 'high' },
  validate: { model: 'openai-codex/gpt-5.6-sol', thinking: 'xhigh' },
  fix: { model: 'openai-codex/gpt-5.6-terra', thinking: 'high' },
  adjudicate: { model: 'openai-codex/gpt-5.6-sol', thinking: 'xhigh' },
  bughunt: { model: 'openai-codex/gpt-5.6-sol', thinking: 'xhigh' },
  extract: { model: 'openai-codex/gpt-5.6-luna', thinking: 'high' },
};

void describe('Autopilot fixed model roster', () => {
  void it('assigns every child role and the parent deterministically', () => {
    assert.deepEqual(AUTOPILOT_PARENT_MODEL_ASSIGNMENT, {
      model: 'openai-codex/gpt-5.6-sol',
      thinking: 'xhigh',
    });
    assert.deepEqual(AUTOPILOT_ROLE_MODEL_ROSTER, EXPECTED_ROSTER);
    for (const role of AUTOPILOT_ROLE_VALUES) {
      assert.deepEqual(autopilotModelAssignmentForRole(role), EXPECTED_ROSTER[role]);
    }
  });

  void it('rejects both model and thinking deviations without fallback', () => {
    assert.deepEqual(
      autopilotModelRosterIssues({
        role: 'implement',
        model: 'openai-codex/gpt-5.6-sol',
        thinking: 'xhigh',
      }),
      [
        'implement role requires fixed roster model openai-codex/gpt-5.6-terra; received openai-codex/gpt-5.6-sol',
        'implement role requires fixed roster thinking high; received xhigh',
      ],
    );
    assert.deepEqual(
      autopilotModelRosterIssues({
        role: 'validate',
        model: 'openai-codex/gpt-5.6-sol',
        thinking: 'xhigh',
      }),
      [],
    );
  });

  void it('renders the complete roster for parent prompt injection', () => {
    const rendered = renderAutopilotModelRoster();
    assert.match(rendered, /parent\/orchestrator: openai-codex\/gpt-5\.6-sol at xhigh/u);
    for (const role of AUTOPILOT_ROLE_VALUES) {
      const assignment = EXPECTED_ROSTER[role];
      assert.equal(rendered.includes(`- ${role}: ${assignment.model} at ${assignment.thinking}`), true);
    }
  });
});
