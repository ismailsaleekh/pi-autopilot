---
doc_id: commands/autopilot-claim-gc
mode: authored
review_policy: contract
covers_surfaces:
  - /autopilot-claim-gc
covers_sources:
  - src/core/claim-gc.ts
signature_hash: 'sha256:a6472737429f22fb020001b6c9985fed9fdfc6091a199da3d844a4e69cfe27f0'
body_hash: 'sha256:0e8c3dc93b046114d277d5adda933fab590ce3138d66a0fdf10bc8ca2c5815a8'
stability: stable
---

# `/autopilot-claim-gc`

Evidence-backed diagnosis/repair of legacy JSON migration inputs **only**.

## Synopsis

`/autopilot-claim-gc --dry-run|--apply`

## Behavior

Limited to legacy migration/diagnostic claim repair. Normal Fabric leases reconcile
automatically — this command is **not** the contention or terminal-release path.

- `--dry-run` (default) reports stale/blocked candidates without mutation.
- `--apply` performs evidence-backed release of legacy claims.

## State written

Diagnostic evidence artifact (when produced); legacy claim release under `--apply`.

## Failure classes

Blocked candidates are reported with their blockers; nothing is released without
evidence.

## Related

- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
