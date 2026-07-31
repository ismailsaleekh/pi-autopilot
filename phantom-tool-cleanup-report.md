# Phantom tool cleanup report

## Result

Implemented the subtractive role-tool cleanup at package HEAD `2463f7c4293f723e46227923969789a8633983cf`.

Own files changed:

- `data/roles.kdl`
- `data/known-incomplete-tools.kdl` (new)
- `docs/generated/roles.md` (regenerated)
- `tests/role_matrix_parity.rs`
- `phantom-tool-cleanup-report.md` (this report)

No commit, push, reset, restore, checkout, stash, clean, binary rebuild, or background task was performed.

## Implemented changes

- Removed `context_budget` from all 15 role `tools` lists.
- Removed `context_catalog_query` from `context-curator`.
- Removed `autopilot_request_context` from `implementer` and `fixer-integrator`.
- Preserved exactly as declared:
  - validator: `autopilot_request_test`
  - onboard: `autopilot_submit_onboard` tool and terminal path
  - execution-allocator: `autopilot_submit_allocation` tool and terminal path
- Updated the validator's exact tool-list assertion and added a parity test tying all three retained, undeliverable tools to the declared known-incomplete set.
- Regenerated `docs/generated/roles.md` with `scripts/docs-generate.mjs`. Because another agent's in-flight `data/contracts.kdl` introduced syntax not yet accepted by the checked-in docs generator, generation ran in an isolated temporary package using current `data/roles.kdl` and `HEAD:data/contracts.kdl`; only the generated roles output was copied back. Generator exit: `0`.

## Known-incomplete record

Added `data/known-incomplete-tools.kdl`, schema `autopilot.known-incomplete-tools.v1`, with exactly three `tool` rows. Each row declares role, `status="declared-undeliverable"`, `disposition="retain"`, classification, and rationale.

A dedicated data file was chosen instead of adding an ignored ad hoc role field: it is machine-readable KDL, keeps delivery status distinct from role capability declarations, and requires no runtime/parser infrastructure. `tests/role_matrix_parity.rs` prevents the fenced set from being forgotten or drifting from retained declarations.

## Premises verified

- Pi builtin vocabulary is exactly `bash, edit, find, grep, ls, read, write`: direct import of Pi's `allToolNames`, exit `0`.
- A 15-role projection probe applied the runner's builtin set before and after the three deletions; every projected `allowed_tools` list was identical, exit `0`. Therefore these `tools`-list deletions have no runtime effect at this HEAD.
- `drivers/src/runner/mod.rs` filters role tools through `is_builtin_tool`; `drivers/src/runner/rpc.rs` passes only that projection through `--tools` and launches with `--no-extensions`. Corrected argv search exit: `0`.
- Runtime prompt reachability probe found zero occurrences of the six exact names in planning-role rendered layers, `delivery_prompt`, and `validator_prompt`, exit `0`. Nuance: onboard and execution-allocator base Markdown contains its terminal token, so the broad statement is only true for runtime-reachable prompts; manually invoking the generic renderer for an unspawned role would render that Markdown.
- `on_demand` is materialized by `drivers/src/runner/mod.rs::fill_context_tier`; only missing `mandatory_inline`/`required_reads` hard-fail. `rg -n on_demand drivers/src` exit: `0`.
- The validator asymmetry is real. Its exact matrix test passed before editing, exit `0`; it retains `read/grep/find/ls`, `autopilot_request_test`, and `autopilot_emit_status`, with no `bash/edit/write`.
- The artifact index is mandatory-inline for all context-curator modes in `data/context-policy.kdl`; no catalog-query implementation/schema/contract was found.
- Parent context authority is already in `drivers/src/runner/child.rs`: `get_session_stats` feeds `context_budget_from_stats`, and parent-controlled checkpoint/compaction owns the decision.

## Orchestrator decision

Removed `context_budget` from orchestrator too. The orchestrator is parent/operator-shaped, but `data/roles.kdl` is not the current parent extension's tool-registration authority. The current extension registers seven parent planning-submit tools and no `context_budget`; a child projection for orchestrator is empty both before and after deletion. Retaining the name solely because the role is parent-shaped would preserve a false capability declaration and imply a second context authority. The separate context-budget docs and manifest entries were intentionally untouched.

## Execution-allocator finding — report only

Execution allocation is Core-synthesized at this HEAD:

1. `drivers/src/seam/mod.rs::route_run` calls `allocation_submission_from_plan(workstream, &approved)`.
2. It immediately calls `allocation::validate_allocation(...)`.
3. `data/seam_real_producers.rs` deterministically constructs the submission.
4. `data/planning.kdl` contains no execution-allocator assignment.
5. `expected_boundary_for_role` has no execution-allocator route, while delivery assignment construction hardcodes `implementer`.

The allocator route probe exited `0`. No execution-allocator `AgentRunSpec` is constructible through the admitted planning or delivery paths. The role is therefore superseded by deterministic Core synthesis, not merely unbuilt. Deleting the frozen role or terminal declaration remains an operator decision; neither was changed.

## Must-file admission defect

The context-curator receives `budget-overage` as `mandatory_inline` and must verify budget compliance. The observed rendered prompt carried:

```json
"budget": {"context_window": 0, "estimated_initial_tokens": 2812, "estimated_percent": 2}
```

Per-artifact estimates and `context_window` were zero while the aggregate estimator worked. The curator correctly returned:

> `CONTEXT_GAP: the budget is not verdictable because context_window is 0 ...`

Its carrier was accepted anyway. This is a silent fallback at the admission layer on a role run every planning cycle. The supplied forensic strings are not retained in package files (`rg` exit `1`), so this report records the operator-provided evidence verbatim.

## Verification

| Command/probe | Exit |
| --- | ---: |
| initial `git rev-parse HEAD` | 0 |
| initial `git status --porcelain` | 0 |
| Pi builtin vocabulary probe | 0 |
| builtin projection/no-runtime-effect probe | 0 |
| runtime rendered-prompt reachability probe | 0 |
| validator least-privilege matrix test (before edit) | 0 |
| execution-allocator route probe | 0 |
| docs generator | 0 |
| `cargo test --workspace` | 0 |
| `npm run -s codegen:check` | 0 |
| `npm run -s gate:kernel-purity` | 0 |
| `npm run -s gate:real-producers` | 0 |
| `npm run -s typecheck` | 0 |
| `npm run -s test:host` (62 passed) | 0 |
| `npm run -s modelcheck` (C1–C8 pass) | 0 |
| scoped `cargo fmt` for `tests/role_matrix_parity.rs` | 0 |
| post-format `cargo test --test role_matrix_parity` (3 passed) | 0 |
| post-edit hygiene assertions | 0 |
| scoped `git diff --check` | 0 |
| `npm run -s gate:binary-parity` | 1 (expected) |

Binary parity failed only on recorded/current source-hash mismatch (recorded `4f5f2e...`, current `9c9d6a...`). `data/` is in the hash scope; binaries were correctly not rebuilt.

## Concurrency and prompt discrepancies

- Contrary to the task's start-state statement, the first `git status --porcelain` was clean. Before my first edit, another agent's changes appeared in `codegen/src/main.rs`, `data/contracts.kdl`, generated Rust/TypeScript, and later generated prompts/templates. I did not touch those files.
- `data/contracts.kdl` contained only the other agent's `submit_tool`/admissibility edits when inspected and remained outside my edit/generation commands.
- `roles/*/base.md` still contains the known stale `thinking max` wording while `data/roster.kdl`/`data/roles.kdl` use `xhigh`; those files were not changed. Regenerating `docs/generated/roles.md` correctly made the generated table follow the data authority, also correcting its pre-existing stale validator row.
