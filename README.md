# Autopilot

Autopilot is a Pi extension package for dependency-cleared child-agent orchestration. It provides the `/autopilot` parent prompt, `/autopilot-restart` restart prompt, the parent `context_budget` gate, Autopilot contracts/templates, forced-output/status handling, state-store helpers, and the `autopilot-agent-run` child runner.

## Install

```bash
pi install npm:pi-autopilot
# or during local development
pi install ./packages/pi-autopilot
```

## Commands

- `/autopilot <workstream> [task intro/current focus]` starts or resumes an Autopilot parent session. The rendered parent prompt requires `context_budget` before reading project files, runtime state, or launching child work.
- `/autopilot-restart <workstream> [notes/refs]` generates a paste-ready restart/bootstrap block. It is read-only and must not launch children, mutate files, run tests, or call providers.

Both commands use package-owned prompt sources and Autopilot names only.

## Tools and runtime surfaces

- `context_budget` is the parent-session tool activated by `/autopilot`; it reports `ok`, `halt`, or `unknown` using the default 85% halt threshold unless configured otherwise.
- `autopilot_emit_status` is an internal child-only status tool made available by `autopilot-agent-run`; it is not registered as a parent-session command or normal parent tool.

Runtime files live under:

```text
.pi/autopilot/<workstream>/
```

Autopilot validates and writes package-owned artifact paths for `unit-specs/`, `statuses/`, `receipts/`, `rendered-prompts/`, `evidence/`, `state.json`, `events.jsonl`, and handoff files. Unit specs require status, receipt, and evidence outputs to stay inside the matching workstream runtime root.

## Contracts, templates, and state-store

The package ships schema-backed Autopilot contracts for unit specs, status entries, events, state, receipts, and handoffs. Semantic validation covers role/verdict coherence, owned-path status changes, evidence metadata, receipt hashes, provider identity, output freshness, and runtime-root placement.

Role templates and deterministic render helpers cover strategy, implement, validate, fix, adjudicate, bughunt, and extract units. The state-store helpers write `state.json` atomically, append `events.jsonl` monotonically, validate runtime references, and resume from bounded event tails under `.pi/autopilot/<workstream>/`.

## Runner and CLI

`autopilot-agent-run` is the child runner CLI:

```bash
autopilot-agent-run [--dry-run] [--json] [--pi-executable <path>] <unit-spec.json>
```

The runner reads and validates an Autopilot unit spec, builds the forced-output/status context, renders the child prompt, optionally snapshots it, preflights stale status/receipt paths, and either dry-runs or launches Pi in RPC mode with the internal status tool. On completion it accepts only a matching status artifact, receipt artifact, and structured tool carrier; assistant text alone is rejected. Stable failure classes distinguish invalid specs, Pi launch/runtime failures, missing structured output, invalid structured output, and non-success status verdicts.

Autopilot accepts subscription Pi model routes only for `openai-codex/*`, `anthropic/*`, `opencode-go/*`, `kimi-coding/*`, and `zai/*`. Other provider prefixes are rejected before child launch to avoid accidental metered frontier routes.

Default automated coverage is offline and no-spend: unit tests use fake Pi processes for runner scenarios, e2e smoke tests exercise the fake-Pi status/receipt/state path, SDK tests load the extension in isolated Pi sessions, RPC tests use offline `pi --mode rpc`, package tests inspect manifest/docs/bin/payload, and `pack:dry-run` verifies the published files.

## Development gate

```bash
npm --prefix packages/pi-autopilot run typecheck
npm --prefix packages/pi-autopilot run test:package
npm --prefix packages/pi-autopilot run test
npm --prefix packages/pi-autopilot run pack:dry-run
```

Release QA also runs docs audits and forbidden legacy-runtime scans supplied by the parent wrapper.

## Known limitations

Autopilot currently supplies the package extension, commands, `context_budget`, contracts/templates, forced-output/status tool, state-store helpers, runner CLI/bin, fake-Pi and e2e witnesses, parent prompt, restart prompt, and offline SDK/RPC/package gates. It does not include a compiled scheduler UI, PTY/TUI coverage, migration of older runtime folders, or default automated live-provider execution. Provider-backed child runs require explicit operator approval, subscription Pi channels, and the `autopilot-agent-run` path; the default package gate remains deterministic, offline, network-free, and isolated from user/global Pi state.
