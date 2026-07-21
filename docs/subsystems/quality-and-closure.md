---
doc_id: subsystems/quality-and-closure
mode: authored
review_policy: behavioral
covers_surfaces: []
covers_sources:
  - src/core/quality/contract.ts
  - src/core/quality/spec-gate.ts
  - src/core/adjudication/index.ts
  - src/core/lifecycle/index.ts
  - src/core/state-store/index.ts
signature_hash: 'sha256:4364c2c6133369f29b7b1270545272492ed677c8048cb0eab4faf99a558a6408'
body_hash: 'sha256:1934cbfc1425b3718ced056044a3c8c7ae558b797120d69642681f05108d7290'
stability: stable
---

# Quality vNext and Terminal Closure

Autopilot's green result means root-cause, independently validated, ownership-audited,
evidence-backed work. This subsystem holds the perfect-quality doctrine, the
scope/protected-path adjudication, the work-item lifecycle, the closure gate, and the
durable state store.

## Key files

| Concern | Source |
|---|---|
| Perfect-quality contract rendered into prompts | `src/core/quality/contract.ts` |
| Deterministic pre-spend spec-quality gate | `src/core/quality/spec-gate.ts` |
| Scope + protected-path adjudication | `src/core/adjudication/index.ts` |
| Work-item lifecycle + closure gate | `src/core/lifecycle/index.ts` |
| Atomic state + monotonic events + resume | `src/core/state-store/index.ts` |

## Perfect-quality doctrine

Parent and child prompts embed the package-owned contract: no band-aids, hacks, silent
fallbacks, fake-green tests, fixture tampering, deferred consumers, or source-changing
self-certification. If correct work needs more scope, Autopilot records and routes the
exception instead of hiding it behind a green status.

## Work-item lifecycle

Source-changing work stays in `transport-complete`, `audit-review`, or
`validation-ready` until execution audits are clean/adjudicated and each source-changing
work item has its own referenced independent validation PASS. Transport success (a valid
`DONE`/`PASS` carrier) is deliberately separated from semantic closure.

## Closure gate

The closure gate rejects:

- unresolved scope/protected-path exceptions,
- missing per-work-item independent validation,
- missing final bughunt proof for high-risk or multi-lane work,
- an unclean or unadjudicated execution audit.

## Adjudication

Outside-owned changes become scope-review work (not automatic discard);
read-only/untouchable touches block semantic closure until validator/adjudicator
remediation or an explicit plan amendment. Scope ratification binds the master plan,
the execution audit, and a decision-log entry.

## State store

`state-store` writes `state.json` atomically, appends `events.jsonl` monotonically,
validates runtime references, and resumes from bounded event tails under
`.pi/autopilot/<workstream>/`.

## Related

- Subsystem: [`contracts-and-schemas.md`](contracts-and-schemas.md), [`runner-and-forced-output.md`](runner-and-forced-output.md)
- Concept: [`../concepts/terminal-evidence.md`](../concepts/terminal-evidence.md)
