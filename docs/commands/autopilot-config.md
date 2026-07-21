---
doc_id: commands/autopilot-config
mode: authored
review_policy: contract
covers_surfaces:
  - /autopilot-config
covers_sources:
  - src/core/scheduler-config.ts
signature_hash: 'sha256:77ba52d4e6714f14c69e74f568dbe65098d678845965e91e0e96ab9d9c04d55c'
body_hash: 'sha256:b26c2893078435ac600005e61e86901c28f21fa885cd14b055c59cb17689edea'
fact_pins:
  - text: default `parallel_cap` is 8
    symbol: 'src/core/scheduler-config.ts#AUTOPILOT_DEFAULT_PARALLEL_CAP'
    expect: 8
stability: stable
---

# `/autopilot-config`

Show or update the active workstream's scheduler config.

## Synopsis

`/autopilot-config show | parallel-cap <n>`

## Behavior

- `show` prints the active workstream scheduler config.
- `parallel-cap <n>` persists `parallel_cap` in the range `1..32` under
  `.pi/autopilot/<workstream>/scheduler-config.json`; the default `parallel_cap` is 8.

Requires an active Autopilot workstream in the session (start with `/autopilot` or
`/autopilot-inject`).

## State written

`.pi/autopilot/<workstream>/scheduler-config.json` (schema
`autopilot.scheduler_config.v1`).

## Failure classes

No active workstream → warning. Out-of-range cap → validation error naming the
`1..32` range.

## Related

- Defaults table: [`../INDEX.md`](../INDEX.md#default-constants)
