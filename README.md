<p align="center">
  <img src="logo.png" alt="Autopilot" width="240" height="240" />
</p>

# Autopilot

> **Agents: start at the docs, not this README.** The agent-first documentation is
> the navigable, always-current source of truth for working *on* this package:
> read [`AUTOPILOT-INSTRUCTIONS.md`](AUTOPILOT-INSTRUCTIONS.md) (the mandatory
> gateway) → [`docs/INDEX.md`](docs/INDEX.md) (machine-navigable surface + subsystem
> index) → [`docs/read-before-edit.md`](docs/read-before-edit.md) (source → owning-doc
> read-gate). Load [`docs/manifest.json`](docs/manifest.json) for O(1) navigation.
> The docs are kept current by a deterministic, offline freshness gate — see
> [`docs/subsystems/docs-freshness-gate.md`](docs/subsystems/docs-freshness-gate.md).

Autopilot is a standalone Pi extension package for dependency-cleared child-agent
orchestration. It provides the `/autopilot` command family, the parent `context_budget`
gate, the `autopilot-agent-run` child runner, and the compiled `autopilot-coordinator`
transactional local broker — plus Quality vNext contracts, isolated per-unit worktrees,
deterministic close/abort, and a full Coordination Fabric with durable run supervisors
and session fencing that preserve run/child ownership across Pi session replacement.

This README is a thin hub. Every capability below links to its authoritative doc; the
deep behavior, invariants, and source pointers live under [`docs/`](docs/INDEX.md).

## Install

```bash
pi install npm:pi-autopilot
# or during local development
pi install .
```

## Documentation map

| You want to… | Read |
|---|---|
| Enter the package as an agent | [`AUTOPILOT-INSTRUCTIONS.md`](AUTOPILOT-INSTRUCTIONS.md) |
| Navigate every surface + subsystem | [`docs/INDEX.md`](docs/INDEX.md) |
| Find the doc that owns a source file | [`docs/read-before-edit.md`](docs/read-before-edit.md) |
| Understand a command | [`docs/commands/`](docs/commands/autopilot.md) |
| Understand a tool | [`docs/tools/`](docs/tools/context_budget.md) |
| Understand a CLI | [`docs/cli/`](docs/cli/autopilot-agent-run.md) |
| Understand a subsystem | [`docs/subsystems/`](docs/subsystems/coordination.md) |
| Understand an invariant/concept | [`docs/concepts/`](docs/concepts/leases-and-observations.md) |
| Run a task (start/handoff/close/abort/recover) | [`docs/operations/`](docs/operations/start-run.md) |
| Diagnose a failure | [`docs/troubleshooting/failures.md`](docs/troubleshooting/failures.md) |
| Run private S2-D corpus rehearsal | [`docs/tools/s2-corpus-rehearsal.md`](docs/tools/s2-corpus-rehearsal.md) |
| See runtime state layout | [`docs/runtime-state/paths.md`](docs/runtime-state/paths.md) |

## Commands

Public commands are `/autopilot`, `/autopilot-inject`, `/autopilot-onboard`,
`/autopilot-handoff`, `/autopilot-config`, `/autopilot-claim-gc`,
`/autopilot-coordination`, `/autopilot-close`, and `/autopilot-abort`. All use
package-owned prompt sources and Autopilot names only. Full synopsis + behavior per
command: [`docs/commands/`](docs/commands/autopilot.md) (indexed in
[`docs/INDEX.md`](docs/INDEX.md#commands)).

## Tools

- `context_budget` — the parent-session gate activated by `/autopilot` (default 85% halt).
- `autopilot_respond_claim_request` — parent claim-response tool (after run attachment).
- `autopilot_emit_status` — child-only forced-output/status tool (via `autopilot-agent-run`).
- `autopilot_materialize_context` — child-only sparse READ materialization helper.

See [`docs/tools/`](docs/tools/context_budget.md) and [`docs/INDEX.md`](docs/INDEX.md#tools).

## Fixed model roster

Autopilot enforces one package-owned model/thinking assignment for every parent and
child role. The authoritative table is generated from code in
[`docs/INDEX.md`](docs/INDEX.md#model-roster):

| Role | Model | Thinking |
|---|---|---|
| Parent/orchestrator | `openai-codex/gpt-5.6-sol` | `xhigh` |
| Implement / Fix | `openai-codex/gpt-5.6-terra` | `high` |
| Strategy / Validate / Adjudicate / Bughunt | `openai-codex/gpt-5.6-sol` | `xhigh` |
| Extract | `openai-codex/gpt-5.6-luna` | `high` |

`/autopilot` and `/autopilot-inject` select the parent assignment before preparing a
worktree and fail loudly if the model, subscription authentication, or exact thinking
level is unavailable. OpenRouter and other metered frontier routes remain forbidden.

## Capabilities

Each capability is a concise pointer into the docs, where its behavior, invariants, and
source files live.

- **Coordination Fabric Phases 27–35 + D65 semantic authority** — a transactional
  coordinator, durable run supervisor, session fencing, peer claim negotiation,
  change reservations, automatic terminal-evidence reconciliation, and current-build
  complete-graph/launch-policy/program-heartbeat gates with crash-resumable successor
  publication.
  → [`docs/subsystems/coordination.md`](docs/subsystems/coordination.md),
  [`docs/concepts/`](docs/concepts/admission.md)
- **Runtime close/merge/abort** — deterministic, local-only close/abort with per-unit
  worktrees, `autopilot.unit_merge.v1` union proof, and validation staleness.
  → [`docs/subsystems/close-lifecycle.md`](docs/subsystems/close-lifecycle.md)
- **Per-unit worktrees, sparse by default** — isolated sparse checkouts, the disk gate,
  `.autopilot/checkout-profile.json`, and the `autopilot_materialize_context` helper.
  → [`docs/subsystems/worktrees.md`](docs/subsystems/worktrees.md)
- **Runner + forced-output/status** — `autopilot-agent-run`, the child status contract,
  and execution audits.
  → [`docs/subsystems/runner-and-forced-output.md`](docs/subsystems/runner-and-forced-output.md)
- **Quality vNext** — perfect-quality doctrine, scope/protected-path adjudication,
  work-item lifecycle, terminal closure, and the `state-store`.
  → [`docs/subsystems/quality-and-closure.md`](docs/subsystems/quality-and-closure.md)
- **Contracts, templates, and state-store** — schema-backed `autopilot.master_plan.v1`,
  `autopilot.decision.v1`, `autopilot.execution_audit.v1`, and the rest.
  → [`docs/subsystems/contracts-and-schemas.md`](docs/subsystems/contracts-and-schemas.md)
- **Verified migration + recovery** — durable, resumable, one-way migration and cutover,
  the read-only canonical preflight, and standalone production surfaces.
  → [`docs/concepts/migration-cutover.md`](docs/concepts/migration-cutover.md)
- **S2 release hardening** — explicit versioned persisted-artifact ingress (including
  BUG-177 `unit_failure` producer provenance), permanent bidirectional cf50/current skew
  certification, S2 retention/owned GC/pressure lanes, and the private mutable S2-D
  corpus rehearsal harness.
  → [`docs/subsystems/contracts-and-schemas.md`](docs/subsystems/contracts-and-schemas.md),
  [`docs/concepts/admission.md`](docs/concepts/admission.md),
  [`docs/subsystems/s2-retention.md`](docs/subsystems/s2-retention.md),
  [`docs/tools/s2-corpus-rehearsal.md`](docs/tools/s2-corpus-rehearsal.md)

## Development gate

```bash
npm run build
npm run typecheck
npm run test:package
npm run test:packed-migration
npm run test:upgrade
npm run test:version-skew
npm run test:s2-corpus
npm run test:d65
npm run test
npm run test:certification
npm run test:packed-consumer
npm run docs:generate
npm run docs:attest
npm run docs:verify
npm run pack:dry-run
```

`docs:verify` runs the deterministic, offline docs-freshness gate (checks C0–C11); it
also runs inside `test:package` and `prepack`. Use `npm run docs:generate` to regenerate
factual doc regions from code and `npm run docs:attest` to re-stamp doc hashes and
rebuild `docs/manifest.json`. See
[`docs/subsystems/docs-freshness-gate.md`](docs/subsystems/docs-freshness-gate.md).

Default automated coverage is offline and no-spend (unit/model/multiprocess/crash/chaos/
scale/SDK/RPC/package lanes with fake-Pi witnesses; offline SDK/RPC/package gates). The
full test plan is [`TEST_PLAN.md`](TEST_PLAN.md); how to run it is [`TESTING.md`](TESTING.md).
Release QA also runs cross-platform packed installs, docs and closed-repository scans,
`security:scan`, registry `security:audit`, deterministic CycloneDX `sbom`, and
`payload:check`.

## Known limitations

Automatic predecessor termination is not mathematically handle-bound: Node exposes no
portable pidfd/process-handle signaling API, so a residual identity-read-to-signal PID
race remains (it fails closed when process birth identity is unavailable; macOS requires
the declared system `/usr/bin/python3` bridge to libproc). Autopilot does not include a
compiled scheduler UI, PTY/TUI coverage, default automated live-provider execution, or
network push/PR creation. Provider-backed child runs require explicit operator approval,
subscription Pi channels, and the `autopilot-agent-run` path; the default package gate
remains deterministic, offline, network-free, and isolated from user/global Pi state.
