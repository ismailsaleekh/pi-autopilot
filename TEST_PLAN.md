# Autopilot Test Plan

This plan describes the current `pi-autopilot@1.3.1` package candidate and its required `pi-background-tasks@0.6.1` pair. All checks are offline/no-network unless explicitly stated otherwise; no paid or metered provider/API route is part of package certification.

## Required package-local coverage

| Area | Required proof |
|---|---|
| Codegen | `npm run codegen:check` after `cargo run -p codegen --` when `data/*.kdl` changes. Generated Rust, TypeScript, and `docs/generated/*` must match current source. |
| Host API correctness | `npm run typecheck` and `npm run test:host`: strict frame validation, exact `bg_run` object preservation, no `ctx.bg_run`, supported `ctx.ui.notify`/`pi.sendMessage` operator routes, terminal handler draining, and malformed-frame fail-closed behavior. |
| Core gates | `gate:host-thinness`, `gate:kernel-purity`, `gate:no-inference`, `gate:selftest`. These gates must not be weakened to pass. |
| Rust behavior | Focused drivers tests plus `npm run test:rust`: four-file classification, no context-as-Work elevation, terminal binding, runner child validation, delivery acceptance, command routing, crash/resume, and kernel invariants. |
| Runtime pair | `PI_BACKGROUND_TASKS_PACKAGE_ROOT=<candidate> npm run test:runtime-integration`: real Pi SDK loader, shared EventBus, real background service, fake local `pi`, exact descriptor metadata, terminal correlation, missing-service zero mutation, and historical/index no-spawn controls. |
| Binaries | Rebuild all five shipped `autopilot-core` binaries from current Rust source and regenerate `binaries/MANIFEST.json`; `npm run gate:binary-parity` and `npm run gate:launch-entrypoint` must pass. |
| Payload | `npm run payload:check` and `npm pack --dry-run --ignore-scripts`; payload must include both bin wrappers, shipped binaries, generated docs, Host source, and no tests/private runtime state. Packed-consumer release proof runs the current launch gate before the ignore-scripts pack and reuses its status-frame validator against the installed `.bin/autopilot-core` path. |
| Paired release proof | `node scripts/certify-runtime-repair.mjs --autopilot-root <abs> --background-root <abs> --evidence-dir <abs>`: clean exact candidates, background default suite, Autopilot gates/tests, runtime pair, deterministic tarballs, installed-consumer runtime rerun, final identity comparison, and `/tmp/smf-resolution/autopilot-runtime-repair-cert.v1.json`. |

## Background service coverage

The paired background candidate must pass its default suite and prove the public EventBus protocol:

- request channel `pi-background-tasks:request:v1`;
- response channel `pi-background-tasks:response:v1`;
- terminal channel `pi-background-tasks:terminal:v1`;
- operations `capabilities`, `run`, `status`, `logs`, `kill`;
- exactly-once terminal publication after output/metadata durability;
- exact command preservation for package-contained runner commands.

## Zero skip/todo policy

Required package-local and paired certification lanes must report zero skipped and zero todo tests. A missing test file, skipped runtime integration, or fake-green package proof is a certification failure.

## Out of scope for this package run

Do not run root `pipeline preflight`, root `pipeline validate-dag`, a broad repository suite, external network, paid/metered APIs, or the live SMF `/autopilot-plan` command from the root checkout. Runtime integration may invoke `/autopilot-plan` only inside its isolated temporary Pi SDK harness with a fake local `pi` executable.
