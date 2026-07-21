---
doc_id: runtime-state/paths
mode: authored
review_policy: contract
covers_surfaces: []
covers_sources: []
stability: stable
---

# Runtime State Paths

Where Autopilot writes durable state. The generated summary table lives in
[`../INDEX.md`](../INDEX.md#runtime-state-paths); this doc is the full schema. The state
root defaults to `~/.pi/agent/autopilot/` and honors the absolute `AUTOPILOT_STATE_ROOT`
override (used by tests).

## Shared authority — `~/.pi/agent/autopilot/`

| Path | Contents |
|---|---|
| `coordinator/` | `coordinator.db` + WAL/SHM, generation-specific lifecycle/startup locks, socket/named pipe, the old-format compatibility fence, private capability, backups, exports, session contexts. |
| `worktrees/<repo-key>/active/<workstream-run>/main/` | The isolated package-owned main worktree for a run. |
| `worktrees/<repo-key>/active/<workstream-run>/units/<unit-id>/attempt-<n>/worktree/` | A source-changing unit's sparse per-unit worktree. |
| `worktrees/<repo-key>/_archive/<workstream-run>/` | Archived runtime evidence after close/abort. |
| `coordination/<repo-key>/` | Pre-cutover claim/worktree JSON — validated migration input, **not** a fallback for coordinator failure. |
| `migrations/<repo-key>/` | Migration journals, freeze tokens, immutable snapshots, verified backup refs, read-only archives. |
| `cutovers/<repo-key>.json` | One-way cutover markers. |

Unix modes are enforced. On Windows the package removes inherited broad ACLs, grants the
current account full control on state/capability paths, uses a per-user
generation-specific pipe name, and still requires the timing-safe capability proof on
every frame.

## Per-workstream runtime — `.pi/autopilot/<workstream>/`

Lives inside the main worktree. Autopilot validates and writes package-owned artifact
paths for:

`mission.md`, `master-plan.json`, `decision-log.jsonl`, `unit-specs/`, `authority/`,
`statuses/`, `receipts/`, `execution-audits/`, `execution-commits/`, `unit-merges/`,
`integration-analyses/`, `reservation-integration/`, `reservation-repairs/`,
`validation-staleness/`, `rendered-prompts/`, `evidence/`, `state.json`, `events.jsonl`,
`scheduler-config.json`, close evidence, and handoff files (`handoff.json`, `handoff.md`,
`handoff-event-tail.jsonl`).

Unit specs require status, receipt, and evidence outputs to stay inside the matching
workstream runtime root; non-strategy child specs must reference durable
mission/master-plan context before launch. Source-changing units run in per-unit
worktrees, but their authoritative status/receipt/evidence/audit/merge/scheduler
artifacts still live under this main runtime root.

## Materialization ledgers

Autopilot materializes the `autopilot.authority.v1` artifact into the unit and main
worktrees and writes `_materialization-ledger.jsonl` and `_materialized-paths.json`,
creating parent directories for grounded future-owned files.

## Related

- Subsystem: [`../subsystems/worktrees.md`](../subsystems/worktrees.md)
- Concept: [`../concepts/migration-cutover.md`](../concepts/migration-cutover.md)
