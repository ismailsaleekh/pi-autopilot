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
| "Autopilot roster setup is required" | No explicit/trusted-project/user roster authority is selectable | Use the activated setup lane only for inspection/proposal. Current W4 offline packs and custom trust pins are blocked, so do not treat a seed or custom draft as launch authority. |
| "roster resolution failed closed" | Higher-precedence roster authority is corrupt, untrusted, unavailable, non-launchable, or transition-stale | Repair the exact authority named in the diagnostic; lower-precedence defaults are intentionally not consulted. |
| "cannot enforce parent model roster" | Selected parent request profile is unavailable or not exactly settable/observable | Ensure the selected provider/model/thinking/API route is supported; see [roster onboarding](../subsystems/roster-onboarding.md). |
| "post-cutover activation requires a durable coordinator session" | Activating post-cutover without a session | Start via `/autopilot`/`/autopilot-inject` so the durable supervisor attaches first. |
| "migration-recovery-required" fence on activation | Ambiguous imported authority pending | Use the explicit `recovery` commands ([crash-recovery](../operations/crash-recovery.md)); ordinary activation stays disabled until resolved. |

## Child runner (`autopilot-agent-run`)

| Exit | Failure class | Fix |
|---|---|---|
| 2 | `spec-invalid` | Fix the unit spec against `autopilot.unit_spec.v2` roster identity/request-profile fields plus Quality vNext fields; historical v1 is byte-faithful evidence only. |
| 3 | `waiting-for-peer-release` | A peer holds a blocking EXCLUSIVE; wait for the durable release/offer — no operator action. |
| 10 | `pi-spawn-failed` | Check `--pi-executable` / Pi availability and the exact requested provider/model/thinking/API route. |
| 20 / 21 | `missing-structured-output`/`invalid-structured-output` | The child must emit exactly one valid `autopilot_emit_status` carrier; assistant text alone is rejected. |
| 30 | `status-non-success` | The unit reported a non-success verdict; read the status + audit. |
| 31 | `runtime-commit-failed` | Inspect the unit worktree / execution-commit evidence. |

## Parent terminal delivery

| Symptom | Cause | Behavior |
|---|---|---|
| `rejection:host-terminal:...` | Exact terminal correlation, Core transport, or follow-up effect application failed | Host emits the bounded machine status before operator prose and rethrows. Preserve the failed run for forensics; never resume it or let the parent model implement work directly. |
| "Status publication failed" | The terminal path failed and Pi also rejected its machine-status entry | Host reports both failures through non-triggering operator prose and rethrows the original terminal error; treat the run as failed and preserve it. |
| Durable background completion notice appears but no parent turn starts | Expected Autopilot behavior | EventBus terminal delivery advances Core directly. Autopilot-owned tasks use `notifyOnCompletion: true` and `triggerOnCompletion: false`; generic operator tasks remain unchanged. |
| Central `control.bg-run-exact.v1` rejection before launch | A package descriptor disabled durable notification, enabled parent triggering, or drifted from the issued bytes | Treat as a package defect. Do not rewrite the descriptor in Host or bypass the exact admission boundary. |

## Semantic recovery

| Symptom | Cause | Behavior |
|---|---|---|
| `planning:recovery-required` | First complete plan review found a correctable semantic/quality defect | One fresh Recovery Engineer receives original authority, canonical work map, complete rejected review, and repository evidence; repaired work map returns to unchanged full review. |
| `delivery:recovery-required` or `validation:recovery-required` | Delivery reported `semantic-repairable`, Core mechanically reconciled a bounded pre-effect unapproved-command denial with nonempty in-scope work, or the first forward validator found a correctable defect | One Recovery Engineer investigates in the original lane worktree under the original unit scope; normal delivery admission, Core-owned packaging, and independent round-two validation remain mandatory. Core never auto-adopts the blocked work. |
| `delivery-recovery-inadmissible:Some(RequiresNewAuthority)` | No qualifying pre-effect unknown-command-id denial, no in-scope work, overflowed/malformed audit, path-policy denial, or a genuine authority gap | Preserve the carrier and audit. Do not restore Bash, widen tools, or relabel from prose. New authority requires an operator decision; only exact mechanical reconciliation may issue the one Recovery Engineer. |
| `delivery-recovery-unsafe:AgentGitMutation` or `HardBoundaryViolation` | HEAD moved or dirty paths escaped approved unit scope | Halt the lane. A denied request never overrides effected Git mutation or out-of-scope residue. |
| `recovery resume assessment drift` | Worktree HEAD/path/content/mode facts changed after the durable pending-recovery event | Fail closed and preserve both snapshots; never replay against changed bytes. |
| `recovery-exhausted` | Recovery delivery blocked, or unchanged rereview/round-two validator still rejects | Run remains fail-closed with original and recovery evidence preserved; no second semantic repair loop is issued. |
| `planning-recovery-fail-closed` or `delivery-recovery-unsafe` | Recovery independently found missing authority, infrastructure, or unsafe residue instead of an admissible repair | Typed disposition and evidence are preserved; the original gate does not run and operator/infrastructure authority must resolve the boundary. |
| Provider/auth/timeout/disk failure | Infrastructure rather than prior-agent semantic output | Never route to Recovery Engineer; use the existing typed transient/paused/unsafe lane. |
| Child requests a shell diagnostic or cannot find a command id | Delivery interface/assignment drift, or the requested operation was never approved | Delivery roles have no Bash. Use read/grep/find/ls for inspection and only listed ids with `autopilot_run_approved_command`; unknown ids are denied pre-effect. Never whitelist diagnostics. |
| Child tries to execute a committed-tip check before Core packages | Plan encoded Core-owned state as child shell instead of `package_checks` | Treat as a planning authority defect. Fresh plans must use `clean-exact-package-tip`; legacy/missing package-check fields fail closed rather than defaulting. |

## Close / abort

| Symptom | Cause | Fix |
|---|---|---|
| Close reports blockers and does not land | Unmet precondition (validation staleness, post-transition validation requirement, reservation repair, dirty/running/quarantined units, foreign target intersection) | Resolve each named blocker; re-run `--dry-run`. See [close-lifecycle](../subsystems/close-lifecycle.md). |
| Abort refuses | Dirty source paths | Clean or capture the dirty paths first. |

## Coordinator

| Symptom | Cause | Fix |
|---|---|---|
| Coordination command errors loudly | Coordinator unavailable / IPC error | Inspect with `autopilot-coordinator doctor`; retry only the same idempotency key when the failure lane says so. |
| `recovery-required`, `git-partial-effect`, `disk-failure`, or `permission-denied` | Owner-scoped progress lane retained durable state | Let the owning run/recovery attachment reconcile the named item; do not stop unrelated runs or delete foreign paths. |
| `store-corrupt` or `system-fatal` | Authority-critical local/store boundary failed | Halt that exact boundary and recover only from verified durable authority. |
| Docs gate fails (C0–C11) | Docs drifted from code | Run `npm run docs:generate` then `npm run docs:attest`; see [docs-freshness-gate](../subsystems/docs-freshness-gate.md). |
| `ROSTER_QUALIFICATION_REQUIRED` | Current candidate or custom draft is structural/non-certifying evidence only | Wait for package-reviewed live W3 evidence pins and trusted certified roster hashes in the provider or custom trust registry. |
| `ROSTER_PINNED_SELECTION_UNAVAILABLE` | Existing-run selection, mirror, or pinned roster bytes cannot be authenticated | Recover the exact pinned artifacts; do not onboard a replacement for an existing run. |
| `ROSTER_TRANSITION_REQUIRED` | Existing-run roster change requires explicit transition authority | Review/approve only the exact transition presentation, then retry the original `/autopilot` command. |

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

Never route child work through paid/metered frontier APIs. Roster diagnostics are not
permission to use OpenRouter, arbitrary API keys, or unpinned provider guesses. If a
symptom seems to demand a silent fallback, that is a bug — Autopilot fails loud by
design.

## Related

- [`../operations/crash-recovery.md`](../operations/crash-recovery.md)
- [`../subsystems/runner-and-forced-output.md`](../subsystems/runner-and-forced-output.md)
- [`../subsystems/roster-onboarding.md`](../subsystems/roster-onboarding.md)
