---
doc_id: cli/autopilot-coordinator
mode: mixed
review_policy: contract
covers_surfaces:
  - autopilot-coordinator
covers_sources:
  - src/cli/autopilot-coordinator.ts
  - src/cli/autopilot-coordinator-bootstrap.ts
signature_hash: 'sha256:29d0ffebe8ddb994b739dc1176426a97f475537d0436864b7bf7c28398424d33'
body_hash: 'sha256:9809f7983db902d74b2203cb31ef525f45c2dc49b9a8aa076ccf609c506719a3'
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

- The published bin resolves and imports the compiled bootstrap
  (`src/cli/autopilot-coordinator-bootstrap.ts` → `dist/…/autopilot-coordinator-bootstrap.js`),
  which publishes private bounded atomic `bootstrap/import` evidence before importing
  the compiled coordinator. Package identity drift, symlinks, path escape, or a missing
  compiled payload fail before spawn — never a TypeScript/PATH/cwd fallback.
- `serve` runs the single-writer election and the coordinator until signalled;
  startup is diagnostics-only and never grants authority.
- `migrate/verify/rollback/cutover` are the one-way legacy migration lifecycle; they
  hold the global migration operation lock and never signal a healthy coordinator.
- `replay` stages a digest-bound private inbox; the database completion is
  authoritative after restart.

## Related

- Subsystem: [`../subsystems/coordination.md`](../subsystems/coordination.md)
- Command equivalent: [`../commands/autopilot-coordination.md`](../commands/autopilot-coordination.md)
