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
| 20 / 21 | `missing`/`invalid-structured-output` | The child must emit exactly one valid `autopilot_emit_status` carrier; assistant text alone is rejected. |
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
| Coordination command errors loudly | Coordinator unavailable / IPC error | Inspect with `autopilot-coordinator doctor`; the heartbeat retries transient outages while the lease is valid. |
| Docs gate fails (C0–C11) | Docs drifted from code | Run `npm run docs:generate` then `npm run docs:attest`; see [docs-freshness-gate](../subsystems/docs-freshness-gate.md). |

## Golden rule

Never route child work through paid/metered frontier APIs. If a symptom seems to demand
a silent fallback, that is a bug — Autopilot fails loud by design.

## Related

- [`../operations/crash-recovery.md`](../operations/crash-recovery.md)
- [`../subsystems/runner-and-forced-output.md`](../subsystems/runner-and-forced-output.md)
