---
doc_id: commands/autopilot-config
mode: authored
review_policy: contract
covers_surfaces:
  - /autopilot-config
covers_sources:
  - src/core/scheduler-config.ts
signature_hash: 'sha256:43e8155a67fbd7eb33da2c6adc12bfff0250e9c25e80e1daf6daf1ebb8f393c8'
body_hash: 'sha256:135f1e5ef634a74c4cd2bbafdf1b015ecf7e939509d2c2e488e209f79429c304'
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
- A D65 run is further constrained by its coordinator-authenticated launch policy:
  its cap remains exactly `1`, and a config write that attempts to exceed that policy
  fails `launch-policy-cap-unauthorized` rather than weakening the package default or
  treating prose as capacity authority.

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
