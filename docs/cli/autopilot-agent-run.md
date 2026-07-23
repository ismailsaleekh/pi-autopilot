---
doc_id: cli/autopilot-agent-run
mode: mixed
review_policy: contract
covers_surfaces:
  - autopilot-agent-run
covers_sources:
  - src/cli/autopilot-agent-run.ts
signature_hash: 'sha256:6a2b2a4d670b47bf0757d6cd542538122a0183d625023be72212d51161cfee73'
body_hash: 'sha256:247c9228a410e7156c9762ed3b6315024520cb445f813ffb83f331a712ca5606'
stability: stable
---

# `autopilot-agent-run`

The child runner CLI. The published bin launches compiled JavaScript under
`dist/src/cli/autopilot-agent-run.js`; it does not execute TypeScript from
`node_modules` or rely on Node type stripping.

## Synopsis

`autopilot-agent-run [--dry-run] [--json] [--pi-executable <path>] <unit-spec.json>`

## Behavior

Reads and validates an Autopilot unit spec, applies the deterministic Quality vNext
spec gate before model spend, creates/resumes the deterministic per-unit worktree for
source-changing implement/fix specs, verifies a clean source baseline, derives and
persists the canonical repository-grounded authority artifact, acquires only its exact
observations/edit-intentions/exclusives, renders the child prompt, and either dry-runs
or launches Pi in RPC mode with the internal compiled status tool and worktree guard.

Live runs require the current private coordinator session context and register a child
lease before model spend. Current-build D65 runs additionally validate the accepted
complete semantic graph, highest signed launch policy, and governing program heartbeat
before runner preflight, after acquisition, and immediately before child-model spawn.
A semantic coordinator event suspends re-entry until its exact successor graph is
published and accepted.

## Exit classes

| Exit | Failure class |
|---|---|
| `0` | success / dry-run |
| `2` | `spec-invalid` |
| `3` | `waiting-for-peer-release` |
| `10` | `pi-spawn-failed` |
| `20` | `missing-structured-output` |
| `21` | `invalid-structured-output` |
| `30` | `status-non-success` |
| `31` | `runtime-commit-failed` |

## State written

`autopilot.execution_audit.v1` under `execution-audits/`, `autopilot.execution_commit.v1`
evidence, status/receipt artifacts, and an optional rendered-prompt snapshot — all in
the authoritative main runtime root.

## Related

- Tool: [`../tools/autopilot_emit_status.md`](../tools/autopilot_emit_status.md)
- CLI: [`autopilot-coordinator.md`](autopilot-coordinator.md)
