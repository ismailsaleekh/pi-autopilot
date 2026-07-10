import { AUTOPILOT_ROLE_VALUES, } from "./contracts/types.js";
function fixedAssignment(model, thinking) {
    return Object.freeze({ model, thinking });
}
export const AUTOPILOT_PARENT_MODEL_ASSIGNMENT = fixedAssignment('openai-codex/gpt-5.6-sol', 'xhigh');
export const AUTOPILOT_ROLE_MODEL_ROSTER = Object.freeze({
    strategy: fixedAssignment('openai-codex/gpt-5.6-sol', 'xhigh'),
    implement: fixedAssignment('openai-codex/gpt-5.6-terra', 'high'),
    validate: fixedAssignment('openai-codex/gpt-5.6-sol', 'xhigh'),
    fix: fixedAssignment('openai-codex/gpt-5.6-terra', 'high'),
    adjudicate: fixedAssignment('openai-codex/gpt-5.6-sol', 'xhigh'),
    bughunt: fixedAssignment('openai-codex/gpt-5.6-sol', 'xhigh'),
    extract: fixedAssignment('openai-codex/gpt-5.6-luna', 'high'),
});
export function autopilotModelAssignmentForRole(role) {
    return AUTOPILOT_ROLE_MODEL_ROSTER[role];
}
export function autopilotModelRosterIssues(spec) {
    const expected = autopilotModelAssignmentForRole(spec.role);
    const issues = [];
    if (spec.model !== expected.model) {
        issues.push(`${spec.role} role requires fixed roster model ${expected.model}; received ${spec.model}`);
    }
    if (spec.thinking !== expected.thinking) {
        issues.push(`${spec.role} role requires fixed roster thinking ${expected.thinking}; received ${spec.thinking}`);
    }
    return Object.freeze(issues);
}
export function renderAutopilotModelRoster() {
    return [
        `- parent/orchestrator: ${AUTOPILOT_PARENT_MODEL_ASSIGNMENT.model} at ${AUTOPILOT_PARENT_MODEL_ASSIGNMENT.thinking}`,
        ...AUTOPILOT_ROLE_VALUES.map((role) => {
            const assignment = autopilotModelAssignmentForRole(role);
            return `- ${role}: ${assignment.model} at ${assignment.thinking}`;
        }),
    ].join('\n');
}
