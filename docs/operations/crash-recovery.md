---
doc_id: operations/crash-recovery
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Operation: Crash and Interrupted-Operation Recovery

Autopilot recovers from crashes autonomously in the common case. This recipe covers what
happens automatically and the explicit recovery commands for ambiguous authority.

## Automatic recovery (no operator action)

- **Coordinator restart** replays durable terminal facts and queues owner recovery
  messages; activation, supervisor heartbeat, and runner preflight advance incomplete
  owned [sagas](../concepts/sagas.md) before dispatch.
- **Interrupted worktree operations** resume idempotently under the per-worktree lock —
  every retry probes before acting, so a lost response never double-applies an effect.
- **Failed unit authority** is reconciled from durable attempt/child/lease/worktree facts.
  Current `autopilot.unit_failure.v1` evidence carries explicit producer provenance and
  exact Git/worktree postconditions; BUG-177 historical reset/abort bytes are only a
  regeneration cue and never release edit authority by themselves.
- **Offline peers** lose no request or notification: at-least-once mailbox replay with
  contiguous acknowledgement cursors survives owner/requester shutdown, handoff, and
  coordinator restart.

## Inspect state

```bash
autopilot-coordinator status --repo-id <key> --run <workstream-run>
autopilot-coordinator doctor
autopilot-coordinator recovery list --repo-root <absolute-path>
autopilot-coordinator recovery doctor --repo-root <absolute-path>
```

Or from a Pi session: `/autopilot-coordination status|doctor`.

## Ambiguous imported authority (explicit)

The `recovery` subcommands are the only public mutation consumer for imported ambiguous
authority. They attach a fenced recovery-only session, preserve authority by default, and
publish immutable bounded evidence before any release. The S2-D corpus rehearsal harness
uses the same recovery-only APIs in private mutable clones for Phase36 release evidence;
it does not authorize ordinary dispatch in a frozen live source:

```bash
autopilot-coordinator recovery retain-authority --repo-root <path> --run <run> (--recovery-id <id>|--all)
autopilot-coordinator recovery release-with-evidence --repo-root <path> --run <run> \
  --recovery-id <id> --source <source> --target-id <id> --evidence <absolute-json-path>
```

`--all` is restricted to explicit authority retention for one reviewed run; evidence-backed
release always targets one exact recovery row.

## Invariants

- Age never authorizes release; recovery is identity- and lifecycle-fenced.
- A failed schema-changing target startup restores the final backup byte-for-byte and
  reports manual recovery honestly — this package cannot restart an unavailable old binary.

## Related

- Concepts: [`../concepts/sagas.md`](../concepts/sagas.md), [`../concepts/terminal-evidence.md`](../concepts/terminal-evidence.md), [`../concepts/migration-cutover.md`](../concepts/migration-cutover.md), [`../concepts/dispatch-and-recovery-authority.md`](../concepts/dispatch-and-recovery-authority.md), [`../concepts/semantic-graph-authority.md`](../concepts/semantic-graph-authority.md)
- CLI: [`../cli/autopilot-coordinator.md`](../cli/autopilot-coordinator.md)
