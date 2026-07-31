---
doc_id: tools/autopilot_emit_status
mode: authored
review_policy: contract
covers_surfaces:
  - autopilot_emit_status
covers_sources:
  - codegen/templates/child-extension.ts.tmpl
  - drivers/src/runner/child.rs
signature_hash: 'sha256:82786edeaa54051548f1e7a5b3d5257408d8f7b836481e5e5a227e774ffd5dba'
body_hash: 'sha256:d1233d73030eeca1cd584ba56c80a4f939e59b37667cb98c1ed15706e16c100a'
stability: stable
---

# `autopilot_emit_status`

The internal child-only forced-output/status tool made available by
`autopilot-agent-run`.

## Signature

The generated child add-on registers one parent-selected status profile. Delivery emits `autopilot.delivery_submission.v2`; Validation emits `autopilot.validation_submission.v2`. Core wraps the admitted payload in its package-owned v2 result with profile, schema, assignment-binding, and tool-call audit identity.

## Availability

Child runner only. `autopilot-agent-run` explicitly loads the codegen-anchored add-on and selects one generated profile before prompting. It is never registered as a parent command or normal parent/global tool.

## Effects / authority

Its Pi tool-result details are the only model terminal carrier. Assistant text, a different profile/schema/boundary, mixed tool batches, and uncorrelated tool-result frames are rejected. Core then revalidates the package-owned result and exact delivery or validation subject before downstream acceptance.

## Failure classes

Missing/invalid structured output maps to the runner's `missing-structured-output` /
`invalid-structured-output` failure classes.

## Related

- CLI: [`../cli/autopilot-agent-run.md`](../cli/autopilot-agent-run.md)
- Tool: [`autopilot_materialize_context.md`](autopilot_materialize_context.md)
