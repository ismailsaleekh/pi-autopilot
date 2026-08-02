# toolResult/details defect report

## Analysis

The runner was treating every Pi `toolResult` message as if it were the terminal submit receipt. That is incorrect for Pi 0.83: ordinary tool results such as `read` can arrive with `role`, `toolCallId`, `toolName`, `content`, `isError`, and no `details` field. `details` is the terminal submit carrier payload and is only required for the terminating submit tool.

There were two coupled bugs:

1. `handle_message_end` rejected any `toolResult` without `details`, so ordinary tool calls failed before the model could submit.
2. `finish_cycle` required `tool_execution_count == 1`, so a valid worker that reads several task documents and then calls exactly one terminal submit tool would fail even after ordinary toolResults were accepted.

## Fix

- Added `tool_result_call_ids` to `CycleState` and record every `toolResult` id, including no-`details` ordinary results. This is deliberate: no-`details` toolResults are accepted, but not silently dropped; duplicate toolResult ids still fail loudly.
- Kept `tool_result_details` only for details-bearing toolResults.
- Kept terminal submit strictness:
  - exactly one terminating submit tool (`tool_terminal_count == 1`),
  - no tool activity after terminal for single-terminal cycles,
  - the terminal submit `tool_call_id` must have a correlated details-bearing `toolResult`,
  - `tool_execution_end.details` must equal `toolResult.details`,
  - there must be exactly one details-bearing toolResult in the terminal cycle.
- Replaced the bad total tool execution invariant. Total ordinary tool executions can be greater than one; only the terminating submit count must be exactly one.
- Moved duplicate terminal-submit count ahead of the generic `tool_after_terminal` error so the exact-one-terminal invariant remains observable for duplicate submit results. Single-terminal-plus-later-tool activity still fails.

## Unified diff summary

```diff
--- a/drivers/src/runner/child.rs
+++ b/drivers/src/runner/child.rs
@@
-    tool_result_details: std::collections::BTreeMap<String, Value>,
+    tool_result_call_ids: BTreeSet<String>,
+    tool_result_details: BTreeMap<String, Value>,
@@
-            let details = message
-                .details
-                .ok_or_else(|| "agent-run toolResult missing details".to_owned())?;
+            if !state.tool_result_call_ids.insert(call_id.clone()) {
+                return Err(format!("agent-run received duplicate toolResult for {call_id}"));
+            }
+            let Some(details) = message.details else {
+                return Ok(());
+            };
             if state.tool_result_details.insert(call_id.clone(), details).is_some() {
                 return Err(format!("agent-run received duplicate toolResult details for {call_id}"));
             }
@@
-            if state.tool_execution_count != 1 || state.tool_result_details.len() != 1 {
-                return Err(format!(
-                    "agent-run terminal turn mixed {} tool executions and {} tool results",
-                    state.tool_execution_count,
-                    state.tool_result_details.len()
-                ));
-            }
             let duplicate = state.tool_result_details.get(&terminal.tool_call_id)
                 .ok_or_else(|| format!(
                     "agent-run terminating tool missing correlated toolResult details for {}",
                     terminal.tool_call_id
                 ))?;
             if duplicate != &terminal.details_value { ... details drift ... }
+            if state.tool_result_details.len() != 1 { ... details-bearing count error ... }
```

Tests in `tests/runner_child.rs` now model Pi 0.83 ordinary toolResults without `details`, plus missing terminal details and duplicate terminal submit cases.

## Deliberate-break verification

- `ordinary_tool_results_without_details_before_terminal_submit_succeed`: reverted the no-details acceptance in `handle_message_end`; the test failed with `agent-run toolResult missing details`. Restored.
- `terminal_tool_result_details_drift_still_fails_loudly`: temporarily disabled the details equality check; the test failed because the run succeeded instead of reporting drift. Restored.
- `duplicate_terminating_submit_results_still_fail_loudly`: temporarily disabled the `tool_terminal_count != 1` check; the test failed because the expected duplicate-terminal error was no longer produced. Restored.
- `terminal_tool_result_must_have_correlated_details_by_opaque_call_id`: reverted no-details acceptance; the missing-details case failed with the old early `agent-run toolResult missing details` error instead of the terminal correlation failure. Restored.

## Verification

- `cargo test --workspace --offline`: 284 pass / 0 fail.
- `npm run typecheck`: pass.
- `npm run test:host`: 77 pass / 0 fail.
- `npm run test:tree-ts`: 12 pass / 0 fail.
- `cargo fmt --all --check`: pass (rustfmt emitted existing stable-channel warnings for unstable rustfmt options).
- `cargo clippy --workspace --all-targets --offline -- -D warnings`: pass.
- `cargo run -p codegen --offline -- --check`: pass.
- `npm run gate:binary-parity`: expected fail; Rust source changed and binaries were not rebuilt.

## Files changed by this task

- `drivers/src/runner/child.rs`
- `tests/runner_child.rs`
- `report.md`
- `findings.json`
