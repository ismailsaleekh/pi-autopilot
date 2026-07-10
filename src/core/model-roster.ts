import {
  AUTOPILOT_ROLE_VALUES,
  type AutopilotRole,
  type AutopilotThinking,
  type AutopilotUnitSpec,
} from './contracts/types.ts';

export interface AutopilotModelAssignment {
  readonly model: string;
  readonly thinking: AutopilotThinking;
}

function fixedAssignment(model: string, thinking: AutopilotThinking): AutopilotModelAssignment {
  return Object.freeze({ model, thinking });
}

export const AUTOPILOT_PARENT_MODEL_ASSIGNMENT = fixedAssignment(
  'openai-codex/gpt-5.6-sol',
  'xhigh',
);

export const AUTOPILOT_ROLE_MODEL_ROSTER: Readonly<Record<AutopilotRole, AutopilotModelAssignment>> =
  Object.freeze({
    strategy: fixedAssignment('openai-codex/gpt-5.6-sol', 'xhigh'),
    implement: fixedAssignment('openai-codex/gpt-5.6-terra', 'high'),
    validate: fixedAssignment('openai-codex/gpt-5.6-sol', 'xhigh'),
    fix: fixedAssignment('openai-codex/gpt-5.6-terra', 'high'),
    adjudicate: fixedAssignment('openai-codex/gpt-5.6-sol', 'xhigh'),
    bughunt: fixedAssignment('openai-codex/gpt-5.6-sol', 'xhigh'),
    extract: fixedAssignment('openai-codex/gpt-5.6-luna', 'high'),
  });

export function autopilotModelAssignmentForRole(role: AutopilotRole): AutopilotModelAssignment {
  return AUTOPILOT_ROLE_MODEL_ROSTER[role];
}

export function autopilotModelRosterIssues(
  spec: Pick<AutopilotUnitSpec, 'role' | 'model' | 'thinking'>,
): readonly string[] {
  const expected = autopilotModelAssignmentForRole(spec.role);
  const issues: string[] = [];
  if (spec.model !== expected.model) {
    issues.push(
      `${spec.role} role requires fixed roster model ${expected.model}; received ${spec.model}`,
    );
  }
  if (spec.thinking !== expected.thinking) {
    issues.push(
      `${spec.role} role requires fixed roster thinking ${expected.thinking}; received ${spec.thinking}`,
    );
  }
  return Object.freeze(issues);
}

export function renderAutopilotModelRoster(): string {
  return [
    `- parent/orchestrator: ${AUTOPILOT_PARENT_MODEL_ASSIGNMENT.model} at ${AUTOPILOT_PARENT_MODEL_ASSIGNMENT.thinking}`,
    ...AUTOPILOT_ROLE_VALUES.map((role) => {
      const assignment = autopilotModelAssignmentForRole(role);
      return `- ${role}: ${assignment.model} at ${assignment.thinking}`;
    }),
  ].join('\n');
}
