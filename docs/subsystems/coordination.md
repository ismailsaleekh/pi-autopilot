---
doc_id: subsystems/coordination
mode: mixed
review_policy: behavioral
covers_surfaces:
  - /autopilot-coordination
  - autopilot_respond_claim_request
  - autopilot-coordinator
covers_sources:
  - src/core/coordination/index.ts
  - src/core/coordination/admission.ts
  - src/core/coordination/deadlock.ts
signature_hash: 'sha256:7dcfdcc868f120781150ae32025fae87d3b683d3a8f20a6a4c29665c6fafa656'
body_hash: 'sha256:4c39eddae3f6182bf47cfb73b4472158c477ced0099020f4a742b6812c918466'
fact_pins:
  - text: `MAX_GRANT_BYPASSES` is 8
    symbol: 'src/core/coordination/deadlock.ts#MAX_GRANT_BYPASSES'
    expect: 8
stability: stable
---

# Coordination Fabric

The Coordination Fabric is the local, transactional substrate that lets independent
Autopilot runs coordinate without an operator. It is exposed to agents through the
`/autopilot-coordination` command, the `autopilot_respond_claim_request` parent
tool, and the `autopilot-coordinator` CLI. Wire lineage is protocol 1.6 / API schema
12 / private store schema 13, behind the `1.1.8-cf50` façade.

## Purpose

Give every Autopilot run durable ownership of its claims, worktrees, and terminal
state, and resolve contention (release/defer, offers, deadlocks) mechanically. Only
a proven contradiction between authoritative task plans may become an operator
question; everything else — claims, offline peers, stale sessions, dirty worktrees,
merge conflicts, deadlocks — is an autonomous runtime state.

## Key files

The authoritative barrel is [`src/core/coordination/index.ts`](../read-before-edit.md),
which re-exports every fabric module. This doc's `covers_sources` transitively covers
the whole `src/core/coordination/**` tree for coverage purposes (C8); the two
invariant-bearing files below are called out because their behavior is load-bearing.

| Concern | Source |
|---|---|
| Admission / HMAC handshake | `src/core/coordination/admission.ts` |
| Wait-for graph + deadlock resolution | `src/core/coordination/deadlock.ts` |
| Transactional store | `src/core/coordination/store.ts` |
| Single-writer IPC server | `src/core/coordination/server.ts` |
| Durable run supervisor + session bridge | `src/core/coordination/supervisor.ts` |
| Peer claim negotiation | `src/core/coordination/negotiation.ts` |

## Admission (S1 / cf50)

Every socket begins with the exact cf50 empty handshake. An unchanged cf50 peer
stays `legacy-anonymous-protocol-1.6` and receives only cf50 actions. An S1 peer
follows handshake → `negotiate-admission` → operation on one socket and becomes
`negotiated-s1` only after verifying a domain-separated HMAC-SHA256 (algorithm
`hmac-sha256`, domain `pi-autopilot/admission/v1\0`) over canonical JSON, using the
raw 32-byte capability key. When no offer is present, the S1 client accepts only the
exact digest-pinned `known-cf50-predecessor` path; it never infers compatibility
from semver or protocol alone, and never falls back after an offered negotiation
fails.

## Deadlock resolution (invariants)

The fabric persists a transactional wait-for edge for every live blocking request
and resolves strongly connected cycles to a same-transaction fixed point.

- **Age never authorizes release.** Expired heartbeats are classification evidence
  only; they never satisfy a terminal condition or release ambiguous
  WRITE/EXCLUSIVE authority.
- **Safe victims are selected mechanically** by victim class, durable child
  checkpoint, starvation protection, live-cycle grant order, and stable identity.
  Merge/reset/quarantine/archive/remove critical sections, dirty preflight
  worktrees, and non-preemptible running work are never cancelled as clean victims.
- **Starvation is bounded.** A group's `bypass_count` increments exactly once per
  otherwise-eligible losing decision, and `MAX_GRANT_BYPASSES` is 8: at that bound a
  group takes priority over newer groups whenever its complete set is free.
- **No-safe-victim cycles stay explicit.** They remain `deferred-no-safe-victim` at
  the earliest declared release condition and never become operator questions.

## Entry points

- `/autopilot-coordination status|doctor` — read-only inspection of durable runs,
  leases, observations, reservations, wait edges, and pending recovery work. See
  [`../commands/autopilot-coordination.md`](../commands/autopilot-coordination.md).
- `autopilot_respond_claim_request` — parent tool to `release-now` or bounded-defer
  a peer's claim request; only a live current-generation owner may respond.
- `autopilot-coordinator` — the compiled local broker CLI (serve/status/doctor/
  export/replay/migrate/verify/rollback/cutover/recovery). See
  [`../cli/autopilot-coordinator.md`](../cli/autopilot-coordinator.md).

## Invariants that must not regress

1. Every operation handshakes and executes on **one** socket; multiple or
   unsolicited response frames fail loud.
2. WRITE/EXCLUSIVE release is authorized only by stronger Git-backed terminal
   evidence, never by age, PID, or timestamp.
3. Coordinator startup replays durable terminal facts to repair a transition
   interrupted by an older process; it never fabricates or drops a row.
4. The single-writer election is endpoint-attested: identity drift fails closed;
   endpoint recovery always wins over replacement.
