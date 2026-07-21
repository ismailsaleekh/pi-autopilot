---
doc_id: tools/autopilot_materialize_context
mode: authored
review_policy: contract
covers_surfaces:
  - autopilot_materialize_context
covers_sources:
  - src/core/materialization.ts
signature_hash: 'sha256:f0ca7e1372e2fec8cef56466fe19dab6f1451f4d218895b3fe697880e327557a'
body_hash: 'sha256:1bb128bbe01dd1dfd8a128579c875ecaeafac698574325693648eecb234603e7'
stability: stable
---

# `autopilot_materialize_context`

The internal child-only sparse-checkout helper.

## Signature

Requests capped tracked READ context for a needed source path that is absent because
the worktree is sparse.

## Availability

Child runner only. Legacy-mode children may request capped tracked READ context
through it; it is never a parent or global tool.

## Effects / authority

Grants READ materialization only. It records claims/materialization evidence, enforces
byte/path/conflict caps, and never grants WRITE authority. WRITE scope cannot expand
silently: a child needing a new edit path must emit a blocker so the parent/spec
amends scope or creates a new attempt.

## Failure classes

Coordinator-backed runs fail a missing READ path loudly so the run supervisor amends
and reacquires a complete initial set (no silent dual-write of legacy claims).

## Related

- CLI: [`../cli/autopilot-agent-run.md`](../cli/autopilot-agent-run.md)
