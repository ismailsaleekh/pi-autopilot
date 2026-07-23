---
doc_id: troubleshooting/failures
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Troubleshooting: Symptom → Cause → Fix

All Autopilot failures are loud and typed. Match the symptom, then follow the pointer.

## Activation

| Symptom | Cause | Fix |
|---|---|---|
| "cannot enforce parent model roster" | Roster model/auth/thinking unavailable | Ensure the `openai-codex/gpt-5.6-*` subscription route + exact thinking level is available; see [model roster](../INDEX.md#model-roster). |
| "post-cutover activation requires a durable coordinator session" | Activating post-cutover without a session | Start via `/autopilot`/`/autopilot-inject` so the durable supervisor attaches first. |
| "migration-recovery-required" fence on activation | Ambiguous imported authority pending | Use the explicit `recovery` commands ([crash-recovery](../operations/crash-recovery.md)); ordinary activation stays disabled until resolved. |

## Child runner (`autopilot-agent-run`)

| Exit | Failure class | Fix |
|---|---|---|
| 2 | `spec-invalid` | Fix the unit spec against `autopilot.unit_spec.v1` + Quality vNext fields. |
| 3 | `waiting-for-peer-release` | A peer holds a blocking EXCLUSIVE; wait for the durable release/offer — no operator action. |
| 10 | `pi-spawn-failed` | Check `--pi-executable` / Pi availability. |
| 20 / 21 | `missing-structured-output`/`invalid-structured-output` | The child must emit exactly one valid `autopilot_emit_status` carrier; assistant text alone is rejected. |
| 30 | `status-non-success` | The unit reported a non-success verdict; read the status + audit. |
| 31 | `runtime-commit-failed` | Inspect the unit worktree / execution-commit evidence. |

## Close / abort

| Symptom | Cause | Fix |
|---|---|---|
| Close reports blockers and does not land | Unmet precondition (validation staleness, reservation repair, dirty/running/quarantined units, foreign target intersection) | Resolve each named blocker; re-run `--dry-run`. See [close-lifecycle](../subsystems/close-lifecycle.md). |
| Abort refuses | Dirty source paths | Clean or capture the dirty paths first. |

## Coordinator

| Symptom | Cause | Fix |
|---|---|---|
| Coordination command errors loudly | Coordinator unavailable / IPC error | Inspect with `autopilot-coordinator doctor`; retry only the same idempotency key when the failure lane says so. |
| `recovery-required`, `git-partial-effect`, `disk-failure`, or `permission-denied` | Owner-scoped progress lane retained durable state | Let the owning run/recovery attachment reconcile the named item; do not stop unrelated runs or delete foreign paths. |
| `store-corrupt` or `system-fatal` | Authority-critical local/store boundary failed | Halt that exact boundary and recover only from verified durable authority. |
| Docs gate fails (C0–C11) | Docs drifted from code | Run `npm run docs:generate` then `npm run docs:attest`; see [docs-freshness-gate](../subsystems/docs-freshness-gate.md). |

## S2 coordination failure lanes

Every `CoordinationRuntimeError` is mapped to a deterministic S2 decision. Authority-
critical lanes fail closed at the exact named scope; progress-critical lanes preserve
other runs and require evidence before repair/retry.

| Code | Criticality | Retry policy | Exact scope / operator action |
|---|---|---|---|
| `invalid-request` | authority | never | Reject only the bad request envelope/operation identity; caller may submit a corrected new operation. |
| `invalid-state` | authority | after reconciliation | Keep the invariant-broken coordinator entity set closed until accepted reconciliation publishes a successor. |
| `protocol-mismatch` | authority | never | Close the single incompatible connection/negotiation attempt. |
| `schema-mismatch` | authority | never | Refuse the client/store schema boundary; use an exact accepted lineage. |
| `frame-too-large` | authority | never | Reject the oversized IPC frame/request; page or externalize evidence. |
| `unauthorized-client` | authority | never | Deny the failed capability/identity proof connection with secrets redacted. |
| `coordinator-unavailable` | progress | same idempotency key | Re-attest/restart endpoint locally and retry the same request without releasing claims or replacing unrelated runs. |
| `coordinator-contention` | progress | same idempotency key | Retry the contended transaction identity after bounded backoff. |
| `fenced-session` | authority | after reattach | Fail the stale session generation; reattach to the current durable generation. |
| `stale-version` | authority | same idempotency key | Reread the entity version and retry only the still-valid intended operation identity. |
| `idempotency-conflict` | authority | never | Return the original/conflict proof; never apply the second request. |
| `request-timeout` | progress | same idempotency key | Retry the same idempotency key and inspect committed sequence before related work. |
| `recovery-required` | progress | after reconciliation | Owning supervisor reconciles the durable recovery item before resuming. |
| `git-partial-effect` | progress | after reconciliation | Complete or compensate the owner saga from postconditions; never infer success from exit. |
| `disk-failure` | progress | after reconciliation | Retry only after capacity/I/O evidence changes and retained intent remains current. |
| `permission-denied` | progress | after reconciliation | Repair permissions for the owner path; never alter a foreign run path. |
| `planning-contradiction-review` | authority | never | Pause only the contradictory planning authority set pending explicit operator decision. |
| `store-corrupt` | authority | never | Safety halt the corrupt store; no mutable legacy fallback. |
| `system-fatal` | authority | never | Halt the named local runtime boundary until externally repaired and reverified. |

## Golden rule

Never route child work through paid/metered frontier APIs. If a symptom seems to demand
a silent fallback, that is a bug — Autopilot fails loud by design.

## Related

- [`../operations/crash-recovery.md`](../operations/crash-recovery.md)
- [`../subsystems/runner-and-forced-output.md`](../subsystems/runner-and-forced-output.md)
