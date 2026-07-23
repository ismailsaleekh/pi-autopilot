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
| "Autopilot roster setup is required" | No explicit/trusted-project/user roster authority is selectable | Use the activated setup lane only for inspection/proposal. Current W4 offline packs are blocked or non-certifying, so do not treat a seed candidate as launch authority. |
| "roster resolution failed closed" | Higher-precedence roster authority is corrupt, untrusted, unavailable, or non-launchable | Repair the exact authority named in the diagnostic; lower-precedence defaults are intentionally not consulted. |
| "cannot enforce parent model roster" | Selected parent request profile is unavailable or not exactly settable/observable | Ensure the selected provider/model/thinking/API route is supported; see [roster onboarding](../subsystems/roster-onboarding.md). |
| "post-cutover activation requires a durable coordinator session" | Activating post-cutover without a session | Start via `/autopilot`/`/autopilot-inject` so the durable supervisor attaches first. |
| "migration-recovery-required" fence on activation | Ambiguous imported authority pending | Use the explicit `recovery` commands ([crash-recovery](../operations/crash-recovery.md)); ordinary activation stays disabled until resolved. |

## Child runner (`autopilot-agent-run`)

| Exit | Failure class | Fix |
|---|---|---|
| 2 | `spec-invalid` | Fix the unit spec against `autopilot.unit_spec.v2` roster identity/request-profile fields plus Quality vNext fields; historical v1 is byte-faithful evidence only. |
| 3 | `waiting-for-peer-release` | A peer holds a blocking EXCLUSIVE; wait for the durable release/offer — no operator action. |
| 10 | `pi-spawn-failed` | Check `--pi-executable` / Pi availability and the exact requested provider/model/thinking/API route. |
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
| `ROSTER_QUALIFICATION_REQUIRED` | Current candidate is structural/non-certifying evidence only | Wait for package-reviewed live W3 evidence pins and trusted certified roster hashes in the W4 provider registry. |
| `ROSTER_PINNED_SELECTION_UNAVAILABLE` | Existing-run selection, mirror, or pinned roster bytes cannot be authenticated | Recover the exact pinned artifacts; do not onboard a replacement for an existing run. |

## Golden rule

Never route child work through paid/metered frontier APIs. Roster diagnostics are not
permission to use OpenRouter, arbitrary API keys, or unpinned provider guesses. If a
symptom seems to demand a silent fallback, that is a bug — Autopilot fails loud by
design.

## Related

- [`../operations/crash-recovery.md`](../operations/crash-recovery.md)
- [`../subsystems/runner-and-forced-output.md`](../subsystems/runner-and-forced-output.md)
- [`../subsystems/roster-onboarding.md`](../subsystems/roster-onboarding.md)
