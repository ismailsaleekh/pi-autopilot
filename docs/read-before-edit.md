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
| `src/cli/autopilot-coordinator-bootstrap.ts` | [`cli/autopilot-coordinator`](cli/autopilot-coordinator.md) |
| `src/cli/autopilot-coordinator.ts` | [`cli/autopilot-coordinator`](cli/autopilot-coordinator.md) |
| `src/cli/migration-recovery.ts` | [`concepts/migration-cutover`](concepts/migration-cutover.md) |
| `src/core/adjudication/index.ts` | [`subsystems/quality-and-closure`](subsystems/quality-and-closure.md) |
| `src/core/agent-runner.ts` | [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/authority.ts` | [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/checkout-profile.ts` | [`subsystems/worktrees`](subsystems/worktrees.md) |
| `src/core/claim-gc.ts` | [`commands/autopilot-claim-gc`](commands/autopilot-claim-gc.md) |
| `src/core/close-runtime.ts` | [`subsystems/close-lifecycle`](subsystems/close-lifecycle.md) |
| `src/core/context-budget.ts` | [`tools/context_budget`](tools/context_budget.md) |
| `src/core/contracts/index.ts` | [`subsystems/contracts-and-schemas`](subsystems/contracts-and-schemas.md) |
| `src/core/coordination/admission.ts` | [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/coordination/deadlock.ts` | [`concepts/deadlock`](concepts/deadlock.md), [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/coordination/index.ts` | [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/disk-gate.ts` | [`subsystems/worktrees`](subsystems/worktrees.md) |
| `src/core/execution-audit/index.ts` | [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/execution-commit.ts` | [`subsystems/close-lifecycle`](subsystems/close-lifecycle.md) |
| `src/core/forced-output/identity.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/forced-output/index.ts` | [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/git-guard.ts` | [`subsystems/worktrees`](subsystems/worktrees.md) |
| `src/core/git-process.ts` | [`subsystems/worktrees`](subsystems/worktrees.md) |
| `src/core/lifecycle/index.ts` | [`subsystems/quality-and-closure`](subsystems/quality-and-closure.md) |
| `src/core/materialization.ts` | [`subsystems/worktrees`](subsystems/worktrees.md), [`tools/autopilot_materialize_context`](tools/autopilot_materialize_context.md) |
| `src/core/model-roster.ts` | [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/names.ts` | [`subsystems/contracts-and-schemas`](subsystems/contracts-and-schemas.md) |
| `src/core/parallel-runtime.ts` | [`subsystems/worktrees`](subsystems/worktrees.md) |
| `src/core/prompt-renderer/index.ts` | [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/quality/contract.ts` | [`subsystems/quality-and-closure`](subsystems/quality-and-closure.md) |
| `src/core/quality/spec-gate.ts` | [`subsystems/quality-and-closure`](subsystems/quality-and-closure.md) |
| `src/core/roster/activation-fence.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/artifact-compatibility.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/canonical.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/contracts.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/custom-certification.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md), [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/roster/doctor.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/historical-adapter.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/paths.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/provider-recipes.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/providers/index.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/resolve.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/route-policies.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/run-selection.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/runtime-consumers.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md), [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/roster/runtime-spec.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/setup-approval.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/setup-context.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/setup-receipt.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/setup-tool.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/skill-package.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/snapshot.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/storage.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/transaction.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/core/roster/transition.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md), [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/scheduler-config.ts` | [`commands/autopilot-config`](commands/autopilot-config.md) |
| `src/core/scheduler.ts` | [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/sparse-worktree.ts` | [`subsystems/worktrees`](subsystems/worktrees.md) |
| `src/core/state-store/index.ts` | [`subsystems/quality-and-closure`](subsystems/quality-and-closure.md) |
| `src/core/unit-failure.ts` | [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/unit-merge.ts` | [`subsystems/close-lifecycle`](subsystems/close-lifecycle.md) |
| `src/core/validation-staleness.ts` | [`subsystems/close-lifecycle`](subsystems/close-lifecycle.md) |
| `src/core/worktree-cleanup.ts` | [`subsystems/close-lifecycle`](subsystems/close-lifecycle.md) |
| `src/extension.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/internal/execution-observer-extension.ts` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `src/internal/status-extension.ts` | [`tools/autopilot_emit_status`](tools/autopilot_emit_status.md) |
| `templates/skills/autopilot-roster-setup/SKILL.md` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
| `templates/skills/autopilot-roster-setup/payload.json` | [`subsystems/roster-onboarding`](subsystems/roster-onboarding.md) |
<!-- GENERATED:read-before-edit END -->
