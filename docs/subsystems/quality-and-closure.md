---
doc_id: subsystems/quality-and-closure
mode: authored
review_policy: behavioral
covers_surfaces: []
covers_sources:
  - data/closure.kdl
  - data/failure-table.kdl
  - data/finalization.kdl
  - data/recovery.kdl
  - data/seam_real_producers.rs
  - drivers/src/closure/mod.rs
  - drivers/src/finalize/mod.rs
  - drivers/src/repair/mod.rs
  - drivers/src/seam/mod.rs
signature_hash: 'sha256:12f73f09fce71a83ab9b1535dbefa7b5290477cd14b8bac2f3ebc75f35e3a8e7'
body_hash: 'sha256:12f73f09fce71a83ab9b1535dbefa7b5290477cd14b8bac2f3ebc75f35e3a8e7'
semantic_attestation: 'sha256:12f73f09fce71a83ab9b1535dbefa7b5290477cd14b8bac2f3ebc75f35e3a8e7'
stability: stable
---

# Quality and terminal closure

Autopilot admits recovery and publication through package-owned predicates rather than model
prose. This document distinguishes the predicates that are wired today from declarative or
library surfaces that are not yet production evidence.

## Source map

| Concern | Source |
|---|---|
| One-attempt semantic recovery policy | `data/recovery.kdl`, `drivers/src/repair/mod.rs` |
| Closed failure and escalation taxonomy | `data/failure-table.kdl` |
| Planning-recovery immutability | `data/seam_real_producers.rs` |
| Recovery admission, validation handoff, durable state, and publication | `drivers/src/seam/mod.rs` |
| Closure-bundle and repair-routing library | `data/closure.kdl`, `drivers/src/closure/mod.rs` |
| Wired final-gate predicate and its declarative policy | `drivers/src/finalize/mod.rs`, `data/finalization.kdl` |

## Bounded semantic recovery

A fresh Recovery Engineer may investigate one admitted semantic rejection or one mechanically
proven pre-effect command-policy denial using original authority, repository facts, upstream
outputs, and the gate's typed diagnosis. The diagnosis is evidence, not authority.

Planning recovery mechanically fixes unit count, identity and position, kind, dependencies, files,
and atom links. Objective, criteria, verification commands, and package checks may change only on
units named in `affected_unit_ids`. The required `preserved_authority` list is model-supplied
evidence, not a package fence for tests or gates. Source recovery uses the original approved unit
scope and normal delivery admission. A closed
disposition records `repaired`, `no-defect`, `requires-new-authority`,
`infrastructure-blocked`, or `unsafe-blocked`; only the first two may return to the same
independent gate, once. A second rejection is preserved as exhaustion rather than fed into a
loop.

The model's blocker label cannot open delivery recovery by itself. Core requires the exact issued
assignment and audit provenance plus mechanical Git and worktree facts. A
`requires-new-authority` delivery is reconcilable only when a nonempty bounded denial ledger
contains exclusively unknown `autopilot_run_approved_command` identifiers denied before effect,
HEAD is still the exact base, and nonempty dirty paths are wholly approved. Core never adopts or
commits the blocked work: a fresh Recovery Engineer must produce a newly admitted result before
packaging and the unchanged Validator handoff. Missing authority, infrastructure/provider faults,
path-policy denials, unsafe or effected mutations, clean/no-change contradictions, stale
snapshots, malformed or overflowed audit, and exhaustion remain loud terminal outcomes. The
separately attested capability and receipt mechanics are documented in
[runner-and-forced-output.md](runner-and-forced-output.md).

## Validation and closure library

At the seam, recovery output supplies a new candidate to the existing validation handoff, not a
substitute verdict. The exact command-receipt and criterion-citation predicates live in the runner
boundary linked above; this document does not duplicate their source ownership.

`DeepValidationBundle::build` rejects duplicate declared criterion ids, observations for unknown
criteria, and any declared criterion with no observation. It does not reject repeated observations
for the same declared criterion. `criteria_for_delta` can select criteria whose paths or semantic
surfaces changed or whose ids became stale, but currently has test callers only. Likewise, the
bounded `RepairLedger` can route surviving material findings, while the production integration
bundle currently synthesizes a passing criterion with no findings, so that escalation path is not
currently exercised by the seam. These are package-owned library capabilities, not claims of
additional production closure evidence.

## Wired final gate

`verify_final_gate` implements nine Rust conditions. Current seam wiring supplies them as follows:

- every required lane must have a `unit-closed:` ref and no active or unknown work may remain;
- the attributable-diff input currently proves only that required lanes are nonempty and at least
  one `unit-closed:` ref exists; it does not independently inspect the integrated diff;
- mandatory-finding and stale-proof prefixes must be absent, but current Core code has no producer
  for either prefix;
- final-command, full-suite, and final-Validator booleans are all minted for the current tip from
  the one `run_final_verification_at_tip` outcome. In `.pi/live-test.json` repositories that
  outcome executes the configured verification commands; outside that harness the function
  currently returns success without running commands; and
- `verify_final_gate` can require exact-tip Bughunter evidence when its trigger input says so, but
  current seam construction hardcodes low risk and false protected/operator flags, computes lane
  count after active work is gone, and has no `bughunter-pass:` producer. It also queries an
  `integration:conflict-route` ref prefix even though production emits that text as an event kind,
  not an artifact ref, so neither the completion guard nor conflict trigger observes it. The
  production path therefore does not currently exercise the Bughunter requirement.

`data/finalization.kdl` also declares `active-evidence-receipts` and
`closed-evidence-envelope`. They are not represented in `FinalCondition::ALL` and are not enforced
by `verify_final_gate`; their presence in declarative data must not be cited as a green runtime
proof. The current nine-input predicate is therefore narrower than the complete declarative
policy.

When the wired predicate passes, `evaluate_final_gate` binds tip, tree, run identity, and the
provided evidence digest. Publication persists a prepared intent, creates the result ref with a
zero-old-object compare-and-swap, verifies the ref, records durable closed state, and archives the
publication. A conflicting ref or mismatched prepared publication is rejected; a matching
prepared publication can be completed on replay.

## Durable state

`CoreState` replays the append-only event path and advances monotonically by checked sequence and
revision. Recovery-pending, assignment-issued, validation, integration,
publication-prepared, and publication-closed facts are appended before their corresponding
spawn or publication transition, allowing restart replay rather than successful-state inference.

## Related

- Subsystem: [`contracts-and-schemas.md`](contracts-and-schemas.md), [`runner-and-forced-output.md`](runner-and-forced-output.md)
- Concept: [`../concepts/terminal-evidence.md`](../concepts/terminal-evidence.md)
