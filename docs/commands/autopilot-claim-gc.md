---
doc_id: commands/autopilot-claim-gc
mode: authored
review_policy: contract
covers_surfaces:
  - /autopilot-claim-gc
covers_sources: []
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
