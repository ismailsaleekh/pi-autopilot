---
doc_id: cli/autopilot-coordinator
mode: mixed
review_policy: contract
covers_surfaces:
  - autopilot-coordinator
covers_sources:
  - src/cli/autopilot-coordinator.ts
signature_hash: 'sha256:1a89bbead9981028b0af3e587eec96b435c6bacce76484a5345014f7ea9a3bec'
body_hash: 'sha256:65943e4191602fe26f8f31c580ac3a17b8bada9e980118749aa799c0d7210a02'
stability: stable
---

# `autopilot-coordinator`

The compiled, package-owned local transactional broker CLI. Published as a bin that
launches `dist/src/cli/autopilot-coordinator.js` (never TypeScript source, never a
PATH/cwd fallback).

## Subcommands

The generated CLI invocation table lives in [`../INDEX.md`](../INDEX.md#clis). The full
invocation detail is below.

## Invocation detail

```text
autopilot-coordinator serve [--state-root <absolute-path>]
autopilot-coordinator status [--state-root <path>] [--repo-id <id>] [--run <workstream-run>]
autopilot-coordinator doctor [--state-root <path>]
autopilot-coordinator export [--state-root <path>] [--output <absolute-path>]
autopilot-coordinator replay --replay-id <stable-id> --input <absolute-request-jsonl> [--state-root <path>]
autopilot-coordinator upgrade-schema11 [--state-root <path>]
autopilot-coordinator migrate --dry-run|--apply --repo-key <key>
autopilot-coordinator verify|rollback|cutover --repo-key <key>
autopilot-coordinator recovery list|show|doctor|drain-stale-sessions --repo-root <absolute-path>
```

## Exit classes

| Exit | Meaning |
|---|---|
| `0` | success (or a benign election-loser exit for `serve`) |
| `1` | coordination runtime error |
| `2` | invalid arguments / usage |
| `3` | migration completed with blockers |
| `70` | system-fatal coordination error |

## Behavior notes

- `serve` runs the single-writer election and the coordinator until signalled;
  startup is diagnostics-only and never grants authority.
- `migrate/verify/rollback/cutover` are the one-way legacy migration lifecycle; they
  hold the global migration operation lock and never signal a healthy coordinator.
- `replay` stages a digest-bound private inbox; the database completion is
  authoritative after restart.

## Related

- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
- Command equivalent: [`../commands/autopilot-coordination.md`](../commands/autopilot-coordination.md)
