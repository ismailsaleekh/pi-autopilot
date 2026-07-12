# Testing Autopilot

Autopilot tests are deterministic by default. They do not call live providers, networks, real models, or user/global Pi state while validating Coordination Fabric contracts, the transactional coordinator, durable run supervisors, session/child fencing, durable mailbox cursors/offline replay, automatic terminal-evidence reconciliation, executable invariants, failure/transition models, legacy coordination preflight, standalone package isolation, and the fixed GPT-5.6 parent/child role roster, loud parent-selection failures, roster-gated unit specs, and `/autopilot`, `/autopilot-inject`, `/autopilot-onboard`, `/autopilot-handoff`, `/autopilot-config`, `/autopilot-claim-gc`, `/autopilot-coordination`, `/autopilot-close`, `/autopilot-abort`, `autopilot-coordinator`, `context_budget`, scheduler config/dispatch, sparse-by-default checkout profiles, disk-gate projection, claim-driven materialization, child-only `autopilot_materialize_context`, per-unit worktrees, runtime-owned unit mergeback, validation staleness, run-owned worktree cleanup/exact metadata reconciliation, contracts/templates, Quality vNext contract schemas, perfect-quality prompt doctrine, worktree-scoped git guards, scope/protected-path adjudication, work-item lifecycle/closure gates, runtime close/merge/abort, forced-output/status, state-store helpers, `autopilot-agent-run`, runner CLI/bin behavior, fake-Pi paths, offline SDK/RPC/package gates, and package payloads.

## Default offline gate

Run from the repository root:

```bash
npm run build
npm run typecheck
npm run test:package
npm run test
npm run pack:dry-run
```

`npm run test` expands to:

```bash
npm run typecheck
npm run test:type-safety
npm run test:unit
npm run test:e2e
npm run test:model
npm run test:multiprocess
npm run test:sdk
npm run test:rpc
npm run test:package
```

Release validation also runs docs audits and forbidden legacy-runtime scans from this standalone repo.

## What the suites cover

- `build` emits runtime JavaScript into `dist/` so the published `autopilot-agent-run` and `autopilot-coordinator` bins never type-strip TypeScript from `node_modules`.
- `typecheck` and `test:type-safety` enforce strict TypeScript and ban type escapes across source, extension, and tests.
- Unit, E2E, and SDK files run with Node test concurrency `1` because they deliberately replace process-scoped environment authority; serialization prevents one isolated state root from ever becoming another test file's coordinator authority.
- `test:unit` covers strict Coordination Fabric entity/protocol parsers, closed schemas, ownership/fencing/lease/request/message/operation/escalation invariants, failure taxonomy and matrix, bounded legacy authority preflight, durable old-session claim retention warnings, malformed/incompatible authority refusal, transactional SQLite migration/backup/integrity/export, framed IPC validation, idempotent mutation, optimistic versions, session/child leases with private capabilities, running-child continuity across parent handoff, PID-reuse impersonation rejection, handoff fencing, durable mailbox delivery/acknowledgement cursors, owner/requester/both-offline replay, startup repair, child/merge/reset/quarantine/close/abort condition watchers, session/child heartbeat-expiry classification without age-based release, `context_budget`, command parsing, fixed parent/child model roster resolution and mismatch rejection, parent prompt, onboard prompt, handoff prompt rendering, scheduler config/dispatch, sparse checkout profile parsing, a real-Git tracked-tree scan whose NUL-delimited output exceeds Node's historical 1 MiB synchronous child-output buffer, disk-gate arithmetic, sparse main/unit worktree creation, claim-driven materialization, safe READ expansion, per-unit worktrees, same-parent claim semantics, runtime-owned unit mergeback, validation staleness, claim GC including completed-state/status/audit fallback for metadata-missing READ claims and running/WRITE fail-closed witnesses, run-owned worktree cleanup/exact metadata reconciliation before unit creation, after merge/reset/abort, on runner preflight rollback, and on close/abort, Autopilot contracts/templates, Quality vNext unit-spec fields, deterministic spec-quality gates, status fake-green rejection, master-plan/decision/audit schemas, purpose-store helpers, worktree-scoped git guard decisions, execution-audit generation/classification/coherence including child-created commits, scope/protected-path adjudication, work-item lifecycle and terminal closure gates, perfect-quality prompt doctrine, forced-output/status identity and receipts, state-store read/write/resume behavior, and `autopilot-agent-run` dry-run/fake-Pi/error handling.
- `test:e2e` runs the no-spend fake-Pi runner/status/receipt/state/resume witness with a real temporary coordinator, session authority, child lease, Git worktrees, and proof that parent authority is scrubbed before child spawn.
- `test:model` executes deterministic generated coordination transitions covering session fencing, idempotent attachment replay, all-or-nothing grant, incompatible contention, and atomic release-plus-notification.
- `test:multiprocess` launches real coordinator processes to prove concurrent startup elects one writer and a client restarts a hard-killed coordinator without losing committed run state.
- `test:sdk` loads the extension through the real Pi SDK with isolated temp `cwd`/`agentDir`, in-memory managers, no built-in tools by default, and offline environment variables. It asserts `/autopilot`, `/autopilot-inject`, `/autopilot-onboard`, `/autopilot-handoff`, `/autopilot-config`, `/autopilot-claim-gc`, `/autopilot-coordination`, `/autopilot-close`, `/autopilot-abort`, durable supervisor attachment, shutdown/handoff fencing, coordination status/doctor, active-workstream handoff behavior, and parent-session tool exposure.
- `test:rpc` starts an offline `pi --mode rpc` process with isolated HOME/session directories and validates command discovery including `/autopilot-inject`, `/autopilot-config`, `/autopilot-claim-gc`, `/autopilot-coordination`, plus `/autopilot`, `/autopilot-onboard`, and `/autopilot-handoff` command payloads.
- `test:package` validates standalone package isolation, manifest/docs/runtime files, public surfaces, README-to-TEST_PLAN mapping, stale-docs audits, runner/coordinator help output, packed `node_modules` runner and coordinator behavior, and dry-run pack contents.
- `pack:dry-run` confirms the published payload contains runtime files (`bin/`, `dist/`, `extensions/`, `src/`, `templates/`, docs, license) and excludes tests, artifacts, and dependency directories.
- `tests/e2e/` contains no-spend fake-Pi witnesses for runner/status/receipt/state/resume flows and runs in the default `test:e2e` lane; it is not a live-provider test.

## Environment

Recommended environment for automated runs:

```text
PI_OFFLINE=1
PI_SKIP_VERSION_CHECK=1
PI_TELEMETRY=0
CI=1
```

The SDK and RPC suites create their own temporary Pi state and should not read or mutate user-global Pi configuration.

## Artifacts

Package-local generated artifacts should be written under `artifacts/` only when a future test needs persisted logs or snapshots, and they must stay excluded from the published package unless intentionally documented.

## Live-provider policy

The default gate does not prove live provider behavior. Provider-backed child runs are opt-in only, require explicit operator approval, must use subscription Pi channels, and must launch through `autopilot-agent-run` with a reviewed Autopilot unit spec. Runner model gates allow only `openai-codex/*`, `anthropic/*`, `opencode-go/*`, `kimi-coding/*`, and `zai/*`; do not add OpenRouter or metered frontier API routes to tests or docs.

## Known limitations

Current tests validate Coordination Fabric Phases 27–32 contracts, protocol envelopes, invariants, transition/failure models, transactional WAL storage, migrations/backups/integrity/export, authenticated framed IPC, idempotency, single-writer/restart behavior, durable supervisors, session/child leases, handoff fencing, durable mailbox cursors/offline replay, startup reconciliation, automatic terminal-evidence release-condition watching, atomic acquisition groups, request dedupe/delivery/acknowledgement, typed defer/release, atomic release notification, bounded grant offers and fake-clock expiry, live grant acknowledgement, cancellation, attempt supersession, deterministic multiple-waiter ordering, real two-process negotiation, owner-scoped worktree/Git operation intents and recovery, dirty-work quarantine preservation, exact branch/common-dir/path authority, foreign-run isolation, scheduler peer-wait refs, production legacy preflight consumers, standalone isolation, shipped commands, `context_budget`, parent/onboard/handoff prompts, scheduler config/dispatch, sparse checkout profile parsing, disk-gate arithmetic, sparse main/unit worktrees, claim-driven materialization, safe READ expansion, per-unit worktrees, runtime-owned unit mergeback, validation staleness, claim GC, run-owned worktree cleanup/exact metadata reconciliation, runtime close/merge/abort, contracts/templates, Quality vNext contract schemas, deterministic spec/status gates, durable purpose state, worktree-scoped git guards, execution-audit generation/classification/coherence, child-created commit evidence, scope/protected-path adjudication, work-item lifecycle and terminal closure gates, perfect-quality prompt doctrine, forced-output/status, state-store helpers, runner CLI/bin, fake-Pi and e2e witnesses, offline SDK/RPC/package gates, and `pack:dry-run`. Remaining Coordination Fabric coverage belongs to later slices: reservations, the full deadlock/starvation engine, contradiction arbitration, and migration/cutover. Other gaps are compiled scheduling UI, PTY/TUI behavior, default automated live-provider child execution, network push/PR creation, and hosted PR automation.
