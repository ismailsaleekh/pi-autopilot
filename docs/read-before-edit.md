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
| `bin/autopilot-s2-corpus-rehearsal.mjs` | [`tools/s2-corpus-rehearsal`](tools/s2-corpus-rehearsal.md) |
| `scripts/check-package-payload.mjs` | [`operations/release-certification`](operations/release-certification.md) |
| `scripts/check-production-git-spawns.mjs` | [`operations/release-certification`](operations/release-certification.md) |
| `scripts/generate-sbom.mjs` | [`operations/release-certification`](operations/release-certification.md) |
| `scripts/run-certified-command.mjs` | [`operations/release-certification`](operations/release-certification.md) |
| `scripts/security-scan.mjs` | [`operations/release-certification`](operations/release-certification.md) |
| `scripts/test-packed-consumer-release.mjs` | [`operations/release-certification`](operations/release-certification.md) |
| `scripts/verify-packed-consumer.mjs` | [`operations/release-certification`](operations/release-certification.md) |
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
| `src/core/coordination/client.ts` | [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/coordination/d65-dispatch-authority.ts` | [`concepts/dispatch-and-recovery-authority`](concepts/dispatch-and-recovery-authority.md) |
| `src/core/coordination/d65-dispatch-gate.ts` | [`concepts/d65-terminal-tail`](concepts/d65-terminal-tail.md), [`concepts/dispatch-and-recovery-authority`](concepts/dispatch-and-recovery-authority.md) |
| `src/core/coordination/d65-dispatch-predicates.ts` | [`concepts/dispatch-and-recovery-authority`](concepts/dispatch-and-recovery-authority.md) |
| `src/core/coordination/d65-first-complete-graph.ts` | [`concepts/semantic-graph-authority`](concepts/semantic-graph-authority.md) |
| `src/core/coordination/d65-graph-authority.ts` | [`concepts/semantic-graph-authority`](concepts/semantic-graph-authority.md) |
| `src/core/coordination/d65-graph-producer.ts` | [`concepts/semantic-graph-authority`](concepts/semantic-graph-authority.md) |
| `src/core/coordination/d65-graph-publication-residue.ts` | [`concepts/semantic-graph-authority`](concepts/semantic-graph-authority.md) |
| `src/core/coordination/d65-graph-publisher.ts` | [`concepts/semantic-graph-authority`](concepts/semantic-graph-authority.md) |
| `src/core/coordination/d65-graph-successor-runtime.ts` | [`concepts/d65-terminal-tail`](concepts/d65-terminal-tail.md) |
| `src/core/coordination/d65-graph-successor.ts` | [`concepts/d65-terminal-tail`](concepts/d65-terminal-tail.md), [`concepts/semantic-graph-authority`](concepts/semantic-graph-authority.md) |
| `src/core/coordination/d65-heartbeat-gate.ts` | [`concepts/dispatch-and-recovery-authority`](concepts/dispatch-and-recovery-authority.md) |
| `src/core/coordination/d65-heartbeat-high-water.ts` | [`concepts/dispatch-and-recovery-authority`](concepts/dispatch-and-recovery-authority.md) |
| `src/core/coordination/d65-launch-policy.ts` | [`concepts/dispatch-and-recovery-authority`](concepts/dispatch-and-recovery-authority.md) |
| `src/core/coordination/d65-runtime-dispatch.ts` | [`concepts/dispatch-and-recovery-authority`](concepts/dispatch-and-recovery-authority.md) |
| `src/core/coordination/d65-semantic-graph.ts` | [`concepts/d65-terminal-tail`](concepts/d65-terminal-tail.md), [`concepts/semantic-graph-authority`](concepts/semantic-graph-authority.md) |
| `src/core/coordination/d65-terminal-intent.ts` | [`concepts/d65-terminal-tail`](concepts/d65-terminal-tail.md) |
| `src/core/coordination/deadlock.ts` | [`concepts/deadlock`](concepts/deadlock.md), [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/coordination/index.ts` | [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/coordination/invariants.ts` | [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/coordination/peer-classification.ts` | [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/coordination/runtime-constants.ts` | [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/coordination/s2-owned-gc.ts` | [`subsystems/s2-retention`](subsystems/s2-retention.md) |
| `src/core/coordination/s2-retention-archive.ts` | [`subsystems/s2-retention`](subsystems/s2-retention.md) |
| `src/core/coordination/s2-retention-policy.ts` | [`subsystems/s2-retention`](subsystems/s2-retention.md) |
| `src/core/coordination/s2-retention-state-machine.ts` | [`subsystems/s2-retention`](subsystems/s2-retention.md) |
| `src/core/coordination/store.ts` | [`subsystems/coordination`](subsystems/coordination.md) |
| `src/core/coordination/terminal-attempt-proof.ts` | [`concepts/d65-terminal-tail`](concepts/d65-terminal-tail.md) |
| `src/core/coordination/unavailable-recovery.ts` | [`concepts/dispatch-and-recovery-authority`](concepts/dispatch-and-recovery-authority.md) |
| `src/core/coordination/unit-failure-producer-provenance.ts` | [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/disk-gate.ts` | [`subsystems/worktrees`](subsystems/worktrees.md) |
| `src/core/execution-audit/index.ts` | [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/execution-commit.ts` | [`subsystems/close-lifecycle`](subsystems/close-lifecycle.md) |
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
| `src/core/scheduler-config.ts` | [`commands/autopilot-config`](commands/autopilot-config.md) |
| `src/core/scheduler.ts` | [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/sparse-worktree.ts` | [`subsystems/worktrees`](subsystems/worktrees.md) |
| `src/core/state-store/index.ts` | [`subsystems/quality-and-closure`](subsystems/quality-and-closure.md) |
| `src/core/unit-failure.ts` | [`subsystems/runner-and-forced-output`](subsystems/runner-and-forced-output.md) |
| `src/core/unit-merge.ts` | [`subsystems/close-lifecycle`](subsystems/close-lifecycle.md) |
| `src/core/validation-staleness.ts` | [`subsystems/close-lifecycle`](subsystems/close-lifecycle.md) |
| `src/core/worktree-cleanup.ts` | [`subsystems/close-lifecycle`](subsystems/close-lifecycle.md) |
| `src/internal/status-extension.ts` | [`tools/autopilot_emit_status`](tools/autopilot_emit_status.md) |
| `tools/s2-corpus-rehearsal/candidate-worker.ts` | [`tools/s2-corpus-rehearsal`](tools/s2-corpus-rehearsal.md) |
| `tools/s2-corpus-rehearsal/cli.ts` | [`tools/s2-corpus-rehearsal`](tools/s2-corpus-rehearsal.md) |
| `tools/s2-corpus-rehearsal/contracts.ts` | [`tools/s2-corpus-rehearsal`](tools/s2-corpus-rehearsal.md) |
| `tools/s2-corpus-rehearsal/release-gate.ts` | [`tools/s2-corpus-rehearsal`](tools/s2-corpus-rehearsal.md) |
<!-- GENERATED:read-before-edit END -->
