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
signature_hash: 'sha256:13c5284a7cf9be90ba2c6df340e484198016a06417322c5c44f09418650f4b87'
body_hash: 'sha256:1d9d0bb91681dc069c58b5ad63d34126c4c2ff221b51afd2b02f48b1ebbd7a6c'
stability: stable
---

# Contracts and Schemas

The package ships schema-backed Autopilot contracts for every durable artifact. The
authoritative schema-name list is generated from `src/core/names.ts`
(`AUTOPILOT_SCHEMA_NAMES`) and byte-verified below.

## Schema surfaces

The generated schema-name list lives in [`../INDEX.md`](../INDEX.md#schemas).

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

## Semantic validation

Semantic validation covers role/verdict coherence, owned-path status changes,
fake-green command rejection, declared-command and witness coverage, evidence
metadata, receipt hashes, provider identity, output freshness, runtime-root placement,
durable planning refs, purpose-state coherence, and execution-audit fact/classification
coherence.

## Related

- Index: [`../INDEX.md`](../INDEX.md#schemas)
- CLI: [`../cli/autopilot-agent-run.md`](../cli/autopilot-agent-run.md)
