# Autopilot Test Plan

This plan covers the current Autopilot package capabilities: `/autopilot`, `/autopilot-onboard`, `/autopilot-handoff`, `context_budget`, contracts/templates, Quality vNext contract schemas, forced-output/status, state-store, compiled `autopilot-agent-run`, runner CLI/bin behavior, fake-Pi e2e witnesses, parent/onboard/handoff prompts, offline SDK/RPC/package gates, and `pack:dry-run` payload verification. Default validation is deterministic, provider-free, network-free, and isolated from user/global Pi state.

## Coverage matrix

| Feature / README claim | Layer | Automated check |
| --- | --- | --- |
| Pi package manifest exposes the Autopilot extension | Package | `tests/package/package.test.ts` validates `pi.extensions`, keywords, peer deps, files, scripts, docs, bin, and pack payload. |
| Public commands are `/autopilot`, `/autopilot-onboard`, and `/autopilot-handoff` | Package / SDK / RPC | Package docs checks, `tests/sdk/activation.test.ts`, `tests/sdk/autopilot-command.test.ts`, and `tests/rpc/command-payloads.test.ts` assert registered command names and command payloads. |
| No public alias outside Autopilot names | SDK / RPC / Package | SDK and RPC tests assert the final command list; package/docs audits assert only Autopilot public names are documented. |
| `context_budget` parent gate | Unit / SDK / RPC | Unit tests cover ok, halt, unknown, rounding, and invalid thresholds; SDK/RPC tests cover activation and invalid `AUTOPILOT_CONTEXT_HALT_PERCENT`. |
| `/autopilot` activates package-owned `context_budget` | SDK / RPC | Real SDK and offline RPC tests invoke `/autopilot` in isolated sessions and verify prompt behavior. |
| Parent prompt requires `context_budget` before file reads or child launch | Unit / SDK / RPC / Package | Prompt tests and command tests assert startup-gate text; package docs checks keep the README claim mapped to this row. |
| Onboard prompt is read-only and uses `/autopilot-onboard` | Unit / SDK / RPC / Package | Onboard tests assert no launch, mutation, test, provider, or runner execution; package docs include the same limitation. |
| Handoff prompt uses the active workstream and emits a `/autopilot <workstream>` resume block | Unit / SDK / RPC / Package | Handoff tests assert no workstream argument is required, pre-activation calls warn, active-session calls use the recorded workstream, optional comments are preserved, and the generated prompt requires a full next-session `/autopilot` block. |
| Runtime root uses `.pi/autopilot/<workstream>/` | Unit / Package / E2E | Parser/path tests, prompt tests, state-store tests, e2e smoke, README, and package tests assert the runtime root. |
| Contracts/templates are schema-backed and package-owned | Unit / Package | `tests/unit/contracts.test.ts` covers unit specs, Quality vNext unit-spec fields, status, events, state, receipts, handoffs, `autopilot.master_plan.v1`, `autopilot.decision.v1`, `autopilot.execution_audit.v1`, semantic rules, evidence metadata, receipt hashes, provider identity, and owned-path enforcement; prompt-renderer tests validate every role template. |
| Perfect-quality doctrine is package-owned | Unit / Package | Parent prompt and prompt-renderer tests assert the perfect-quality doctrine: no band-aids, hacks, silent fallbacks, fake-green tests, fixture tampering, deferred consumers, or self-certifying source-changing work. |
| Quality vNext spec gate rejects weak launches | Unit / Runner / Package | `tests/unit/quality-vnext.test.ts` and runner dry-run tests assert required quality profile, risk level, acceptance criteria, verification plan, closure criteria, mission/master-plan refs for non-strategy specs, declared-command witnesses, required witness expectations, high-risk real-boundary proof/blockers, and validator/adjudicator thinking policy before child launch. |
| Status quality gates reject fake-green success | Unit / Runner | Contract and forced-output tests assert `DONE`/`PASS` reject failed, not-run/blocked, or non-zero command summaries; success statuses must report declared validation commands, validator PASS must cover required witness IDs, unknown witness IDs are rejected, and non-mechanical PASS requires evidence/report refs. |
| Purpose state loads before progress state | Unit / E2E | Purpose-store tests cover `mission.md` sections, `master-plan.json`, append-only `decision-log.jsonl`, decision/master-plan coherence, bounded decision tails, and `readAutopilotResumeSnapshot()` returning purpose before state/events. |
| Execution audits record factual run deltas | Unit / Runner / E2E | Execution-audit tests cover audit path derivation, clean/scope/protected/critical/audit-unavailable classifications, actual vs reported changed paths, command coverage gaps, classification coherence, and runner result/error payload audit path/classification fields. |
| Forced-output/status tool is child-only as `autopilot_emit_status` | Unit / SDK / RPC / E2E / Package | Status-extension, forced-output, runner, SDK/RPC, e2e, and package tests assert status+receipt writing and that parent sessions do not expose the child-only surface. |
| State store | Unit / E2E | `tests/unit/state-store.test.ts` covers atomic state writes, append-only monotonic events, bounded resume snapshots, purpose-before-progress loading, reference validation, and ignoring older runtime locations by default; e2e smoke resumes from `.pi/autopilot/<workstream>/`. |
| `autopilot-agent-run` bin is shipped | Package | Package tests assert manifest bin, compiled `dist/` file existence, help output, pack payload, and installed `node_modules` dry-run behavior without Node type stripping. |
| Runner dry-run validates specs without launching Pi | Unit / Package | Runner unit tests and CLI assertions cover `autopilot-agent-run --dry-run`, prompt snapshots, status context output, and terse/json stdout. |
| Runner accepts subscription provider gates only | Unit / Package | Runner and forced-output tests cover `openai-codex/*`, `anthropic/*`, `opencode-go/*`, `kimi-coding/*`, and `zai/*`, including mixed API identity mapping and rejection of unsupported provider prefixes. |
| Runner accepts valid fake child | Unit / E2E | Fake-Pi runner tests require status artifact, receipt artifact, receipt hash, identity, and structured tool carrier to join before success. |
| Runner rejects assistant text without structured status | Unit | Runner tests cover missing structured output and invalid structured output failure classes. |
| Runner rejects bad status/receipt and stale output paths | Unit | Runner and forced-output tests cover invalid status, invalid receipt, hash mismatch, mismatched tool carrier, stale status/receipt paths, and invalid specs before model spend. |
| Runner classifies non-success verdicts | Unit | Runner tests cover BLOCKED and NEEDS_FIX status verdicts returning the non-success failure class. |
| Runner classifies Pi errors/timeouts | Unit | Fake-Pi tests cover child exit/error, spawn failures, and wall-timeout handling. |
| CLI/bin supports `--json` and `--pi-executable` | Unit / Package | CLI unit tests cover parsing, json output, executable override, help output, stable exit codes, and compiled-bin execution from installed package layout. |
| Fake-Pi e2e smoke covers status, receipt, event rows, state, and resume | E2E | `tests/e2e/agent-runner-smoke.test.ts` runs a fake Pi child, validates status evidence, writes state/events, and resumes from `.pi/autopilot/<workstream>/`. |
| Offline SDK/RPC/package gates are provider-free | SDK / RPC / Package | SDK harnesses use isolated temp dirs and in-memory managers; RPC uses offline Pi flags; package tests use no network and no provider calls. |
| Published package payload | Package | `npm run build`, `npm run pack:dry-run`, and package tests assert `dist/` runtime files are included and tests/node_modules/artifacts are excluded. |
| README promises map to TEST_PLAN rows | Package | `tests/package/package.test.ts` checks required README claim labels have matching TEST_PLAN rows. |
| Docs and package tests avoid stale legacy-runtime terms | Package | Package docs tests and release wrapper scans fail on stale terms or forbidden legacy runtime identifiers. |
| Remaining limitations are documented | Package | README, TESTING, TEST_PLAN, and PUBLISHING all state that default gates are offline and that live provider-backed child runs require explicit operator approval through subscription Pi channels. |

## Default offline gate

Run from the repository root:

```bash
npm run build
npm run typecheck
npm run test:package
npm run test
npm run pack:dry-run
```

`npm run test` expands to typecheck, type-safety, unit, SDK, RPC, and package suites. E2E fake-runner witnesses live under `tests/e2e/` and are run by the dedicated validation lane when child-runner smoke coverage is required.

Release validation also runs docs audits and forbidden legacy-runtime scans from this standalone repo.

## Manual and opt-in checks

No live provider/model call is part of the default gate. Provider-backed child execution must be an explicit release or operator witness using subscription Pi channels, a non-production workstream, and `autopilot-agent-run` with a reviewed unit spec.

## Known limitations and future coverage

Current automated coverage proves commands, `context_budget`, parent/onboard/handoff prompts, contracts/templates, Quality vNext spec/status gates, durable purpose state helpers, execution-audit generation/validation, forced-output/status, state-store helpers, runner dry-run/fake-Pi paths, offline SDK/RPC/package gates, and `pack:dry-run`. Remaining gaps are compiled scheduling UI, PTY/TUI coverage, migration tooling for older runtime folders, full lifecycle/adjudication/terminal-closure automation, and default live-provider child execution.
