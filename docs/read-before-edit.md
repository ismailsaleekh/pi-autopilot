---
doc_id: read-before-edit
mode: generated
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Read Before Edit

The agent read-gate. Each row maps a covered source path to the doc(s) that govern
its behavior. **Before editing a listed source, open its owning doc first** — the
docs gate will force a matching doc update anyway (C4/C8), so reading first avoids a
failed verify.

This table is generated from every doc's `covers_sources` frontmatter
(`scripts/docs-generate.mjs`) and byte-verified by the gate (C2). Sources not listed
here are not yet governed by a doc; coverage ratchets up per PR (C8 floor).

<!-- GENERATED:read-before-edit START (source: docs/manifest.json) -->
| Source path | Owning doc(s) |
| --- | --- |
| `src/cli/autopilot-agent-run.ts` | [`cli/autopilot-agent-run`](cli/autopilot-agent-run.md) |
| `src/cli/autopilot-coordinator.ts` | [`cli/autopilot-coordinator`](cli/autopilot-coordinator.md) |
| `src/core/context-budget.ts` | [`tools/context_budget`](tools/context_budget.md) |
| `src/core/contracts/index.ts` | [`subsystems/contracts-and-schemas`](subsystems/contracts-and-schemas.md) |
| `src/core/coordination/admission.ts` | [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/coordination/deadlock.ts` | [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/coordination/index.ts` | [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/materialization.ts` | [`tools/autopilot_materialize_context`](tools/autopilot_materialize_context.md) |
| `src/core/scheduler-config.ts` | [`commands/autopilot-config`](commands/autopilot-config.md) |
| `src/internal/status-extension.ts` | [`tools/autopilot_emit_status`](tools/autopilot_emit_status.md) |
<!-- GENERATED:read-before-edit END -->
