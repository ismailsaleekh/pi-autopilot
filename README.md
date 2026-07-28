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

1. TypeScript Host validates Core frames, obtains background capabilities, forwards exact `bg_run` descriptors over `pi.events`, retains task/action/assignment bindings, and relays terminal events back to Core.
2. Rust Core owns command parsing, four-file task-pack classification, planning inventory, role/mode/roster selection, runner spec generation, command bytes, terminal acceptance, and state mutation.
3. `autopilot-agent-run` is only a package-contained wrapper: it resolves sibling `bin/autopilot-core.mjs` and invokes `agent-run --spec <absolute-spec.json>`. It never falls back to PATH, cwd, source trees, `dist/`, or `target/`.
4. Child `agent-run` mode validates the generated spec, launches `pi --mode json --no-session --no-extensions` with subscription roster facts, strips metered API-key overrides, requires exactly one final assistant result plus successful `agent_end`, and writes the deterministic carrier.

## Four-file planning input

`/autopilot-plan <workstream> <a> <b> <c> <context>` accepts exactly three `[authority]` files followed by one `[context/non-authority]` file. All four must share the same `authority_set_id`; historical/index files, symlinks, absolute paths, path escapes, CRLF/BOM headers, duplicate paths, and context-as-authority order drift fail before mutation. Only the three authority files become Work atoms; the fourth file is preserved as context.

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
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run test:rust
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run test:host
PI_BACKGROUND_TASKS_PACKAGE_ROOT=../pi-background-tasks PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run test:runtime-integration
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1 npm run payload:check
```

No default check calls a live provider, paid/metered API, external network, root preflight, or root DAG validation.

## Documentation

- Generated contracts/roles/roster/workflow: `docs/generated/`.
- Runner details: `docs/cli/autopilot-agent-run.md` and `docs/subsystems/runner-and-forced-output.md`.
- Release/certification procedure: `docs/operations/release-certification.md`.
- Package test plan and operation notes: `TEST_PLAN.md`, `TESTING.md`, `PUBLISHING.md`.
