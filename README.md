<p align="center">
  <img src="logo.png" alt="Autopilot" width="240" height="240" />
</p>

# pi-autopilot

`pi-autopilot@1.3.1` is a Pi extension package that keeps the Host thin and moves planning/run authority into the shipped Rust `autopilot-core` binary. It is certified as a lockstep pair with `pi-background-tasks@0.6.1`; Host background work uses that package's documented `pi.events` request/response/terminal protocol, never a fictional `ctx.bg_run` API.

## Runtime surfaces

- Pi extension entry: `./src/extension.ts`.
- Slash commands: `/autopilot-plan`, `/autopilot`, `/autopilot-onboard`, `/autopilot-inject`, `/autopilot-status`, `/autopilot-config`, `/autopilot-handoff`, `/autopilot-close`, `/autopilot-abort`.
- Bins: `autopilot-core` (`bin/autopilot-core.mjs`) and `autopilot-agent-run` (`bin/autopilot-agent-run.mjs`).
- Shipped Rust binaries: `binaries/{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-x64}/` with `binaries/MANIFEST.json` parity.

## Current architecture

1. TypeScript Host validates Core frames, obtains background capabilities, forwards exact `bg_run` descriptors over `pi.events`, retains task/action/assignment bindings, and relays terminal events back to Core. Autopilot-owned descriptors retain durable completion notification but disable parent-turn triggering; terminal failures emit a typed machine status and fail closed.
2. Rust Core owns command parsing, four-file task-pack classification, planning inventory, role/mode/roster selection, runner spec generation, command bytes, terminal acceptance, and state mutation.
3. `autopilot-agent-run` is only a package-contained wrapper: it resolves sibling `bin/autopilot-core.mjs` and invokes `agent-run --spec <absolute-spec.json>`. Installed packages never fall back to PATH, cwd, source trees, `dist/`, or unrelated binaries.
4. Child `agent-run` validates `autopilot.agent_run_spec.v4`, launches Pi RPC with a run-owned session, `--no-extensions`, and one explicit codegen-anchored child add-on, and strips metered API-key overrides.
5. Every model assignment receives one parent-selected generated terminal profile. Core accepts only correlated terminating tool-result details, validates profile/tool/boundary/schema/binding identity, and writes a package-owned carrier; assistant terminal text is never a carrier.
6. A typed, fresh `recovery-engineer` may investigate one semantically rejected plan or in-scope delivery/validation result. It preserves original authority, emits a closed disposition, and can return only `repaired`/`no-defect` to the unchanged independent gate once; authority, infrastructure, unsafe, or second-rejection outcomes fail closed.
7. Fresh subscription children use bounded deterministic startup buckets keyed by planning ordinal or lane identity to avoid parallel OAuth credential-read bursts. No credential injection, API-key fallback, or route substitution is permitted.

## Four-file planning input

`/autopilot-plan <workstream> <a> <b> <c> <context>` accepts exactly three `[authority]` files followed by one `[context/non-authority]` file. All four must share the same `authority_set_id`; historical/index files, symlinks, absolute paths, path escapes, CRLF/BOM headers, duplicate paths, and context-as-authority order drift fail before mutation. Only the three authority files become Work atoms; the fourth file is preserved as context.

**Full format specification, every rejection reason, and a worked example:** [`docs/task-document-format.md`](docs/task-document-format.md).
**Ready-to-copy pack:** [`templates/task-pack/`](templates/task-pack/) — copy the four files, replace `REPLACE-ME-task-slug`, and run.

```
[authority]
authority_set_id: my-task-2026-07-28
                          <- line 3 must be empty
Mission
Build the thing.
```

Line 1 is the class marker, line 2 is exactly `authority_set_id: <id>`, line 3 is empty, and the body follows. UTF-8, LF endings, no BOM.

## Local development commands

Run package-local checks from `packages/pi-autopilot` with offline environment variables:

```bash
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run typecheck
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run codegen:check
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run gate:host-thinness
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run gate:kernel-purity
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run gate:no-inference
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run gate:selftest
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run gate:binary-parity
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run gate:launch-entrypoint
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run test:rust
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run test:host
PI_BACKGROUND_TASKS_PACKAGE_ROOT=../pi-background-tasks PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run test:runtime-integration
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run payload:check
```

No default check calls a live provider, paid/metered API, external network, root preflight, or root DAG validation.

## Documentation

- Task document format (required for `/autopilot-plan`): `docs/task-document-format.md`; copyable pack at `templates/task-pack/`.
- Generated contracts/roles/roster/workflow: `docs/generated/`.
- Runner details: `docs/cli/autopilot-agent-run.md` and `docs/subsystems/runner-and-forced-output.md`.
- Release/certification procedure: `docs/operations/release-certification.md`.
- Package test plan and operation notes: `TEST_PLAN.md`, `TESTING.md`, `PUBLISHING.md`.
