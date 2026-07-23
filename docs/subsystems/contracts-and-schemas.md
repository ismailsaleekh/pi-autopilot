---
doc_id: subsystems/contracts-and-schemas
mode: mixed
review_policy: contract
covers_surfaces:
  - autopilot.unit_spec.v1
  - autopilot.status.v1
  - autopilot.event.v1
  - autopilot.state.v1
  - autopilot.receipt.v1
  - autopilot.handoff.v1
  - autopilot.master_plan.v1
  - autopilot.decision.v1
  - autopilot.execution_audit.v1
  - autopilot.execution_commit.v1
covers_sources:
  - src/core/contracts/index.ts
  - src/core/names.ts
signature_hash: 'sha256:09d5b894b45a6ee909d86cc0f308ba3e12e25aad1bf7b6bb02c08611fa3eded0'
body_hash: 'sha256:d0b47661598d9edfdfb1e69c53c73fbaf7899938f26da34f5355186802b830df'
stability: stable
---

# Contracts and Schemas

The package ships schema-backed Autopilot contracts for every durable artifact. The
authoritative schema-name list is generated from `src/core/names.ts`
(`AUTOPILOT_SCHEMA_NAMES`) and byte-verified below.

## Schema surfaces

The generated schema-name list lives in [`../INDEX.md`](../INDEX.md#schemas). Phase 37
roster schema surfaces (`autopilot.roster*`, `autopilot.request_profile.v1`,
`autopilot.observed_profile.v1`, `autopilot.unit_spec.v2`, `autopilot.receipt.v2`, and
related setup/selection/history contracts) are governed by
[`roster-onboarding.md`](roster-onboarding.md), whose roster readiness tables are also
generated from production code.

## What each schema governs

| Schema | Governs |
|---|---|
| `autopilot.unit_spec.v1` | Child unit specs (+ Quality vNext fields: quality profile, risk level, acceptance criteria, verification plan, closure criteria, upstream refs). |
| `autopilot.status.v1` | Child terminal status (verdict/severity/summary/changed paths/findings). |
| `autopilot.event.v1` | Monotonic `events.jsonl` entries. |
| `autopilot.state.v1` | Atomic `state.json` run state. |
| `autopilot.receipt.v1` | Forced-output receipt carrier binding status hash + provider identity. |
| `autopilot.handoff.v1` | Handoff artifact (mission, master-plan, decision tail, state/event tail, refs). |
| `autopilot.master_plan.v1` | Durable master plan truth. |
| `autopilot.decision.v1` | Durable decision-log entries. |
| `autopilot.execution_audit.v1` | Actual-change/audit record produced by the runner. |
| `autopilot.execution_commit.v1` | Runtime/child/mixed commit-range evidence on the unit branch. |
| Phase 37 roster schema family | Roster authority, setup, route policy, request/observed profile, pre-run selection, v2 spec/receipt, certification manifest, and historical adapter contracts; see [`roster-onboarding.md`](roster-onboarding.md). |

## Semantic validation

Semantic validation covers role/verdict coherence, owned-path status changes,
fake-green command rejection, declared-command and witness coverage, evidence
metadata, receipt hashes, provider/request-profile identity, output freshness,
runtime-root placement, durable planning refs, purpose-state coherence, roster v2
identity compatibility, and execution-audit fact/classification coherence.

## Related

- Index: [`../INDEX.md`](../INDEX.md#schemas)
- CLI: [`../cli/autopilot-agent-run.md`](../cli/autopilot-agent-run.md)
