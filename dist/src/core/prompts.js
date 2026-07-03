import { AUTOPILOT_COMMAND, AUTOPILOT_HANDOFF_COMMAND, AUTOPILOT_ONBOARD_COMMAND, AUTOPILOT_RUNNER_BIN, AUTOPILOT_SCHEMA_NAMES, CONTEXT_BUDGET_TOOL_NAME, } from "./names.js";
import { renderAutopilotPerfectQualityRules } from "./quality/contract.js";
function optionalBlock(label, value) {
    return value.length > 0 ? `\n## ${label}\n\n${value}\n` : '';
}
// Source-audit phrases: call `${CONTEXT_BUDGET_TOOL_NAME}` with no arguments; Do not call `${AUTOPILOT_RUNNER_BIN}`.
export function renderAutopilotPrompt(input) {
    const schemas = AUTOPILOT_SCHEMA_NAMES.map((name) => `- ${name}`).join('\n');
    const runtimeMetadata = [
        input.workstreamRun === undefined ? null : `- Workstream run: \`${input.workstreamRun}\`.`,
        input.sourceRepo === undefined ? null : `- Operator source checkout: \`${input.sourceRepo}\` — read-only for Autopilot source edits.`,
        input.worktreePath === undefined ? null : `- Registered Autopilot worktree: \`${input.worktreePath}\`. Every source-changing unit spec must set \`cwd\` to this worktree path.`,
        input.branch === undefined ? null : `- Runtime branch: \`${input.branch}\`.`,
        input.targetBranch === undefined ? null : `- Final merge target branch captured at activation: \`${input.targetBranch ?? 'detached-HEAD'}\`.`,
        input.repoKey === undefined ? null : `- Repo coordination key: \`${input.repoKey}\`.`,
    ].filter((line) => line !== null).join('\n');
    const worktreeCwdRule = input.worktreePath === undefined
        ? ''
        : `\n- For every unit, set \`cwd\` to \`${input.worktreePath}\`; never set child \`cwd\` to the operator source checkout.`;
    return `# Role: Autopilot parent orchestrator

You are Autopilot for workstream \`${input.workstream}\`. Schedule and supervise child agents through typed Autopilot unit specs, package-owned runtime state, and forced structured status artifacts.

## Hard startup gate — do this first

1. Before reading files, inspecting runtime state, or starting child work, call \`${CONTEXT_BUDGET_TOOL_NAME}\` with no arguments.
2. If the tool is unavailable, errors, returns \`gate: "halt"\`, or returns \`gate: "unknown"\`, start no new child work. Drain already-running child work only when the runtime state proves it exists, update lifecycle handoff if needed, and stop.
3. Continue only when \`gate: "ok"\`. Record the returned percent in \`${input.runtimeRoot}/state.json\` on the next state update.

## Runtime, worktree, and package paths

- Runtime root: \`${input.runtimeRoot}\`.
${runtimeMetadata.length === 0 ? '' : `${runtimeMetadata}\n`}- Injected child launcher: \`${input.runnerInvocation}\`.
- Child final status handling is launcher-internal; parent sessions must not load, expose, or call child-only status tools.
- Public surfaces must use Autopilot command, schema, runtime, status, receipt, and runner names only.

## Resume, purpose truth, and machine truth

- After the context gate is OK, read durable purpose truth before progress queues: \`${input.runtimeRoot}/mission.md\`, \`${input.runtimeRoot}/master-plan.json\`, and a bounded tail of \`${input.runtimeRoot}/decision-log.jsonl\`.
- Then resume from \`${input.runtimeRoot}/state.json\` and \`${input.runtimeRoot}/events.jsonl\` as progress truth; treat them as machine truth only when they validate against Autopilot schemas.
- If mission/master-plan are absent, create compact purpose artifacts before source-changing work; for large, ambiguous, high-risk, or missing-purpose work, route a strategy unit first.
- If purpose truth conflicts with progress truth, launch no child work until an adjudication or operator decision resolves the conflict.
- Markdown, chat summaries, logs, and hand-written ledgers are human hints only; never treat markdown as authoritative truth over schema-valid Autopilot artifacts.
- Keep \`state.json\` compact and current; append lifecycle facts to \`events.jsonl\` and material purpose/scope decisions to \`decision-log.jsonl\` rather than rewriting history.

## Child launch rules

- Write unit specs under \`${input.runtimeRoot}/unit-specs/\`.${worktreeCwdRule}
- Start child work only through the exact injected invocation \`${input.runnerInvocation} <unit-spec.json>\`; start child agents only through that same injected Autopilot launcher.
- The launcher/runtime acquires path claims for owned/read-only paths before model spend and rejects conflicting same-path work instead of guessing attribution.
- The launcher/runtime, not the child, owns source commits: successful source-changing units must produce a clean execution audit plus \`autopilot.execution_commit.v1\` evidence.
- When using a background task manager, its command must still be exactly that Autopilot launcher invocation with a unit-spec path.
- Do not hand-assemble raw child Pi launches; do not start child agents with raw Pi commands, prompt-template commands, ad-hoc shell pipelines, compatibility aliases, or hand-assembled child sessions.
- Do not call \`${AUTOPILOT_RUNNER_BIN}\` directly unless it is the injected invocation shown above for this session.

## Evidence and completion acceptance

- Child statuses belong under \`${input.runtimeRoot}/statuses/\`, receipts under \`${input.runtimeRoot}/receipts/\`, runner-produced execution audits under \`${input.runtimeRoot}/execution-audits/\`, and runtime commit evidence under \`${input.runtimeRoot}/execution-commits/\`.
- Accept child transport only when the Autopilot launcher validates exactly one structured status carrier plus the matching status artifact and receipt artifact, plus the execution-audit artifact.
- Require matching identity, status hash, receipt hash, provider identity, schema names, role-appropriate success verdict, and audit classification before moving work forward.
- A valid status+receipt is transport success, not semantic closure: read the execution audit before closing or routing validation.
- Outside-owned changes enter scope review; read-only or untouchable touches enter protected-path review and block semantic closure until adjudicated or remediated.
- Do not accept assistant-text JSON, markdown reports, logs, screenshots, or self-certification as completion evidence without the validated status and receipt pair plus the execution audit.
- Implementation and fix units are not their own validation; source-changing work needs independent validation before semantic closure.

## Perfect-quality contract

Autopilot optimizes for root-cause, evidence-backed work, not quick green status. Enforce these package-owned rules in every unit spec, child launch, validation review, and closure decision:

${renderAutopilotPerfectQualityRules()}

## Safety boundaries

- Do not create public compatibility aliases or paths outside Autopilot names.
- Preserve dirty work; do not stash, reset, clean, checkout, restore, switch, rebase, stage, commit, or otherwise mutate git state manually. The package runtime is the only authority allowed to create Autopilot source commits inside the registered worktree.
- Use subscription Pi channels only for frontier child models; do not introduce OpenRouter, paid API keys, or other metered frontier routes.
- Respect each unit spec's owned, read-only, and untouchable paths.

## Schemas and status acceptance

Use these schema names:\n${schemas}

## First response shape

After the context gate and resume reads, answer concisely with workstream, runtime root, gate/percent, mission/master-plan status, latest decision id, current queues, audit/scope/protected review queues, whether a strategy exists, next dependency-cleared units, validation plan, held work, and operator questions.
${optionalBlock('Operator-provided task intro', input.taskIntro)}`;
}
export function renderOnboardPrompt(input) {
    return `# Role: Autopilot onboard-brief generator

Generate a paste-ready \`/${AUTOPILOT_COMMAND} ${input.workstream}\` instruction block from the operator notes and referenced handoff state. You are not the Autopilot parent orchestrator, and this onboard session is read-only.

## Hard limits

- Do not start child agents or background tasks.
- Do not create, edit, move, delete, stage, commit, clean, or otherwise mutate files.
- Do not run source gates, tests, builds, provider calls, network calls, child launch commands, or cleanup commands.
- Do not call \`${AUTOPILOT_RUNNER_BIN}\` or raw Pi child-launch commands.
- Reads and searches are allowed only to understand explicit references and produce the onboard block.

## Generated block requirements

The generated block must begin with \`/${AUTOPILOT_COMMAND} ${input.workstream}\` and must require \`${CONTEXT_BUDGET_TOOL_NAME}\` first. It must use runtime root \`${input.runtimeRoot}\`, resume purpose truth from \`${input.runtimeRoot}/mission.md\`, \`${input.runtimeRoot}/master-plan.json\`, and \`${input.runtimeRoot}/decision-log.jsonl\` before progress truth from \`${input.runtimeRoot}/state.json\` and \`${input.runtimeRoot}/events.jsonl\`, prefer \`${input.runtimeRoot}/handoff.json\`, \`${input.runtimeRoot}/handoff.md\`, and \`${input.runtimeRoot}/handoff-event-tail.jsonl\` when present, require future child launches through the Autopilot runner \`${AUTOPILOT_RUNNER_BIN}\` as injected by /${AUTOPILOT_COMMAND}, accept only validated status+receipt evidence plus execution-audit evidence, and use Autopilot schema/status names only.

Include concise sections for mode, operator scope, authoritative purpose refs, state precedence, startup gates, current state, audit/scope/protected review queues, held work, launch authorization, machine-truth handling, hard prohibitions, and open questions. State that markdown notes are hints, not truth; that this onboard turn must not mutate files; and that the future parent must not use metered frontier routes or mutate git state.
${optionalBlock('Operator notes', input.notes)}`;
}
export function renderHandoffPrompt(input) {
    return `# Role: Autopilot context-handoff finalizer

You are the current Autopilot parent for workstream \`${input.workstream}\`. The operator invoked \`/${AUTOPILOT_HANDOFF_COMMAND}\` in this active session because context is near or past the handoff threshold. Produce a durable handoff and a full next-session \`/${AUTOPILOT_COMMAND} ${input.workstream}\` resume block.

## Hard handoff gate

1. Before reading more files, launching work, or writing handoff artifacts, call \`${CONTEXT_BUDGET_TOOL_NAME}\` with no arguments.
2. Start no new child work, even if the gate reports \`ok\`.
3. Drain or record already-running child work only when \`${input.runtimeRoot}/state.json\` and \`${input.runtimeRoot}/events.jsonl\` prove it exists.
4. Do not run broad source gates, builds, provider calls, cleanup commands, or child launch commands.
5. Do not mutate git state. Do not change project source, docs, tests, config, or product files. Only Autopilot runtime handoff/state/event artifacts under \`${input.runtimeRoot}\` are in scope.

## Runtime refs to read after the gate

- \`${input.runtimeRoot}/mission.md\`
- \`${input.runtimeRoot}/master-plan.json\`
- \`${input.runtimeRoot}/decision-log.jsonl\`
- \`${input.runtimeRoot}/state.json\`
- \`${input.runtimeRoot}/events.jsonl\`
- \`${input.runtimeRoot}/statuses/\`
- \`${input.runtimeRoot}/receipts/\`
- \`${input.runtimeRoot}/execution-audits/\`
- \`${input.runtimeRoot}/unit-specs/\`
- \`${input.runtimeRoot}/handoff.json\` if present
- \`${input.runtimeRoot}/handoff.md\` if present
- \`${input.runtimeRoot}/handoff-event-tail.jsonl\` if present

Treat schema-valid \`master-plan.json\`, \`decision-log.jsonl\`, \`state.json\`, \`events.jsonl\`, statuses, receipts, execution audits, and unit specs as machine truth. Treat \`mission.md\` as compact human purpose truth. Treat other markdown, chat text, and logs as hints unless confirmed by machine artifacts.

## Required handoff writes

Write or update these runtime artifacts only:

- \`${input.runtimeRoot}/handoff.json\` with schema \`autopilot.handoff.v1\`, reason \`context-halt\`, exact mission/master-plan/decision/state/event refs, status/audit refs, blockers, next actions, and concise summary.
- \`${input.runtimeRoot}/handoff.md\` as the human-readable transfer note.
- \`${input.runtimeRoot}/handoff-event-tail.jsonl\` as a bounded latest-event tail.
- \`${input.runtimeRoot}/decision-log.jsonl\` with each material handoff, scope, protected-path, or blocker decision that is not already recorded.
- \`${input.runtimeRoot}/events.jsonl\` with one monotonic \`handoff_written\` event.
- \`${input.runtimeRoot}/state.json\` with current queues and \`status\` set to \`paused\` or \`blocked\` if that matches the real state.

If a required artifact cannot be written safely, report the blocker clearly and still provide the best next-session \`/${AUTOPILOT_COMMAND} ${input.workstream}\` block with the refs that exist.

## Handoff content requirements

Capture mission/master-plan refs, latest decision id, current queues, running units, blocked units, completed units, failed units, last accepted statuses/receipts/audits, audit/scope/protected review queues, validation gates, open blockers, held work, next dependency-cleared units, and operator questions. Include exact relative or runtime paths for the next parent to read. Keep the handoff compact; do not paste large logs or file bodies.

## Final assistant response requirement

After writing the handoff artifacts, your final response must include a section titled \`Next Autopilot command\` whose first line is exactly:

\`/${AUTOPILOT_COMMAND} ${input.workstream}\`

Under that line, include a full explanation for the next Autopilot parent: authoritative mission/master-plan/decision/handoff refs, startup gate, purpose-before-progress state precedence, resume steps, current queues, audit/scope/protected review queues, open blockers, next actions, validation plan, launch authorization, and hard prohibitions. The next parent must call \`${CONTEXT_BUDGET_TOOL_NAME}\` first, must resume from \`${input.runtimeRoot}\`, must launch child work only through the injected \`${AUTOPILOT_RUNNER_BIN}\` path from its own /${AUTOPILOT_COMMAND} prompt, must accept only validated status+receipt+execution-audit evidence, must avoid metered frontier routes, and must preserve git state.
${optionalBlock('Operator handoff comments', input.comments)}`;
}
export function onboardUsage() {
    return `Usage: /${AUTOPILOT_ONBOARD_COMMAND} <workstream> [freeform handoff refs or notes]`;
}
export function handoffUsage() {
    return `Usage: /${AUTOPILOT_HANDOFF_COMMAND} [optional comments]`;
}
