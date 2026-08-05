# Autopilot Test Plan

This plan describes the current `pi-autopilot@1.3.1` package candidate and its required `pi-background-tasks@0.6.1` pair. All checks are offline/no-network unless explicitly stated otherwise; no paid or metered provider/API route is part of package certification.

## Required package-local coverage

| Area | Required proof |
|---|---|
| Codegen | `npm run codegen:check` after `cargo run -p codegen --` when `data/*.kdl` changes. Generated Rust, TypeScript, and `docs/generated/*` must match current source. |
| Host API correctness | `npm run typecheck` and `npm run test:host`: strict frame validation, exact `bg_run` object preservation, no `ctx.bg_run`, supported `ctx.ui.notify`/`pi.sendMessage` operator routes, immediate and concurrent terminal handling, typed terminal-failure status before rethrow, and malformed-frame fail-closed behavior. |
| Core gates | `gate:host-thinness`, `gate:kernel-purity`, `gate:no-inference`, `gate:selftest`. These gates must not be weakened to pass. |
| Rust behavior | Focused drivers tests plus `npm run test:rust`: four-file classification, no context-as-Work elevation, terminal binding, runner child validation, delivery acceptance, command routing, crash/resume, and kernel invariants. |
| Bounded semantic recovery | Planning first-rejection → one Recovery Engineer → unchanged rereview, repaired and no-defect success, authority/infrastructure/unsafe fail-closed dispositions, separate create-new work-map projections, digest-bound single-subject promotion, subject-drift rejection, delivery/validation crash replay, exact authority preservation, source recovery under original lane scope, independent validation round two, exhaustion without looping, profile-specific tools, and fresh-child startup-bucket bounds. |
| Runtime pair | `PI_BACKGROUND_TASKS_PACKAGE_ROOT=<candidate> npm run test:runtime-integration`: real Pi SDK loader, shared EventBus, real background service, fake local `pi`, exact `notifyOnCompletion:true`/`triggerOnCompletion:false` Autopilot descriptors, Core-driven terminal continuation without a parent turn, missing-service zero mutation, and historical/index no-spawn controls. |
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

## Focused mutation-kill suggestions

- Drop the initial planning.work-map.v1 atom-link manifest render: `real_plan_compiler_prompt_renders_full_work_map_authority_and_atom_manifest` should fail.
- Drop the WorkMap repair atom-link manifest append: `work_map_value_repair_repeats_authority_and_atom_manifest_for_non_link_error` should fail.
- Render only the Layer 6 boundary id instead of package-generated admission authority: prompt authority tests should fail on missing WorkMap admits text.
- Remove exact one-ID/no `atoms:`/range/comma/source wording: prompt and boundary coverage assertions should fail.
- Remove external-temp/no-effect wording: prompt guidance assertions should fail.
- Admit a second semantic recovery attempt or weaken same-gate policy: `semantic_recovery_rejects_loop_or_weakened_gate` and rereview exhaustion tests should fail.
- Permit Recovery Engineer work-map scope expansion or omit typed evidence/disposition: planning recovery authority tests should fail.
- Route infrastructure/unsafe blockers into semantic repair: delivery and validation inadmissible-recovery tests should fail.
- Remove blocker-class/disposition cross-field checks or allow no-defect to hide dirty state: delivery admission and no-defect package tests should fail.
- Collapse parallel child startup buckets: startup-stagger planning/lane distinctness tests should fail.
- Enable `triggerOnCompletion` or disable `notifyOnCompletion` in the normal runner, planning replay/re-emission, or watchdog producer: producer assertions and the central exact-command guard must fail before spawn.
- Remove typed Host terminal failure publication: terminal transport regression must fail on the missing `rejection:host-terminal:` status or wrong status/prose order.

## Zero skip/todo policy

Required package-local and paired certification lanes must report zero skipped and zero todo tests. A missing test file, skipped runtime integration, or fake-green package proof is a certification failure.

## Out of scope for this package run

Do not run root `pipeline preflight`, root `pipeline validate-dag`, a broad repository suite, external network, paid/metered APIs, or the live SMF `/autopilot-plan` command from the root checkout. Runtime integration may invoke `/autopilot-plan` only inside its isolated temporary Pi SDK harness with a fake local `pi` executable.
