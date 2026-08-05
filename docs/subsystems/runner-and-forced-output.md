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

Fresh subscription-backed child processes use the data-owned deterministic startup spread in `data/recovery.kdl`. The spread is derived from workstream plus planning ordinal or package lane identity, so planning and delivery/validation siblings in one wave occupy distinct bounded launch buckets instead of reading the OAuth credential store together. It does not inject credentials, use an API-key fallback, alter the route, retry model content, or apply to resumed sessions.

## Recovery Engineer

A semantically admitted model result can be wrong even when its general direction is correct. Autopilot therefore has one phase-bound `recovery-engineer` attempt before terminal escalation:

- A non-pass first plan review launches a fresh planning-repair assignment with the canonical work map, complete rejected-review carrier, original authority, atom registry, repository evidence, and the same review criteria. The Recovery Engineer independently verifies the diagnosis and returns one complete work map through the generated `recovery-work-map.v1` terminal profile. Core mechanically requires nonempty diagnosis/action/preservation evidence, identical unit identity/order/scope/dependencies/links, and an exact declaration of affected units. `repaired` requires declared surgical changes; `no-defect` requires every unit to remain unchanged. Both return to the unchanged full-review gate once. Another non-pass is terminal.
- A blocked delivery classified `semantic-repairable`, or a first-round forward validation with semantic blockers, launches the same role in a source-repair mode inside the original lane worktree. The package-issued delivery assignment carries a typed recovery directive containing the rejected carrier, findings, evidence, original gate, exact approved units, base/tree, and a one-attempt budget. The typed finding selects a phase-appropriate mode (`forward-critical`, `failed-test`, `closure-repair` for evidence gaps, or `conflict-resolution` for contract defects), and the directive binds that mode to the assignment. Its submission must carry one closed recovery disposition. `repaired` requires succeeded with actual changes; `no-defect` permits exact in-scope prior changes or a mechanically clean unchanged commit. Normal delivery admission, package commit derivation, and independent round-two validation remain unchanged. A blocked Recovery Engineer or blocked round-two validator is terminal.

Blocked delivery must classify its blocker as `semantic-repairable`, `requires-new-authority`, `infrastructure`, or `unsafe`; only the first is eligible for recovery. The runtime diagnosis is evidence rather than authority: the Recovery Engineer must verify or correct it from files and bound artifacts. `requires-new-authority`, `infrastructure-blocked`, and `unsafe-blocked` are terminal, evidence-preserving dispositions and never launch the gate. The role cannot widen unit scope, change task authority or independent tests/gates, self-certify, mask infrastructure/provider errors, or create a second recovery loop. It may correct a task-owned implementation test only when that file is already in the approved unit and evidence proves the test contradicts unchanged authority.

Planning provenance is immutable and unambiguous: the rejected synthesized map and recovered map use separate create-new projections, while each Recovery Engineer/reviewer binding records exactly one bounded subject carrier path and SHA-256. Recovery comparison and approved-plan promotion reread that exact carrier and reject digest drift; ordinal-two review receives only the recovered subject. Delivery and validation record a typed pending-recovery event before issuing the child. Restart folds that event, deterministically recreates or re-emits the same assignment, and never allocates ordinary replacement work across the recovery window.
