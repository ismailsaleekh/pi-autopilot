---
doc_id: tools/autopilot_emit_status
mode: authored
review_policy: contract
covers_surfaces:
  - autopilot_emit_status
covers_sources:
  - src/internal/status-extension.ts
signature_hash: 'sha256:82786edeaa54051548f1e7a5b3d5257408d8f7b836481e5e5a227e774ffd5dba'
body_hash: 'sha256:c2754e6daa340656aed8c8ef5f45c7564cfec2eb48c985481ef43a63a77d0931'
stability: stable
---

# `autopilot_emit_status`

The internal child-only forced-output/status tool made available by
`autopilot-agent-run`.

## Signature

Emits the child's terminal `autopilot.status.v1` status and a matching
`autopilot.receipt.v1` receipt carrier; the receipt binds the status hash, provider
identity, and tool-call id.

## Availability

Child runner only. It is loaded solely by `autopilot-agent-run` with an explicit
context file (`AUTOPILOT_AGENT_STATUS_CONTEXT`); it is never registered as a parent
command or a normal parent/global tool.

## Effects / authority

Produces the single valid structured status carrier the runner requires for a
successful unit. Assistant text alone is rejected; the runner revalidates success
statuses against the execution audit before transport acceptance.

## Failure classes

Missing/invalid structured output maps to the runner's `missing-structured-output` /
`invalid-structured-output` failure classes.

## Related

- CLI: [`../cli/autopilot-agent-run.md`](../cli/autopilot-agent-run.md)
- Tool: [`autopilot_materialize_context.md`](autopilot_materialize_context.md)
