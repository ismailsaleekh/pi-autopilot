---
doc_id: subsystems/runner-and-forced-output
mode: authored
review_policy: behavioral
covers_surfaces:
  - autopilot-agent-run
covers_sources:
  - drivers/src/runner/mod.rs
  - drivers/src/runner/child.rs
  - src/resolve-runner.ts
signature_hash: 'sha256:a5ee2fb831b97d6f0e5450759d68bfb1bf43017a4d5c8f10df68c05755315709'
body_hash: 'sha256:28a7af517eda3c3d5f0f7af8bde83f075455e97a52923debd5df8d387f3d9a7c'
semantic_attestation: 'sha256:28a7af517eda3c3d5f0f7af8bde83f075455e97a52923debd5df8d387f3d9a7c'
stability: stable
---

# Runner and forced-output boundary

Autopilot's child runner is split between a tiny npm wrapper and Rust Core-owned `agent-run` mode. Host code never chooses roles, modes, prompts, timeouts, runner paths, or result acceptance.

## Source map

| Concern | Source |
|---|---|
| Package-contained runner resolution | `src/resolve-runner.ts` |
| Core command/spec construction | `drivers/src/runner/mod.rs` |
| Child runner validation and Pi JSONL handling | `drivers/src/runner/child.rs` |
| Terminal carrier acceptance | `drivers/src/seam/mod.rs` |
| Public generated contract | `data/contracts.kdl`, `docs/generated/contracts.md` |

## Parent-to-child launch

1. `CoreTransport` resolves `process.execPath` and `bin/autopilot-agent-run.mjs` from the installed package and passes them to Core as transport facts.
2. Core writes a strict `autopilot.agent_run_spec.v4`, rendered prompt, and a parent-selected generated terminal profile under deterministic `.pi/autopilot/<workstream>/...` paths.
3. Core emits a `background_action` whose nested `bg_run` object is byte-exactly the public `pi-background-tasks@0.6.1` `run` payload.
4. The Host forwards that object over `pi.events`; it does not rewrite fields, synthesize defaults, or call a Pi context method named `bg_run`.
5. The background service executes the package-contained runner command and publishes one terminal event after durability.

## Child acceptance

`agent-run` validates all identity and route facts before launching Pi. It rejects stale carrier files, path symlinks, non-UTF-8 paths, role/mode drift, roster/provider/model/thinking drift, non-subscription/API-key routes, unknown tools, prompt digest mismatch, and deterministic path mismatch.

The child Pi process uses a run-owned session directory with `--no-extensions` plus the one codegen-anchored child add-on, bounded stdout/stderr, a wall timeout, and no metered API-key environment variables. Before prompting, Core verifies the streamed and durable registration receipt, selected profile, exact active tools, add-on digest, and assignment binding.

Every model assignment terminates through one parent-selected generated tool profile. `tool_execution_end.result.details`, correlated to `message_end(toolResult)` by opaque call id, is authoritative; assistant terminal text, mixed tool batches, duplicate results, identity drift, and stale unconsumed carrier files fail loudly. Planning carriers retain their planning boundary payload. Delivery and Validation use model-only v2 submissions wrapped in package-owned v2 results with immutable runner identity and a digest-bound tool audit.
