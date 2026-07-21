---
doc_id: tools/autopilot_respond_claim_request
mode: authored
review_policy: contract
covers_surfaces:
  - autopilot_respond_claim_request
covers_sources: []
stability: stable
---

# `autopilot_respond_claim_request`

The parent claim-response tool, exposed only after authenticated run-supervisor
attachment.

## Signature

Resolves the current version by exact request id, proves the attached run is the
durable owner, and submits either `release-now` or a bounded defer to a
package-observable terminal condition.

## Availability

Parent session only, and only while a durable run supervisor is attached. It is
deactivated when the session bridge detaches.

## Effects / authority

Release, release evidence, and requester notification commit atomically; the
coordinator then re-evaluates complete groups in deterministic order and issues one
incompatible 30-second `grant-ready` offer at a time. Only a live current-generation
requester preflight can acknowledge that offer.

## Failure classes

A non-owner, stale-generation, or unknown-request response is rejected loudly; age
never authorizes release.

## Related

- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
