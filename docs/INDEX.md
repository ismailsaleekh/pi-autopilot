---
doc_id: INDEX
mode: generated
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

<p align="center">
  <img src="../logo.png" alt="Autopilot" width="120" height="120" />
</p>

# Autopilot Documentation Index

Machine-navigable index of every public surface and subsystem. The tables below are
generated from code (`scripts/docs-generate.mjs`) and byte-verified by the docs gate
(C2). For programmatic navigation, load [`manifest.json`](manifest.json):
`surface_to_docs`, `source_to_docs`, and per-doc metadata.

Start at the gateway: [`../AUTOPILOT-INSTRUCTIONS.md`](../AUTOPILOT-INSTRUCTIONS.md).
Before editing any source, consult [`read-before-edit.md`](read-before-edit.md).

## Commands

<!-- GENERATED:commands START (source: src/extension.ts, src/core/names.ts) -->
| Command | Synopsis |
| --- | --- |
| [`/autopilot`](commands/autopilot.md) | `/autopilot <workstream> [task intro/current focus]` |
| [`/autopilot-inject`](commands/autopilot-inject.md) | `/autopilot-inject <workstream>` |
| [`/autopilot-onboard`](commands/autopilot-onboard.md) | `/autopilot-onboard <workstream> [handoff refs/notes]` |
| [`/autopilot-handoff`](commands/autopilot-handoff.md) | `/autopilot-handoff [comments]` |
| [`/autopilot-config`](commands/autopilot-config.md) | `/autopilot-config show \| parallel-cap <n>` |
| [`/autopilot-close`](commands/autopilot-close.md) | `/autopilot-close <workstream> [--run <workstream_run>] [--dry-run]` |
| [`/autopilot-abort`](commands/autopilot-abort.md) | `/autopilot-abort <workstream> [--run <workstream_run>] [--dry-run]` |
| [`/autopilot-claim-gc`](commands/autopilot-claim-gc.md) | `/autopilot-claim-gc --dry-run\|--apply` |
| [`/autopilot-coordination`](commands/autopilot-coordination.md) | `/autopilot-coordination status\|doctor` |
<!-- GENERATED:commands END -->

## Tools

<!-- GENERATED:tools START (source: src/core/names.ts, src/internal/status-extension.ts) -->
| Tool | Availability |
| --- | --- |
| `context_budget` | parent session |
| `autopilot_respond_claim_request` | parent session |
| `autopilot_emit_status` | child runner only |
| `autopilot_materialize_context` | child runner only |
<!-- GENERATED:tools END -->

## CLIs

<!-- GENERATED:clis START (source: src/cli/autopilot-coordinator.ts, src/cli/autopilot-agent-run.ts) -->
| CLI | Invocation |
| --- | --- |
| `autopilot-agent-run` | `autopilot-agent-run [--dry-run] [--json] [--pi-executable <path>] <unit-spec.json>` |
| `autopilot-coordinator` | `autopilot-coordinator serve\|status\|doctor\|export\|replay\|upgrade-schema11\|migrate\|verify\|rollback\|cutover\|recovery` |
<!-- GENERATED:clis END -->

## Schemas

<!-- GENERATED:schemas START (source: src/core/names.ts) -->
- `autopilot.unit_spec.v1`
- `autopilot.status.v1`
- `autopilot.event.v1`
- `autopilot.state.v1`
- `autopilot.receipt.v1`
- `autopilot.handoff.v1`
- `autopilot.master_plan.v1`
- `autopilot.decision.v1`
- `autopilot.execution_audit.v1`
- `autopilot.execution_commit.v1`
<!-- GENERATED:schemas END -->

## Model roster

<!-- GENERATED:model-roster START (source: src/core/model-roster.ts) -->
| Role | Model | Thinking |
| --- | --- | --- |
| parent/orchestrator | `openai-codex/gpt-5.6-sol` | `xhigh` |
| strategy | `openai-codex/gpt-5.6-sol` | `xhigh` |
| implement | `openai-codex/gpt-5.6-terra` | `high` |
| validate | `openai-codex/gpt-5.6-sol` | `xhigh` |
| fix | `openai-codex/gpt-5.6-terra` | `high` |
| adjudicate | `openai-codex/gpt-5.6-sol` | `xhigh` |
| bughunt | `openai-codex/gpt-5.6-sol` | `xhigh` |
| extract | `openai-codex/gpt-5.6-luna` | `high` |
<!-- GENERATED:model-roster END -->

## Default constants

<!-- GENERATED:defaults START (source: src/core/scheduler-config.ts, src/core/context-budget.ts) -->
| Default | Value | Source |
| --- | --- | --- |
| `parallel_cap` (default) | `8` | `src/core/scheduler-config.ts#AUTOPILOT_DEFAULT_PARALLEL_CAP` |
| `parallel_cap` (min) | `1` | `src/core/scheduler-config.ts#AUTOPILOT_MIN_PARALLEL_CAP` |
| `parallel_cap` (max) | `32` | `src/core/scheduler-config.ts#AUTOPILOT_MAX_PARALLEL_CAP` |
| context halt percent | `85` | `src/core/context-budget.ts#DEFAULT_CONTEXT_HALT_PERCENT` |
<!-- GENERATED:defaults END -->

## Runtime state paths

<!-- GENERATED:runtime-paths START (source: src/core/names.ts, src/core/parallel-runtime.ts) -->
| Path | Location | Notes |
| --- | --- | --- |
| State root (default) | `~/.pi/agent/autopilot` | `AUTOPILOT_STATE_ROOT` override |
| Per-workstream runtime root | `.pi/autopilot/<workstream>/` | inside the isolated main worktree |
| Coordinator authority root | `~/.pi/agent/autopilot/coordinator/` | db/WAL/SHM, locks, socket, capability |
| Worktree root | `~/.pi/agent/autopilot/worktrees/<repo-key>/` | per-run main + unit worktrees |
<!-- GENERATED:runtime-paths END -->

## Subsystems

| Subsystem | Doc |
|---|---|
| Coordination Fabric | [`subsystems/coordination.md`](subsystems/coordination.md) |
| Close / merge / abort lifecycle | [`subsystems/close-lifecycle.md`](subsystems/close-lifecycle.md) |
| Worktrees + sparse checkout + git guard | [`subsystems/worktrees.md`](subsystems/worktrees.md) |
| Runner + forced output + execution audit | [`subsystems/runner-and-forced-output.md`](subsystems/runner-and-forced-output.md) |
| Quality vNext + terminal closure | [`subsystems/quality-and-closure.md`](subsystems/quality-and-closure.md) |
| Contracts + schemas | [`subsystems/contracts-and-schemas.md`](subsystems/contracts-and-schemas.md) |
| Docs freshness gate | [`subsystems/docs-freshness-gate.md`](subsystems/docs-freshness-gate.md) |

## Concepts (invariants + rationale)

| Concept | Doc |
|---|---|
| Observations / edit leases / EXCLUSIVE | [`concepts/leases-and-observations.md`](concepts/leases-and-observations.md) |
| Change reservations + integration risk | [`concepts/reservations.md`](concepts/reservations.md) |
| Generations + session fencing | [`concepts/generations-and-fencing.md`](concepts/generations-and-fencing.md) |
| Owner-scoped worktree sagas | [`concepts/sagas.md`](concepts/sagas.md) |
| S1 / cf50 admission | [`concepts/admission.md`](concepts/admission.md) |
| Wait-for graph + deadlock | [`concepts/deadlock.md`](concepts/deadlock.md) |
| Terminal evidence + reconciliation | [`concepts/terminal-evidence.md`](concepts/terminal-evidence.md) |
| One-way migration + cutover | [`concepts/migration-cutover.md`](concepts/migration-cutover.md) |

## Runtime state

| Topic | Doc |
|---|---|
| Full path schema | [`runtime-state/paths.md`](runtime-state/paths.md) |

## Operations (task recipes)

| Task | Doc |
|---|---|
| Start or resume a run | [`operations/start-run.md`](operations/start-run.md) |
| Hand off a run | [`operations/handoff.md`](operations/handoff.md) |
| Close (land) a workstream | [`operations/close-workstream.md`](operations/close-workstream.md) |
| Abort a workstream | [`operations/abort-workstream.md`](operations/abort-workstream.md) |
| Crash / interrupted-operation recovery | [`operations/crash-recovery.md`](operations/crash-recovery.md) |

## Troubleshooting

| Topic | Doc |
|---|---|
| Symptom → cause → fix | [`troubleshooting/failures.md`](troubleshooting/failures.md) |
