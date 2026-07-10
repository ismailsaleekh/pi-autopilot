# Testing Autopilot

Autopilot tests are deterministic by default. They do not call live providers, networks, real models, or user/global Pi state while validating the fixed GPT-5.6 parent/child role roster, loud parent-selection failures, roster-gated unit specs, and `/autopilot`, `/autopilot-inject`, `/autopilot-onboard`, `/autopilot-handoff`, `/autopilot-config`, `/autopilot-claim-gc`, `/autopilot-close`, `/autopilot-abort`, `context_budget`, scheduler config/dispatch, sparse-by-default checkout profiles, disk-gate projection, claim-driven materialization, child-only `autopilot_materialize_context`, per-unit worktrees, runtime-owned unit mergeback, validation staleness, run-owned worktree cleanup/pruning, contracts/templates, Quality vNext contract schemas, perfect-quality prompt doctrine, worktree-scoped git guards, scope/protected-path adjudication, work-item lifecycle/closure gates, runtime close/merge/abort, forced-output/status, state-store helpers, `autopilot-agent-run`, runner CLI/bin behavior, fake-Pi paths, offline SDK/RPC/package gates, and package payloads.

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
npm run test:sdk
npm run test:rpc
npm run test:package
```

Release validation also runs docs audits and forbidden legacy-runtime scans from this standalone repo.

## What the suites cover

- `build` emits runtime JavaScript into `dist/` so the published `autopilot-agent-run` bin never type-strips TypeScript from `node_modules`.
- `typecheck` and `test:type-safety` enforce strict TypeScript and ban type escapes across source, extension, and tests.
- `test:unit` covers `context_budget`, command parsing, fixed parent/child model roster resolution and mismatch rejection, parent prompt, onboard prompt, handoff prompt rendering, scheduler config/dispatch, sparse checkout profile parsing, a real-Git tracked-tree scan whose NUL-delimited output exceeds Node's historical 1 MiB synchronous child-output buffer, disk-gate arithmetic, sparse main/unit worktree creation, claim-driven materialization, safe READ expansion, per-unit worktrees, same-parent claim semantics, runtime-owned unit mergeback, validation staleness, claim GC, run-owned worktree cleanup/pruning before unit creation, after merge/reset/abort, on runner preflight rollback, and on close/abort, Autopilot contracts/templates, Quality vNext unit-spec fields, deterministic spec-quality gates, status fake-green rejection, master-plan/decision/audit schemas, purpose-store helpers, worktree-scoped git guard decisions, execution-audit generation/classification/coherence including child-created commits, scope/protected-path adjudication, work-item lifecycle and terminal closure gates, perfect-quality prompt doctrine, forced-output/status identity and receipts, state-store read/write/resume behavior, and `autopilot-agent-run` dry-run/fake-Pi/error handling.
- `test:sdk` loads the extension through the real Pi SDK with isolated temp `cwd`/`agentDir`, in-memory managers, no built-in tools by default, and offline environment variables. It asserts `/autopilot`, `/autopilot-inject`, `/autopilot-onboard`, `/autopilot-handoff`, `/autopilot-config`, `/autopilot-claim-gc`, `/autopilot-close`, `/autopilot-abort`, active-workstream handoff behavior, and parent-session tool exposure.
- `test:rpc` starts an offline `pi --mode rpc` process with isolated HOME/session directories and validates command discovery including `/autopilot-inject`, `/autopilot-config`, `/autopilot-claim-gc`, plus `/autopilot`, `/autopilot-onboard`, and `/autopilot-handoff` command payloads.
- `test:package` validates manifest/docs/runtime files, public surfaces, README-to-TEST_PLAN mapping, stale-docs audits, runner help output, packed `node_modules` bin dry-run behavior, and dry-run pack contents.
- `pack:dry-run` confirms the published payload contains runtime files (`bin/`, `dist/`, `extensions/`, `src/`, `templates/`, docs, license) and excludes tests, artifacts, and dependency directories.
- `tests/e2e/` contains no-spend fake-Pi witnesses for runner/status/receipt/state/resume flows. These are invoked directly by the child-runner validation lane when e2e smoke coverage is required; they are not live-provider tests.

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

Current tests validate shipped commands, `context_budget`, parent/onboard/handoff prompts, scheduler config/dispatch, sparse checkout profile parsing, disk-gate arithmetic, sparse main/unit worktrees, claim-driven materialization, safe READ expansion, per-unit worktrees, runtime-owned unit mergeback, validation staleness, claim GC, run-owned worktree cleanup/pruning, runtime close/merge/abort, contracts/templates, Quality vNext contract schemas, deterministic spec/status gates, durable purpose state, worktree-scoped git guards, execution-audit generation/classification/coherence, child-created commit evidence, scope/protected-path adjudication, work-item lifecycle and terminal closure gates, perfect-quality prompt doctrine, forced-output/status, state-store helpers, runner CLI/bin, fake-Pi and e2e witnesses, offline SDK/RPC/package gates, and `pack:dry-run`. Remaining coverage gaps are compiled scheduling UI, PTY/TUI behavior, migration tooling for older runtime folders, default automated live-provider child execution, network push/PR creation, and hosted PR automation.
