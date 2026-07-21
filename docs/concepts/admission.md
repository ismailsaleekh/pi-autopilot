---
doc_id: concepts/admission
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Concept: S1 / cf50 Admission

The coordinator serves two peer vocabularies on one socket: the frozen legacy `cf50`
façade and the current `S1` protocol. Admission is how a peer is safely classified.

## Identity separation

| Facet | Value |
|---|---|
| Truthful implementation build | `1.2.0-s1` |
| Wire lineage | `protocol-1.6-api-schema-12` |
| API schema | 12 |
| Private store schema | 13 |
| Legacy façade build | `1.1.8-cf50` |

## Handshake → negotiate → operate

Every socket begins with the exact cf50 empty handshake.

- An **unchanged cf50 peer** stays `legacy-anonymous-protocol-1.6` and receives only cf50
  actions and response grammar.
- An **S1 peer** follows `handshake → negotiate-admission → operation` on one socket and
  becomes `negotiated-s1` only after verifying a domain-separated HMAC-SHA256 (algorithm
  `hmac-sha256`, domain `pi-autopilot/admission/v1\0`) over canonical JSON, using the raw
  32-byte capability key.

The attestation binds both actual builds, requested/granted vocabulary, nonce, lifecycle
identity, exact legacy-lock/runtime-sidecar byte digests, and store generation.

## No silent compatibility

When no offer is present, the S1 client accepts only the exact digest-pinned
`known-cf50-predecessor` path. It never infers compatibility from semver or protocol
alone, and never falls back after an offered negotiation fails. A live actual cf50
coordinator remains authoritative and serves both cf50 and S1 clients until it exits
naturally; elected S1 startup may publish only after that exact predecessor retires and
the writer/migration authority checks succeed.

## Enforced in

- `src/core/coordination/admission.ts`,
  `src/core/coordination/negotiated-transport.ts`,
  `src/core/coordination/peer-classification.ts`,
  `src/core/coordination/peer-admission-state.ts`.

## Related

- [generations-and-fencing.md](generations-and-fencing.md), [migration-cutover.md](migration-cutover.md)
- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
