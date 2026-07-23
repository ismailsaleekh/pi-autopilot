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
  - src/core/coordination/runtime-constants.ts
  - src/core/coordination/peer-classification.ts
  - src/core/coordination/client.ts
  - src/core/coordination/store.ts
  - src/core/coordination/invariants.ts
signature_hash: 'sha256:f2ccef5dd32315d6976da8c480b9f584d06e945cf776852a923f7811810c59ac'
body_hash: 'sha256:2c4020b8a25089c33a3db862bc1fd1b93ed65a38b3e1530eae1f1843abe85101'
semantic_attestation: 'sha256:2c4020b8a25089c33a3db862bc1fd1b93ed65a38b3e1530eae1f1843abe85101'
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
tool, and the `autopilot-coordinator` CLI. `runtime-constants.ts` fixes the identities:
`COORDINATOR_WIRE_LINEAGE = 'protocol-1.6-api-schema-12'` (with
`COORDINATOR_API_SCHEMA_VERSION = 12`) and the separately tracked
`COORDINATOR_STORE_SCHEMA_VERSION = 13`, behind the
`COORDINATOR_LEGACY_FACADE_BUILD = '1.1.8-cf50'` façade.

## Purpose

Give every Autopilot run durable ownership of its claims, worktrees, and terminal
state, and resolve contention (release/defer, offers, deadlocks) mechanically. Only
a proven contradiction between authoritative task plans may become an operator
question; everything else — claims, offline peers, stale sessions, dirty worktrees,
merge conflicts, deadlocks — is an autonomous runtime state.

## Key files

The authoritative barrel is [`src/core/coordination/index.ts`](../read-before-edit.md),
which re-exports the fabric's public modules (the `d65-*` modules are internal and are
not re-exported through this barrel). For C8 boundary-coverage purposes this hub's
covered barrel stands in for the tree. This hub's
`covers_sources` names the specific invariant-bearing files whose exact facts it asserts
(admission, deadlock, wire-lineage constants, peer classification, client, store,
invariants); the D65 authority files are documented and independently reviewed in their
dedicated concept docs (linked below), not re-derived here.

| Concern | Source |
|---|---|
| Admission / HMAC handshake | `src/core/coordination/admission.ts` |
| Wait-for graph + deadlock resolution | `src/core/coordination/deadlock.ts` |
| Transactional store | `src/core/coordination/store.ts` |
| Single-writer IPC server | `src/core/coordination/server.ts` |
| Durable run supervisor + session bridge | `src/core/coordination/supervisor.ts` |
| Peer claim negotiation | `src/core/coordination/negotiation.ts` |
| D65 complete semantic graph | `src/core/coordination/d65-semantic-graph.ts`, `src/core/coordination/d65-graph-loader.ts` |
| D65 signed launch policy + heartbeat | `src/core/coordination/d65-launch-policy.ts`, `src/core/coordination/d65-heartbeat-gate.ts` |
| D65 successor/recovery publication | `src/core/coordination/d65-graph-successor-runtime.ts`, `src/core/coordination/d65-graph-publisher.ts` |

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

## D65 semantic authority

Current-build D65 runs bootstrap from immutable Git authority and then operate only
against a coordinator-accepted complete semantic graph. The graph binds core runtime
documents, authority/evidence collections, exact queue equations, coordinator
projections, transition replay, and the prior graph/event tuple. Publication is a
crash-resumable Git G/H plus coordinator registration saga: database registration
commits before the filesystem residue advances from `publication-committed` to
`registered`, and response-loss recovery accepts only the byte-identical registered
result.

The coordinator verifies the single accepted signed launch policy (D65 authorizes only
absent→v1 and requires exactly one accepted `autopilot.launch_policy.v1`; an existing
accepted policy is a CAS conflict) and a session-authenticated, monotonic program
heartbeat at the wired runtime boundaries
(child/model spawn and other consumed ordinary boundaries). The policy binds
package/run/graph/roster identity and cap-one limits. Provider failure recovery
uses an accepted continuation, externally signed one-use subscription probe, exact
failed spec/receipt identity, successor graph, and governing retry-authorized
heartbeat; no component self-signs operator authority or substitutes a provider.
Every semantic mutation requires its successor graph before ordinary re-entry, except
the closed prepared-terminal tail. The exact graph/dispatch/terminal contracts are
documented and independently reviewed in
[`../concepts/semantic-graph-authority.md`](../concepts/semantic-graph-authority.md),
[`../concepts/dispatch-and-recovery-authority.md`](../concepts/dispatch-and-recovery-authority.md),
and [`../concepts/d65-terminal-tail.md`](../concepts/d65-terminal-tail.md).

## Deadlock resolution (invariants)

The fabric persists a transactional wait-for edge for every live blocking request
and resolves strongly connected cycles to a same-transaction fixed point.

- **Age never authorizes release.** Expired heartbeats are classification evidence
  only; they never satisfy a terminal condition or release ambiguous
  WRITE/EXCLUSIVE authority.
- **Safe victims are selected mechanically** by victim class, durable child
  checkpoint, starvation protection, live-cycle grant order, and stable identity.
  Any attempt holding an active `critical_section` or Git critical operation
  (`merge`, `reset`, `quarantine`, `archive`, `remove`, `metadata-reconcile`), dirty
  preflight worktrees, and non-preemptible running work are never cancelled as clean
  victims.
- **Starvation is bounded.** Victim ranking reads each live group's `bypass_count`
  (incremented by the scheduler's grant path), and `MAX_GRANT_BYPASSES` is 8: at that
  bound a group takes priority over newer groups whenever its complete set is free.
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

Invariant 2 is verifiable from this doc's covered sources (`store.ts`
`respondClaimRequest`, plus `deadlock.ts`/`invariants.ts`); invariants 1, 3, and 4 are
system-level contracts enforced across the broader coordinator implementation
(`negotiated-transport.ts`, `server.ts`, `supervisor.ts`, `store.ts` startup, and the
`s2-*` retention/GC modules) beyond the covered set and are stated here as top-level
contracts.

1. Every operation handshakes and executes on **one** socket; multiple or
   unsolicited response frames fail loud.
2. WRITE/EXCLUSIVE release is never authorized by age, PID, or timestamp. It is
   authorized either by stronger Git-backed terminal evidence, or by an authenticated
   `release-now`/bounded-defer response from the current-generation owner
   (`respondClaimRequest`), which is the deliberate live-owner release path.
3. Coordinator startup replays durable terminal facts to repair a transition
   interrupted by an older process; it never fabricates a row, and it drops rows only
   through its explicit reconciliation path (e.g. releasing an owned lease during
   startup recovery), never silently. Its owned
   timer also schedules S2 retention GC for terminal runs against only package-owned
   `_trash/` and `transition-backups/` candidates.
4. The single-writer election is endpoint-attested: identity drift fails closed;
   endpoint recovery always wins over replacement.
