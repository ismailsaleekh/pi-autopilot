---
doc_id: concepts/generations-and-fencing
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Concept: Generations, Session Fencing, and Run Ownership

Run ownership survives Pi session replacement. Claims belong to durable **run/unit**
identities; session **generations** only fence stale writers.

## Durable run supervisor + session bridge

`/autopilot` and `/autopilot-inject` attach one durable run supervisor per
`workstream_run`, then attach a Pi session at a **new fencing generation**, reconcile
owned durable state, and drain the durable mailbox before prompt dispatch. The bridge
starts only from activation, heartbeats while active, writes a private session-authority
context, and detaches on session shutdown.

## Unguessable lease capability

Every attached session has an unguessable lease capability **in addition to** its
generation, so PID reuse or possession of stale identity fields cannot impersonate
current authority.

## Handoff fencing

`/autopilot-handoff` defers fencing until the handoff artifacts are written and the
session shuts down. The old generation then becomes `handoff-pending`, and the
replacement attachment consumes that transition while preserving run/unit ownership.

## Child authority is process-bound

`autopilot-agent-run` must register a fenced child lease before model spend. The parent
session capability is consumed only by the runner preflight and is scrubbed before Pi
child spawn. The child then holds independent, process-bound derived authority, so it can
heartbeat and commit terminal or recovery-required state after a legitimate parent
handoff without granting the old parent session any mutation authority.

## Invariants

- Handoff must never create self-conflicting old-epoch claims.
- Heartbeat expiry is recovery evidence only and **never** releases WRITE authority.
- The parent bridge heartbeat retries transient coordinator outages
  (unavailable/contention/timeout) while the durable session lease remains valid, so a
  momentary socket blip does not strand authority; only fenced/invalid authority,
  incompatible contracts, system-fatal failures, or genuine lease expiry halt loudly.

## Enforced in

- `src/core/coordination/supervisor.ts`, `src/core/coordination/child-authority.ts`,
  `src/core/coordination/process-identity.ts`.

## Related

- [terminal-evidence.md](terminal-evidence.md), [admission.md](admission.md)
- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
