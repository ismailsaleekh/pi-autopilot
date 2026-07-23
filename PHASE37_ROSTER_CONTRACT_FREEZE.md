# Phase 37 W0 — Agent-first roster contract freeze

**Status:** W1-READY (NON-CERTIFYING SEEDS)

**Freeze ID:** `phase37-roster-w0-2026-07-22`

**Manifest digest:** `sha256:52d3853a9965ec337d2d64a25bc5fa45f2a117218201cb7f55a3453834857943`

**Machine authority:**

- Manifest/seeds/ownership: [`design/phase37/roster-contract-freeze.v1.json`](design/phase37/roster-contract-freeze.v1.json) — `sha256:52d3853a9965ec337d2d64a25bc5fa45f2a117218201cb7f55a3453834857943`
- Schema/protocol/hash DSL: [`design/phase37/roster-contract-definitions.v1.json`](design/phase37/roster-contract-definitions.v1.json) — `sha256:306568b3d76980fd0b2881caf9d0f90cdd374e1311d9e79d724b6c3ba5e5e171`
- Acceptance fixtures: [`design/phase37/roster-acceptance-fixtures.v1.json`](design/phase37/roster-acceptance-fixtures.v1.json) — `sha256:7cec874aaeb4b8bec699e0b0f0a9968b39ef925e859a99ad6b9f0f357fba1b73`

Adjacent `.sha256` sidecars contain the exact digest of their neighboring JSON bytes. Definitions and fixtures bind only the freeze ID, not this manifest digest or prose digest, so authority is non-circular. The manifest intentionally does not duplicate field/type/nullability/nested schema shapes; it is subordinate to the definitions DSL for schema/protocol semantics and authoritative only for metadata, seeds, and W1 ownership.

## Locked product behavior

A new installation has no package-selected roster and writes nothing during installation. New-run resolution is exactly: explicit `--roster <id>`, trusted-project default, user default, then agent-first onboarding. Existing runs use only their immutable pre-run selection/runtime mirror. Corrupt higher-precedence authority fails closed; no provider/model/API/thinking/service/cache/prompt fallback is allowed.

When onboarding is required, `/autopilot` remains pre-run. Inspection, proposal, doctor, and rejection are zero-write and zero-lock. Save is allowed only after approval of the exact candidate-set hash and ordered roster hashes. Successful setup writes immutable rosters first, publishes `config.json` last, reads back every byte/hash, returns/prints a secret-free receipt without counting it as a persisted authority write, requires a fresh Pi session, and prints the original command without auto-starting. The saved default is always the exact `roster_id + roster_revision + roster_sha256` tuple; roster ID alone has no default-selection authority.

## D68 state root and storage boundary

The D68 default user location is exactly `~/.pi/agent/autopilot/`. XDG and package-relative defaults are not authorized. A constructor-injected state root is allowed only for tests. Trusted-project authority is under `<trusted-project>/.autopilot/` and requires `ctx.isProjectTrusted() === true` for both reads and writes. Revisioned roster paths are create-only `<scope-rosters>/<roster-id>/revision-<roster-revision>.json`; byte-identical collisions are idempotent and differing bytes are fatal. Config/receipt defaults must match exactly one saved roster tuple. Pre-run selections are create-only before worktree mutation or spend. Lock/no-follow/temp/fsync/receipt-count/config-last/readback/crash semantics are frozen in the definitions DSL; W0 save success counts exactly three visible authority writes for the two roster files plus `config.json`.

## Public profiles

| Stable ID | Public name | Semantics | Default recommendation |
|---|---|---|---|
| `precision` | Precision | Quality | No |
| `cruise` | Cruise | Routine | Yes, when qualified |
| `afterburner` | Afterburner | Quick | No |

All profiles keep the same perfect-quality closure contract. If two profiles resolve to the same exact chain, they are presented as converged. If Cruise is blocked, setup asks for an explicit qualified choice instead of inferring another default.

## Release and compatibility boundary

Phase 37 targets package `1.3.0` over Pi baseline `0.80.6`. Coordinator protocol `1.6`, API schema `12`, and store schema `13` do not change. New runs use `autopilot.unit_spec.v2` and `autopilot.receipt.v2`, pinned to the current v1 source hashes recorded in the manifest/definitions. Historical `autopilot.unit_spec.v1` and `autopilot.receipt.v1` bytes remain immutable evidence and are never reinterpreted as v2. The historical fixed-roster adapter is fail-closed: it admits only literal byte-digest-proven pre-`1.3.0` v1 unit/receipt evidence, absent pre-run selection, exact immutable OpenAI Codex Sol/Terra/Luna role/model/thinking chain, and no conflicting evidence; it mutates no historical bytes and returns the exact frozen selection identity recorded in the fixtures.

## Seed status

W0 freezes exact seed route policies, provider recipes, generated rosters, assignments, doctor result ordering, runtime interface contracts, and candidates for Codex, Anthropic, OpenCode Go, Kimi Coding, and ZAI. Every generated roster/assignment records selected scope, context/output/input/tool/reasoning capability, billing-route class, non-secret auth class/source, and exact route/API/thinking/service/cache/prompt facts. Every candidate links directly to `recipe_id`/revision and `route_policy_id`/revision; inferred mappings such as `deriveProviderFromRecipe` are forbidden.

All manifest seeds are unqualified, non-certifying, and not launch-ready until W4 qualification. Synthetic fixture qualifications may produce ready candidates only inside the fixture artifact/tests and do not certify providers.

## W1 lane boundary

| Lane | Exclusive responsibility | Production consumer |
|---|---|---|
| `w1-contracts` | roster schemas, canonical hashes, current `types/schemas/validate`, names/index integration, historical adapter | strict parser/canonical API and regression consumed by all roster lanes |
| `w1-storage` | D68 paths and transactional publication | approval-bound save/default/pre-run-selection API |
| `w1-recipes-doctor` | route policies, recipes, candidate resolver, route resolver, doctor | deterministic proposal/doctor engine |
| `w1-skill-package` | packaged setup skill/payload | packed skill discovery regression |
| `w1-fixtures` | reusable acceptance corpus and production fixture-corpus loader | same-wave production consumer plus W1/W2 tests |

Hot files have one owner only; `src/extension.ts`, `src/core/model-roster.ts`, runner/status/forced-output, and generated docs remain out of W1 implementation lanes unless a later accepted plan assigns them.

## W0 acceptance

The validator rejects unknown/missing contract keys, validates the definitions DSL and schema field sets, recomputes manifest seed and registry hashes, validates direct route/recipe/candidate references, recomputes fixture vectors/cases/registries and sidecars, checks fixture coverage and ownership/historical adapter claims, and rejects readiness/certification contradictions. W0 is W1-READY only with that validator passing.

## Forbidden implementation shapes

Implicit package defaults, XDG state-root substitution, writes during inspection/proposal/reject/doctor, credentials in artifacts, provider quality inferred from names, subscription status inferred from key shape, OpenRouter/metered gateway fallback, thinking clamping, runtime identity fallback, uncertified custom/mixed launch, same-session auto-start, historical evidence mutation, second selection authority, overlapping hot-file ownership, and infrastructure-only lanes are forbidden.
