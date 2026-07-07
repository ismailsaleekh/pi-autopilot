# Autopilot

Autopilot is a Pi extension package for dependency-cleared child-agent orchestration. It provides the `/autopilot` parent prompt, `/autopilot-inject` session-binding refresh command, `/autopilot-onboard` onboarding prompt, `/autopilot-handoff` context handoff prompt, `/autopilot-config` parallel scheduler config, `/autopilot-claim-gc` stale-claim proof/cleanup, deterministic `/autopilot-close` runtime landing, deterministic `/autopilot-abort` runtime archival, the parent `context_budget` gate, Autopilot contracts/templates, Quality vNext spec/status gates, durable purpose state, per-unit worktrees, execution audits, scope/protected-path adjudication helpers, work-item lifecycle/closure gates, forced-output/status handling, state-store helpers, and the `autopilot-agent-run` child runner.

## Install

```bash
pi install npm:pi-autopilot
# or during local development
pi install .
```

## Commands

- `/autopilot <workstream> [task intro/current focus]` starts or resumes an Autopilot parent session. The rendered parent prompt requires `context_budget` before reading project files, runtime state, or launching child work. A successful activation records the current workstream for later `/autopilot-handoff` in the same session.
- `/autopilot-inject <workstream>` refreshes the current Pi session's Autopilot binding for an existing or newly prepared workstream without queueing the parent prompt. Use it after resuming a Pi session when `/autopilot-handoff` needs the active workstream restored. It activates `context_budget` and records the active workstream/run, but does not launch children, mutate source files, run tests, call providers, or write handoff artifacts.
- `/autopilot-onboard <workstream> [handoff refs/notes]` generates a paste-ready `/autopilot <workstream>` onboarding block from supplied handoff refs or notes. It is read-only and must not launch children, mutate files, run tests, or call providers.
- `/autopilot-handoff [optional comments]` asks the active Autopilot parent to stop launching new work, write/update compact handoff artifacts under the current workstream runtime root, and finish with a full `/autopilot <workstream>` resume block. The workstream is taken from the active `/autopilot` or `/autopilot-inject` session; operators do not pass it to the handoff command.
- `/autopilot-config show` prints the active workstream scheduler config; `/autopilot-config parallel-cap <n>` persists `parallel_cap` in the range `1..32` under `.pi/autopilot/<workstream>/scheduler-config.json` (default `8`).
- `/autopilot-close <workstream> [--run <workstream_run>] [--dry-run]` runs the package-owned close/merge lifecycle. It validates closure evidence, Phase 2 unit merge evidence, execution commit evidence, target-branch cleanliness, foreign/manual target changes, validation staleness, and source/worktree cleanliness before locally fast-forwarding the captured target branch. It releases retained claims, writes merge/ack/close evidence, archives runtime artifacts, removes the worktree, and retires the branch only after a successful local merge. It does not fetch, push, create PRs, call providers, or let the parent/model mutate the operator source checkout or remotes.
- `/autopilot-abort <workstream> [--run <workstream_run>] [--dry-run]` archives an abandoned clean workstream without merging. It refuses dirty source paths, releases retained claims, archives runtime artifacts, removes the worktree, and retires the branch to an aborted archive ref so stale runs do not keep path ownership forever.
- `/autopilot-claim-gc --dry-run|--apply` performs evidence-backed stale claim garbage collection. Dry-run writes proof without mutation; apply releases only claims proven stale by closed/crashed parents or terminal unit attempt metadata.

All commands use package-owned prompt sources and Autopilot names only.

## Tools and runtime surfaces

- `context_budget` is the parent-session tool activated by `/autopilot`; it reports `ok`, `halt`, or `unknown` using the default 85% halt threshold unless configured otherwise.
- `autopilot_emit_status` is an internal child-only status tool made available by `autopilot-agent-run`; it is not registered as a parent-session command or normal parent tool.

Autopilot activation creates an isolated package-owned git main worktree per workstream under:

```text
~/.pi/agent/autopilot/worktrees/<repo-key>/active/<workstream-run>/main/
```

Runtime files live inside that main worktree under:

```text
.pi/autopilot/<workstream>/
```

Source-changing implement/fix units run in deterministic per-unit worktrees under `~/.pi/agent/autopilot/worktrees/<repo-key>/active/<workstream-run>/units/<unit-id>/attempt-<n>/worktree/`; their authoritative status, receipt, evidence, audit, execution-commit, unit-merge, validation-staleness, and scheduler artifacts still live under the main runtime root above. Coordination state lives under `~/.pi/agent/autopilot/coordination/<repo-key>/` (`active-autopilots.json`, `path-claims.json`, `claim-events.jsonl`, `merge-log.jsonl`, `foreign-merge-acks.jsonl`, claim-GC evidence, and locks). Autopilot validates and writes package-owned artifact paths for `mission.md`, `master-plan.json`, `decision-log.jsonl`, `unit-specs/`, `statuses/`, `receipts/`, `execution-audits/`, `execution-commits/`, `unit-merges/`, `validation-staleness/`, `rendered-prompts/`, `evidence/`, `state.json`, `events.jsonl`, `scheduler-config.json`, close evidence, and handoff files. Unit specs require status, receipt, and evidence outputs to stay inside the matching workstream runtime root, and non-strategy child specs must reference durable mission/master-plan context before launch. Handoff prompts target `handoff.json`, `handoff.md`, and `handoff-event-tail.jsonl` in the active workstream root. The strict `autopilot.handoff.v1` shape carries mission, master-plan, decision-tail/latest-decision, state/event-tail, status, and execution-audit refs so next sessions recover purpose before queues.

## Contracts, templates, and state-store

The package ships schema-backed Autopilot contracts for unit specs, status entries, events, state, receipts, handoffs, `autopilot.master_plan.v1`, `autopilot.decision.v1`, `autopilot.execution_audit.v1`, and `autopilot.execution_commit.v1`. Unit specs also carry Quality vNext fields for quality profile, risk level, acceptance criteria, verification plan, closure criteria, and upstream refs. Semantic validation covers role/verdict coherence, owned-path status changes, fake-green command rejection, declared-command and witness coverage, evidence metadata, receipt hashes, provider identity, output freshness, runtime-root placement, durable planning refs, purpose-state coherence, and execution-audit fact/classification coherence.

Role templates and deterministic render helpers cover strategy, implement, validate, fix, adjudicate, bughunt, and extract units. Parent and child prompts include the package-owned perfect-quality contract: no band-aids, hacks, silent fallbacks, fake-green tests, fixture tampering, deferred consumers, or source-changing self-certification. State/lifecycle helpers keep source-changing work in `transport-complete`, `audit-review`, or `validation-ready` until execution audits are clean/adjudicated and each source-changing work item has its own referenced independent validation PASS; closure gates reject unresolved scope/protected-path exceptions, missing per-work-item validation, and missing final bughunt proof for high-risk or multi-lane work. The state-store helpers write `state.json` atomically, append `events.jsonl` monotonically, validate runtime references, and resume from bounded event tails under `.pi/autopilot/<workstream>/`.

## Runner and CLI

`autopilot-agent-run` is the child runner CLI:

```bash
autopilot-agent-run [--dry-run] [--json] [--pi-executable <path>] <unit-spec.json>
```

The published bin launches compiled JavaScript under `dist/src/cli/autopilot-agent-run.js`; it does not execute TypeScript source from `node_modules` or rely on Node type stripping. The runner reads and validates an Autopilot unit spec, applies the deterministic Quality vNext spec gate before model spend, creates/resumes the deterministic per-unit worktree for source-changing implement/fix specs, verifies that `cwd` is inside the registered Autopilot unit worktree, verifies a clean source baseline, acquires path claims for owned/read-only paths, builds the forced-output/status context against the authoritative main runtime root, renders the child prompt, optionally snapshots it, preflights stale status/receipt paths, and either dry-runs or launches Pi in RPC mode with the internal compiled status tool and worktree guard. Parent and child sessions may use local git inside registered Autopilot worktrees, including staging, commits, resets, restores, checkouts, cleanups, and rebases, but the guard rejects git whose effective cwd/work-tree is outside the active worktree plus explicit git remapping, remote/external subcommands, and shared branch/tag mutation. On completion the runner accepts matching status artifacts, receipt artifacts, and receipt-matching structured tool carriers, then writes an `autopilot.execution_audit.v1` record under `execution-audits/` and revalidates success statuses against the audit before transport acceptance; assistant text alone is rejected. Execution audits include committed-path deltas when a child creates in-worktree commits, and `autopilot.execution_commit.v1` evidence captures either runtime-created commits, child-created commits, or mixed child+runtime ranges on the unit branch. Stable failure classes distinguish invalid specs, Pi launch/runtime failures, missing structured output, invalid structured output, and non-success status verdicts, while runner output includes audit path/classification for parent semantic routing. Dirty baselines are attribution blockers only when they overlap unit-owned or protected surfaces; unrelated dirty paths are recorded as audit caveats instead of forcing a globally clean tree.

Autopilot accepts subscription Pi model routes only for `openai-codex/*`, `anthropic/*`, `opencode-go/*`, `kimi-coding/*`, and `zai/*`. Other provider prefixes are rejected before child launch to avoid accidental metered frontier routes.

## Close / merge lifecycle

`/autopilot-close` is deterministic runtime code, not a model prompt. It is local-only: no fetch, push, network, or PR creation. The close runtime requires the operator source checkout to be clean and on the captured target branch, blocks child launches by moving the run to `merging`, verifies that source-changing work has schema-valid state/master-plan/status/audit evidence plus independent validation, verifies that the final integrated diff equals the union of accepted `autopilot.unit_merge.v1` changed paths for Phase 2 work, rejects remaining validation-staleness artifacts, blocks on foreign/manual target path intersections, merges the target branch into the workstream branch, fast-forwards the target branch, appends `autopilot.merge_event.v1` and `autopilot.foreign_merge_ack.v1` rows, releases retained claims, archives runtime evidence under `~/.pi/agent/autopilot/worktrees/<repo-key>/_archive/<workstream-run>/`, removes the worktree, and retires the branch to `autopilot/archive/<workstream-run>/main`. `/autopilot-abort` uses the same runtime-owned archival/claim-release machinery without merging and retires the branch to `autopilot/archive/<workstream-run>/aborted`. Worktree-local git freedom does not bypass close: final changed paths still require unit-merge evidence, execution-audit evidence, execution-commit evidence, and independent validation.

Default automated coverage is offline and no-spend: unit tests use fake Pi processes for runner scenarios including worktree registration, per-unit worktrees, same-parent claims, scheduler cap/skip logic, runtime-owned unit mergeback, validation staleness, claim GC, worktree-scoped git guards, execution audits, child-created commits, and execution-commit evidence; e2e smoke tests exercise the fake-Pi status/receipt/state path in an isolated Autopilot worktree; SDK tests load the extension in isolated Pi sessions; RPC tests use offline `pi --mode rpc`; package tests inspect manifest/docs/bin/payload; and `pack:dry-run` verifies the published files.

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

Autopilot currently supplies the package extension, commands, `context_budget`, scheduler config, deterministic dispatch planning helpers, contracts/templates, Quality vNext spec/status gates, durable purpose state helpers, per-unit worktrees, runtime-owned unit mergeback, validation-staleness tracking, claim GC, execution-audit generation/validation, scope/protected-path adjudication helpers, work-item lifecycle and terminal closure gates, runtime close/merge/abort, forced-output/status tool, state-store helpers, runner CLI/bin, fake-Pi and e2e witnesses, parent prompt, onboard prompt, handoff prompt, and offline SDK/RPC/package gates. It does not include a compiled scheduler UI, PTY/TUI coverage, migration tooling for older runtime folders, default automated live-provider execution, network push/PR creation, or hosted PR automation. Provider-backed child runs require explicit operator approval, subscription Pi channels, and the `autopilot-agent-run` path; the default package gate remains deterministic, offline, network-free, and isolated from user/global Pi state.
