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
  - src/core/coordination/unit-failure-producer-provenance.ts
  - src/core/forced-output/index.ts
  - src/core/execution-audit/index.ts
  - src/core/prompt-renderer/index.ts
  - src/core/model-roster.ts
signature_hash: 'sha256:8acfa22b78d0e3845a831af6c62744293cccc949d27fe4d836f1070d774dc3cf'
body_hash: 'sha256:45d4282adbfc80a75f2e065df39aee9f6b9f1ccd0d5cdc5653d9d45bc0dad611'
semantic_attestation: 'sha256:45d4282adbfc80a75f2e065df39aee9f6b9f1ccd0d5cdc5653d9d45bc0dad611'
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
| Current unit-failure producer provenance | `src/core/coordination/unit-failure-producer-provenance.ts` |
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
mandatory successor graph is accepted. The merged dispatch gate now enforces the cap:
`scheduler-dispatch` and `child-model-spawn` are ordinary boundaries that fence with
`cap-not-current` whenever the committed `cap_current` authority dimension is not
current (`ordinaryDispatchAllowed` in `d65-dispatch-predicates.ts`, exercised across
every ordinary boundary by `tests/unit/d65-dispatch-gate.test.ts`), and
`register-attempt` is a default-deny recovery cell. See
[dispatch-and-recovery-authority.md](../concepts/dispatch-and-recovery-authority.md).

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
surfaces; unrelated dirty paths are recorded as audit caveats.

Source-changing failed attempts are resolved through current `autopilot.unit_failure.v1`
evidence before edit authority is released. Current records carry centralized producer
provenance from `currentUnitFailureProducerProvenance()` — the coordinator
implementation build plus unit-failure producer generation `3` — and the same fields
are required when an existing current record is replayed idempotently. Quarantine and
preserve actions require an immutable capture commit/ref; reset and abort actions must
leave both capture fields null, bind the owned branch/common-dir/head facts, and assert
a clean postcondition. If publication discovers a recognized historical BUG-177
reset/abort evidence shape, the historical bytes are left untouched and replacement
current evidence is written at a deterministic `regenerated-from-<sha256>` path;
historical quarantine/preserve shapes do not authorize release because they lack an
exact capture ref. D65 authority failures are fail-closed graph, launch-policy,
heartbeat, or recovery-transition failures; they never fall through to model execution.

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
