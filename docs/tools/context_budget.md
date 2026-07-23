---
doc_id: tools/context_budget
mode: authored
review_policy: behavioral
covers_surfaces:
  - context_budget
covers_sources:
  - src/core/context-budget.ts
signature_hash: 'sha256:4e147d6b32a3a88923a3b886d262a4384fb0dcd17c2d53412f2cf73e047c54f4'
body_hash: 'sha256:a2d8cd38e853fafe2788e23acfa84ce775d2100fe66c38c7de4940cb7316b38d'
semantic_attestation: 'sha256:a2d8cd38e853fafe2788e23acfa84ce775d2100fe66c38c7de4940cb7316b38d'
fact_pins:
  - text: default 85% halt threshold
    symbol: 'src/core/context-budget.ts#DEFAULT_CONTEXT_HALT_PERCENT'
    expect: 85
stability: stable
---

# `context_budget`

The parent-session tool activated by `/autopilot`.

## Signature

Takes no arguments. Returns a report with gate `ok`, `halt`, or `unknown`, plus
percent/tokens/contextWindow and the configured threshold.

## Availability

Parent session only (registered via `pi.registerTool`). It is not a child tool.

## Behavior

Reports the parent session's context-window usage against the
`default 85% halt threshold` (override via the `AUTOPILOT_CONTEXT_HALT_PERCENT` env
var, range `(0,100]`).

- `ok` — below the threshold: safe to start dependency-cleared, file-disjoint work.
- `halt` — at/above the threshold: start no new child work; drain running work; hand
  off.
- `unknown` — usage unavailable (e.g. right after compaction): treat as
  HALT-and-recheck.

The rendered parent prompt requires calling `context_budget` at the start of every
parent turn before reading or starting child work.

## Failure classes

An out-of-range configured threshold throws a `RangeError` (loud, no fallback).

## Related

- Command: [`../commands/autopilot.md`](../commands/autopilot.md)
- Defaults: [`../INDEX.md`](../INDEX.md#default-constants)
