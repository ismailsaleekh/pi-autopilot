# Autopilot

Autopilot is a standalone Pi extension package for dependency-cleared child-agent orchestration. It provides `/autopilot`, session binding/handoff, coordination diagnostics, scheduler configuration, deterministic close/abort, the parent `context_budget` gate, Quality vNext contracts, perfect-quality doctrine, scope/protected-path adjudication, work-item lifecycle, terminal closure, runtime close/merge/abort, forced-output/status, state-store, isolated per-unit worktrees, and execution audits, the `autopilot-agent-run` child runner, and the compiled `autopilot-coordinator` transactional local broker. Durable run supervisors and session fencing through explicit generations preserve run and child ownership across Pi session replacement.

## Install

```bash
pi install npm:pi-autopilot
# or during local development
pi install .
```

## Commands

- `/autopilot <workstream> [task intro/current focus]` starts or resumes an Autopilot parent session. The rendered parent prompt requires `context_budget` before reading project files, runtime state, or launching child work. A successful activation records the current workstream for later `/autopilot-handoff` in the same session.
- `/autopilot-inject <workstream>` refreshes the current Pi session's Autopilot binding for an existing or newly prepared workstream without queueing the parent prompt. Use it after resuming a Pi session when `/autopilot-handoff` needs the active workstream restored. It activates `context_budget` and records the active workstream/run, but does not launch children, mutate source files, run tests, call providers, or write handoff artifacts.
- `/autopilot-onboard <workstream> [handoff refs/notes]` is the read-only onboard prompt command and generates a paste-ready `/autopilot <workstream>` onboarding block from supplied handoff refs or notes. It is read-only and must not launch children, mutate files, run tests, or call providers.
- `/autopilot-handoff [optional comments]` renders the handoff prompt and asks the active Autopilot parent to stop launching new work, write/update compact handoff artifacts under the current workstream runtime root, and finish with a full `/autopilot <workstream>` resume block. The workstream is taken from the active `/autopilot` or `/autopilot-inject` session; operators do not pass it to the handoff command.
- `/autopilot-config show` prints the active workstream scheduler config; `/autopilot-config parallel-cap <n>` persists `parallel_cap` in the range `1..32` under `.pi/autopilot/<workstream>/scheduler-config.json` (default `8`).
- `/autopilot-close <workstream> [--run <workstream_run>] [--dry-run]` runs the package-owned close/merge lifecycle. It validates closure evidence, Phase 2 unit merge evidence, execution commit evidence, target-branch cleanliness, foreign/manual target changes, validation staleness, and source/worktree cleanliness before locally fast-forwarding the captured target branch. It releases retained claims, writes merge/ack/close evidence, archives runtime artifacts, removes only the run-owned terminal unit worktrees/main worktree/active task directory, prunes stale Git worktree metadata, verifies no run-owned path remains, and retires the branch only after a successful local merge. It does not fetch, push, create PRs, call providers, or let the parent/model mutate the operator source checkout or remotes.
- `/autopilot-abort <workstream> [--run <workstream_run>] [--dry-run]` archives an abandoned clean workstream without merging. It refuses dirty source paths, releases retained claims, archives runtime artifacts, performs the same run-owned worktree/task-directory/Git-metadata cleanup without landing changes, and retires the branch to an aborted archive ref so stale runs do not keep path ownership forever.
- `/autopilot-claim-gc --dry-run|--apply` performs evidence-backed legacy stale-claim diagnosis/repair. It is not the normal coordination path.
- `/autopilot-coordination status|doctor` queries the authenticated local coordinator without starting an LLM turn. Status reports durable runs, session/child leases, and mailbox counts; doctor reports database/schema integrity and expired-heartbeat recovery classifications without releasing WRITE authority.

All commands use package-owned prompt sources and Autopilot names only.

## Coordination Fabric Phases 27–29

The package ships strict Fabric contracts plus a real local transactional coordinator. `autopilot-coordinator` is a single-writer, authenticated, versioned, length-delimited IPC broker backed by package-owned SQLite in WAL mode. It enforces foreign keys, bounded contention, optimistic versions, idempotency keys, monotonic per-repository event sequences, startup/post-migration integrity checks, verified pre-migration backups, deterministic export, user-private capability/socket/database paths, crash restart, and loud protocol/schema/store failures with no JSON fallback.

`/autopilot` and `/autopilot-inject` attach one durable run supervisor per `workstream_run`, then attach a Pi session at a new fencing generation and drain its durable mailbox before prompt dispatch. The bridge starts only from activation, heartbeats while active, writes a private session-authority context, and detaches on session shutdown. Every attached session has an unguessable lease capability in addition to its generation, so PID reuse or possession of stale identity fields cannot impersonate current authority. `/autopilot-handoff` defers fencing until the handoff artifacts have been written and the session shuts down; the old generation then becomes `handoff-pending`, and the replacement attachment consumes that transition while preserving run/unit ownership. `autopilot-agent-run` must register a fenced child lease before model spend. The parent session capability is consumed only by the runner preflight and is scrubbed before Pi child spawn. That child receives independent, process-bound derived authority, so it can heartbeat and commit terminal or recovery-required state after a legitimate parent handoff without granting the old parent session any mutation authority. Heartbeat expiry is recovery evidence only and never releases WRITE authority.

Legacy JSON/JSONL coordination remains an explicit migration source until the later cutover phase. Its read-only canonical preflight still rejects malformed owners and incompatible claims, but old session epochs are diagnostic warnings: exact run/unit/attempt claims are durable and survive handoff. Package source, packed payload, fixtures, broker, and tests are standalone production surfaces that reject closed-repository dependencies. Default offline SDK/RPC/package gates use isolated temporary state roots and no provider or network call.

## Fixed model roster

Autopilot enforces one package-owned model/thinking assignment for every parent and child role:

| Role | Model | Thinking |
|---|---|---|
| Parent/orchestrator | `openai-codex/gpt-5.6-sol` | `xhigh` |
| Strategy | `openai-codex/gpt-5.6-sol` | `xhigh` |
| Implement | `openai-codex/gpt-5.6-terra` | `high` |
| Validate | `openai-codex/gpt-5.6-sol` | `xhigh` |
| Fix | `openai-codex/gpt-5.6-terra` | `high` |
| Adjudicate | `openai-codex/gpt-5.6-sol` | `xhigh` |
| Bughunt | `openai-codex/gpt-5.6-sol` | `xhigh` |
| Extract | `openai-codex/gpt-5.6-luna` | `high` |

`/autopilot` and `/autopilot-inject` select the parent assignment before preparing a worktree and fail loudly if the model, subscription authentication, or exact thinking level is unavailable. The spec-quality gate and prompt renderer reject child unit specs that deviate from the role assignment before model spend. Completed historical specs and their bound receipts/audits remain immutable; retries must use a new roster-compliant attempt.

## Tools and runtime surfaces

- `context_budget` is the parent-session tool activated by `/autopilot`; it reports `ok`, `halt`, or `unknown` using the default 85% halt threshold unless configured otherwise.
- `autopilot_emit_status` is an internal child-only status tool made available by `autopilot-agent-run`; it is not registered as a parent-session command or normal parent tool.
- `autopilot_materialize_context` is an internal child-only sparse checkout helper. It grants READ materialization only, records claims/materialization evidence, enforces byte/path/conflict caps, and never grants WRITE authority.

Autopilot activation creates an isolated package-owned git main worktree per workstream under:

```text
~/.pi/agent/autopilot/worktrees/<repo-key>/active/<workstream-run>/main/
```

New Autopilot worktrees are sparse by default. The package creates them with `git worktree add --no-checkout`, applies package-owned non-cone sparse checkout patterns, runs a disk gate before runtime/index mutation, snapshots the exact checkout profile in `_checkout-profile.json`, and refuses loudly instead of silently falling back to full checkout. Tracked-tree sizing streams and incrementally parses NUL-delimited `git ls-tree` records, so activation does not depend on Node's fixed child-output buffer and remains valid for repositories whose tracked-tree listing is many megabytes. The scan is pinned to the resolved HEAD commit so profile evidence cannot mix two revisions if the source branch moves concurrently. The default profile is claim-minimal: baseline package/project files plus the source paths a unit declares or safely materializes. Projects may opt into `.autopilot/checkout-profile.json`, or `AUTOPILOT_CHECKOUT_PROFILE=/absolute/path`, with explicit `full` mode only when the operator wants full checkouts and still passes the disk gate.

Runtime files live inside that main worktree under:

```text
.pi/autopilot/<workstream>/
```

Source-changing implement/fix units run in deterministic sparse per-unit worktrees under `~/.pi/agent/autopilot/worktrees/<repo-key>/active/<workstream-run>/units/<unit-id>/attempt-<n>/worktree/`; their authoritative status, receipt, evidence, audit, execution-commit, unit-merge, validation-staleness, and scheduler artifacts still live under the main runtime root above, while cleanup evidence is appended to the repo worktree root `_ledger.jsonl`. Before child launch, Autopilot acquires WRITE claims for `owned_paths`, READ claims for `read_only_paths` plus source context/inspection refs, materializes those paths into the unit and main worktrees, writes `_materialization-ledger.jsonl` and `_materialized-paths.json`, and creates parent directories for future owned files. Children may request extra tracked READ context through child-only `autopilot_materialize_context`, and direct `Read` sparse misses are materialized automatically when caps/conflicts allow. WRITE scope never expands silently: a child needing new edit authority must emit a blocker so the parent/spec can amend scope or create a new attempt. Shared run/session/child authority lives under `~/.pi/agent/autopilot/coordinator/` (`coordinator.db` plus WAL/SHM, lifecycle/startup locks, private capability, local socket or named pipe, backups, exports, and session contexts). Pre-cutover claim/worktree JSON under `coordination/<repo-key>/` remains validated migration input, not a fallback for coordinator failure. Autopilot validates and writes package-owned artifact paths for `mission.md`, `master-plan.json`, `decision-log.jsonl`, `unit-specs/`, `statuses/`, `receipts/`, `execution-audits/`, `execution-commits/`, `unit-merges/`, `validation-staleness/`, `rendered-prompts/`, `evidence/`, `state.json`, `events.jsonl`, `scheduler-config.json`, close evidence, and handoff files. Unit specs require status, receipt, and evidence outputs to stay inside the matching workstream runtime root, and non-strategy child specs must reference durable mission/master-plan context before launch. Handoff prompts target `handoff.json`, `handoff.md`, and `handoff-event-tail.jsonl` in the active workstream root. The strict `autopilot.handoff.v1` shape carries mission, master-plan, decision-tail/latest-decision, state/event-tail, status, and execution-audit refs so next sessions recover purpose before queues.

## Contracts, templates, and state-store

The package ships schema-backed Autopilot contracts for unit specs, status entries, events, state, receipts, handoffs, `autopilot.master_plan.v1`, `autopilot.decision.v1`, `autopilot.execution_audit.v1`, and `autopilot.execution_commit.v1`. Unit specs also carry Quality vNext fields for quality profile, risk level, acceptance criteria, verification plan, closure criteria, and upstream refs. Semantic validation covers role/verdict coherence, owned-path status changes, fake-green command rejection, declared-command and witness coverage, evidence metadata, receipt hashes, provider identity, output freshness, runtime-root placement, durable planning refs, purpose-state coherence, and execution-audit fact/classification coherence.

Role templates and deterministic render helpers cover strategy, implement, validate, fix, adjudicate, bughunt, and extract units. Parent and child prompts include the package-owned perfect-quality contract: no band-aids, hacks, silent fallbacks, fake-green tests, fixture tampering, deferred consumers, or source-changing self-certification. State/lifecycle helpers keep source-changing work in `transport-complete`, `audit-review`, or `validation-ready` until execution audits are clean/adjudicated and each source-changing work item has its own referenced independent validation PASS; closure gates reject unresolved scope/protected-path exceptions, missing per-work-item validation, and missing final bughunt proof for high-risk or multi-lane work. The state-store helpers write `state.json` atomically, append `events.jsonl` monotonically, validate runtime references, and resume from bounded event tails under `.pi/autopilot/<workstream>/`.

## Runner and CLI

`autopilot-agent-run` is the child runner CLI:

```bash
autopilot-agent-run [--dry-run] [--json] [--pi-executable <path>] <unit-spec.json>
```

The published bin launches compiled JavaScript under `dist/src/cli/autopilot-agent-run.js`; it does not execute TypeScript source from `node_modules` or rely on Node type stripping. Live runs also require the current private coordinator session context and register a child lease before model spend; a fenced old session, missing authority, PID/boot mismatch transition, or coordinator failure is loud.

The second compiled CLI is:

```bash
autopilot-coordinator status|doctor|export
autopilot-coordinator serve
```

It uses the same absolute `AUTOPILOT_STATE_ROOT` override as tests and defaults to `~/.pi/agent/autopilot/`. The runner reads and validates an Autopilot unit spec, applies the deterministic Quality vNext spec gate before model spend, creates/resumes the deterministic per-unit worktree for source-changing implement/fix specs, rolls that worktree/branch back if later preflight fails before child launch, verifies that `cwd` is inside the registered Autopilot unit worktree, verifies a clean source baseline, acquires path claims for owned/read-only paths, builds the forced-output/status context against the authoritative main runtime root, renders the child prompt, optionally snapshots it, preflights stale status/receipt paths, and either dry-runs or launches Pi in RPC mode with the internal compiled status tool and worktree guard. Parent and child sessions may use local git inside registered Autopilot worktrees, including staging, commits, resets, restores, checkouts, cleanups, and rebases, but the guard rejects git whose effective cwd/work-tree is outside the active worktree plus explicit git remapping, remote/external subcommands, and shared branch/tag mutation. On completion the runner accepts matching status artifacts, receipt artifacts, and receipt-matching structured tool carriers, then writes an `autopilot.execution_audit.v1` record under `execution-audits/` and revalidates success statuses against the audit before transport acceptance; assistant text alone is rejected. Execution audits include committed-path deltas when a child creates in-worktree commits, and `autopilot.execution_commit.v1` evidence captures either runtime-created commits, child-created commits, or mixed child+runtime ranges on the unit branch. Stable failure classes distinguish invalid specs, Pi launch/runtime failures, missing structured output, invalid structured output, and non-success status verdicts, while runner output includes audit path/classification for parent semantic routing. Dirty baselines are attribution blockers only when they overlap unit-owned or protected surfaces; unrelated dirty paths are recorded as audit caveats instead of forcing a globally clean tree.

Autopilot's forced-output identity layer recognizes subscription Pi provider routes under `openai-codex/*`, `anthropic/*`, `opencode-go/*`, `kimi-coding/*`, and `zai/*`, but the fixed launch roster is stricter: parent and child execution uses only the three documented `openai-codex/gpt-5.6-*` assignments. Any role/model/thinking mismatch is rejected before child launch; OpenRouter and other metered frontier routes remain forbidden.

## Close / merge lifecycle

`/autopilot-close` is deterministic runtime code, not a model prompt. It is local-only: no fetch, push, network, or PR creation. The close runtime requires the operator source checkout to be clean and on the captured target branch, blocks child launches by moving the run to `merging`, verifies that source-changing work has schema-valid state/master-plan/status/audit evidence plus independent validation, verifies that the final integrated diff equals the union of accepted `autopilot.unit_merge.v1` changed paths for Phase 2 work, rejects remaining validation-staleness artifacts, blocks on foreign/manual target path intersections and dirty/running/quarantined unit worktrees, merges the target branch into the workstream branch, fast-forwards the target branch, appends `autopilot.merge_event.v1` and `autopilot.foreign_merge_ack.v1` rows, releases retained claims, archives runtime evidence under `~/.pi/agent/autopilot/worktrees/<repo-key>/_archive/<workstream-run>/`, removes only paths derived from the active row (`active/<workstream-run>/main/` and terminal unit `worktree/` paths), removes the active task directory after archive when only known metadata residue remains, runs `git worktree prune` only after run-owned physical removal/reconciliation proof, verifies filesystem and `git worktree list --porcelain` residue, and retires the branch to `autopilot/archive/<workstream-run>/main`. `/autopilot-abort` uses the same runtime-owned archival/claim-release/cleanup machinery without merging and retires the branch to `autopilot/archive/<workstream-run>/aborted`. Worktree-local git freedom does not bypass close: final changed paths still require unit-merge evidence, execution-audit evidence, execution-commit evidence, and independent validation.

Default automated coverage is offline and no-spend: unit tests cover transactional storage, backups/integrity/export, IPC framing/authentication, idempotency, fencing, handoff, child leases, and mailbox persistence; multiprocess tests prove single-writer election and committed-state recovery after a hard coordinator kill; packed-install tests execute both compiled bins in a generic repository. Existing fake Pi processes for runner scenarios including worktree registration, per-unit worktrees, same-parent claims, scheduler cap/skip logic, runtime-owned unit mergeback, validation staleness, claim GC, run-owned worktree cleanup/pruning, worktree-scoped git guards, execution audits, child-created commits, and execution-commit evidence; e2e smoke tests exercise the fake-Pi status/receipt/state path in an isolated Autopilot worktree; SDK tests load the extension in isolated Pi sessions; RPC tests use offline `pi --mode rpc`; package tests inspect manifest/docs/bin/payload; and `pack:dry-run` verifies the published files.

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

Autopilot currently supplies the package extension, commands, `context_budget`, scheduler/runtime quality gates, isolated worktrees, runner/close/abort flows, Coordination Fabric contracts, the transactional coordinator, durable run supervisors, session/child leases, generation fencing, durable mailbox drain, handoff continuity, diagnostics, deterministic export, multiprocess restart proof, and standalone packed-install coverage. End-to-end peer claim negotiation, automatic offline release-condition replay, owner-scoped Git sagas, edit-lease/change-reservation cutover, deadlock/fairness policy, contradiction arbitration, and legacy database cutover remain later Coordination Fabric phases. It does not include a compiled scheduler UI, PTY/TUI coverage, default automated live-provider execution, network push/PR creation, or hosted PR automation. Provider-backed child runs require explicit operator approval, subscription Pi channels, and the `autopilot-agent-run` path; the default package gate remains deterministic, offline, network-free, and isolated from user/global Pi state.
