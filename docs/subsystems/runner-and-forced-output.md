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
2. Core writes a strict `autopilot.agent_run_spec.v1` and rendered prompt under deterministic `.pi/autopilot/<workstream>/...` paths.
3. Core emits a `background_action` whose nested `bg_run` object is byte-exactly the public `pi-background-tasks@0.6.1` `run` payload.
4. The Host forwards that object over `pi.events`; it does not rewrite fields, synthesize defaults, or call a Pi context method named `bg_run`.
5. The background service executes the package-contained runner command and publishes one terminal event after durability.

## Child acceptance

`agent-run` validates all identity and route facts before launching Pi. It rejects stale carrier files, path symlinks, non-UTF-8 paths, role/mode drift, roster/provider/model/thinking drift, non-subscription/API-key routes, unknown tools, prompt digest mismatch, and deterministic path mismatch.

The child Pi process is isolated with `--no-session` and `--no-extensions`, stdout/stderr are bounded while running, wall timeout is enforced, and metered API-key environment variables are removed. Output acceptance requires one final assistant result and a successful `agent_end`; tool activity after the assistant result, multiple assistant results, missing `agent_end`, malformed JSONL, or provider/model drift fail loudly.

Planning carriers bind action, assignment, run revision, workstream, role, mode, boundary, prompt/spec digest, spec path, carrier path, and raw output. Delivery carriers are routed through Core `accept_delivery()` with lane, attempt, base commit, worktree, and focused-evidence expectations.
