# Autopilot

Autopilot is a Pi extension package for dependency-cleared child-agent orchestration. It provides the `/autopilot` parent prompt, `/autopilot-onboard` onboarding prompt, `/autopilot-handoff` context handoff prompt, the parent `context_budget` gate, Autopilot contracts/templates, Quality vNext spec/status gates, durable purpose state, execution audits, forced-output/status handling, state-store helpers, and the `autopilot-agent-run` child runner.

## Install

```bash
pi install npm:pi-autopilot
# or during local development
pi install .
```

## Commands

- `/autopilot <workstream> [task intro/current focus]` starts or resumes an Autopilot parent session. The rendered parent prompt requires `context_budget` before reading project files, runtime state, or launching child work. A successful activation records the current workstream for later `/autopilot-handoff` in the same session.
- `/autopilot-onboard <workstream> [handoff refs/notes]` generates a paste-ready `/autopilot <workstream>` onboarding block from supplied handoff refs or notes. It is read-only and must not launch children, mutate files, run tests, or call providers.
- `/autopilot-handoff [optional comments]` asks the active Autopilot parent to stop launching new work, write/update compact handoff artifacts under the current workstream runtime root, and finish with a full `/autopilot <workstream>` resume block. The workstream is taken from the active `/autopilot` session; operators do not pass it to the handoff command.

All commands use package-owned prompt sources and Autopilot names only.

## Tools and runtime surfaces

- `context_budget` is the parent-session tool activated by `/autopilot`; it reports `ok`, `halt`, or `unknown` using the default 85% halt threshold unless configured otherwise.
- `autopilot_emit_status` is an internal child-only status tool made available by `autopilot-agent-run`; it is not registered as a parent-session command or normal parent tool.

Runtime files live under:

```text
.pi/autopilot/<workstream>/
```

Autopilot validates and writes package-owned artifact paths for `mission.md`, `master-plan.json`, `decision-log.jsonl`, `unit-specs/`, `statuses/`, `receipts/`, `execution-audits/`, `rendered-prompts/`, `evidence/`, `state.json`, `events.jsonl`, and handoff files. Unit specs require status, receipt, and evidence outputs to stay inside the matching workstream runtime root, and non-strategy child specs must reference durable mission/master-plan context before launch. Handoff prompts target `handoff.json`, `handoff.md`, and `handoff-event-tail.jsonl` in the active workstream root.

## Contracts, templates, and state-store

The package ships schema-backed Autopilot contracts for unit specs, status entries, events, state, receipts, handoffs, `autopilot.master_plan.v1`, `autopilot.decision.v1`, and `autopilot.execution_audit.v1`. Unit specs also carry Quality vNext fields for quality profile, risk level, acceptance criteria, verification plan, closure criteria, and upstream refs. Semantic validation covers role/verdict coherence, owned-path status changes, fake-green command rejection, declared-command and witness coverage, evidence metadata, receipt hashes, provider identity, output freshness, runtime-root placement, durable planning refs, purpose-state coherence, and execution-audit fact/classification coherence.

Role templates and deterministic render helpers cover strategy, implement, validate, fix, adjudicate, bughunt, and extract units. Parent and child prompts include the package-owned perfect-quality contract: no band-aids, hacks, silent fallbacks, fake-green tests, fixture tampering, deferred consumers, or source-changing self-certification. The state-store helpers write `state.json` atomically, append `events.jsonl` monotonically, validate runtime references, and resume from bounded event tails under `.pi/autopilot/<workstream>/`.

## Runner and CLI

`autopilot-agent-run` is the child runner CLI:

```bash
autopilot-agent-run [--dry-run] [--json] [--pi-executable <path>] <unit-spec.json>
```

The published bin launches compiled JavaScript under `dist/src/cli/autopilot-agent-run.js`; it does not execute TypeScript source from `node_modules` or rely on Node type stripping. The runner reads and validates an Autopilot unit spec, applies the deterministic Quality vNext spec gate before model spend, builds the forced-output/status context, renders the child prompt, optionally snapshots it, preflights stale status/receipt paths, and either dry-runs or launches Pi in RPC mode with the internal compiled status tool. On completion it accepts matching status artifacts, receipt artifacts, and receipt-matching structured tool carriers, then writes an `autopilot.execution_audit.v1` record under `execution-audits/`; assistant text alone is rejected. Stable failure classes distinguish invalid specs, Pi launch/runtime failures, missing structured output, invalid structured output, and non-success status verdicts, while runner output includes audit path/classification for parent semantic routing.

Autopilot accepts subscription Pi model routes only for `openai-codex/*`, `anthropic/*`, `opencode-go/*`, `kimi-coding/*`, and `zai/*`. Other provider prefixes are rejected before child launch to avoid accidental metered frontier routes.

Default automated coverage is offline and no-spend: unit tests use fake Pi processes for runner scenarios, e2e smoke tests exercise the fake-Pi status/receipt/state path, SDK tests load the extension in isolated Pi sessions, RPC tests use offline `pi --mode rpc`, package tests inspect manifest/docs/bin/payload, and `pack:dry-run` verifies the published files.

## Development gate

```bash
npm run build
npm run typecheck
npm run test:package
npm run test
npm run pack:dry-run
```

Release QA also runs docs audits and forbidden legacy-runtime scans from this standalone repo.

## Known limitations

Autopilot currently supplies the package extension, commands, `context_budget`, contracts/templates, Quality vNext spec/status gates, durable purpose state helpers, execution-audit generation/validation, forced-output/status tool, state-store helpers, runner CLI/bin, fake-Pi and e2e witnesses, parent prompt, onboard prompt, handoff prompt, and offline SDK/RPC/package gates. It does not include a compiled scheduler UI, PTY/TUI coverage, migration of older runtime folders, full lifecycle/adjudication/terminal-closure automation, or default automated live-provider execution. Provider-backed child runs require explicit operator approval, subscription Pi channels, and the `autopilot-agent-run` path; the default package gate remains deterministic, offline, network-free, and isolated from user/global Pi state.
