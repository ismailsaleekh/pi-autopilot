---
doc_id: subsystems/runner-and-forced-output
mode: authored
review_policy: behavioral
covers_surfaces:
  - autopilot-agent-run
  - autopilot_emit_status
covers_sources:
  - src/core/agent-runner.ts
  - src/core/authority.ts
  - src/core/scheduler.ts
  - src/core/unit-failure.ts
  - src/core/forced-output/index.ts
  - src/core/execution-audit/index.ts
  - src/core/prompt-renderer/index.ts
  - src/core/model-roster.ts
signature_hash: 'sha256:3c5ed87502e9c35a04031217852cd706873011bba1277cd9546e03ced7a603d6'
body_hash: 'sha256:12cca05d67aab27398f47def55526f71038ed5ac79c2c537c3832317a59d7d19'
stability: stable
---

# Runner, Forced Output, and Execution Audit

How a child unit is scheduled, launched, forced to emit structured status, and audited
before its result is accepted. The child runner CLI is documented at
[`../cli/autopilot-agent-run.md`](../cli/autopilot-agent-run.md); this subsystem covers
the runtime behind it.

## Key files

| Concern | Source |
|---|---|
| Wrapper runtime around Pi RPC spawn | `src/core/agent-runner.ts` |
| Repository-grounded authority derivation | `src/core/authority.ts` |
| Deterministic dispatch planning + cap | `src/core/scheduler.ts` |
| Failed-unit quarantine/reset reconciliation | `src/core/unit-failure.ts` |
| Receipt/hash/status carrier validation | `src/core/forced-output/index.ts` |
| Actual-change/audit helpers | `src/core/execution-audit/index.ts` |
| Template loading/filling/validation | `src/core/prompt-renderer/index.ts` |
| D65 graph/policy/heartbeat dispatch gate | `src/core/coordination/d65-runtime-dispatch.ts` |

## Scheduler

Within one workstream, file-disjoint dependency-cleared units run in parallel up to
`parallel_cap` — only through per-unit worktrees. Shared-file, stale-validation risk,
or a durable S2 pressure pause for this run reduces the batch rather than weakening
quality; a pressure pause for another run is not a scheduler blocker. Skips use the
explicit `waiting-for-peer-release` state and retain exact request refs. See the
[defaults table](../INDEX.md#default-constants) for `parallel_cap`. A D65 run carries a
signed launch policy whose cap fields are authenticated as exactly one; the runtime
gates child-model spawn and other ordinary boundaries on the accepted complete-graph /
policy / heartbeat tuple, and any semantic event fences ordinary dispatch until the
mandatory successor graph is accepted. Note: the signed cap fields are enforced as an
authenticated tuple; the scheduler dispatch planner and prospective child-registration
transition are not yet independently capped to one by the merged consumers.

## Authority derivation

Before child launch, scheduler and runner derive one persisted `autopilot.authority.v1`
artifact from the exact worktree commit: WRITE edit intentions for `owned_paths`, exact
commit/blob/tree observations for tracked `read_only_paths` + context/inspection refs,
and any package-declared bounded EXCLUSIVE operation. Prose/untracked observations and
ungrounded future-owned edits are rejected. WRITE scope never expands silently: a child
needing a new edit path must emit a blocker.

## Forced output (the success contract)

Success requires exactly one valid `autopilot_emit_status` carrier plus status and
receipt evidence. On completion the runner:

1. accepts matching status + receipt + receipt-matching structured tool carrier,
2. writes an `autopilot.execution_audit.v1` record under `execution-audits/`,
3. revalidates success statuses against the audit before transport acceptance —
   assistant text alone is rejected.

Execution audits include committed-path deltas when a child creates in-worktree commits;
`autopilot.execution_commit.v1` captures runtime-created, child-created, or mixed commit
ranges on the unit branch.

## Failure classes

`spec-invalid`, `waiting-for-peer-release`, `pi-spawn-failed`, `missing-structured-output`,
`invalid-structured-output`, `status-non-success`, `runtime-commit-failed`. Dirty
baselines are attribution blockers only when they overlap unit-owned or protected
surfaces; unrelated dirty paths are recorded as audit caveats. D65 authority failures
are fail-closed graph, launch-policy, heartbeat, or recovery-transition failures; they
never fall through to model execution.

## Model roster

The forced-output identity layer recognizes subscription Pi routes under
`openai-codex/*`, `anthropic/*`, `opencode-go/*`, `kimi-coding/*`, and `zai/*`, but the
fixed launch roster is stricter: only the three documented `openai-codex/gpt-5.6-*`
assignments. Any role/model/thinking mismatch is rejected before child launch;
OpenRouter and other metered frontier routes remain forbidden. See the
[model roster](../INDEX.md#model-roster).

## Related

- CLI: [`../cli/autopilot-agent-run.md`](../cli/autopilot-agent-run.md)
- Tool: [`../tools/autopilot_emit_status.md`](../tools/autopilot_emit_status.md)
- Concept: [`../concepts/leases-and-observations.md`](../concepts/leases-and-observations.md)
