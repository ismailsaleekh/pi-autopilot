---
doc_id: subsystems/runner-and-forced-output
mode: authored
review_policy: behavioral
covers_surfaces:
  - autopilot-agent-run
covers_sources:
  - data/control.kdl
  - data/seam_real_producers.rs
  - drivers/src/control/mod.rs
  - drivers/src/runner/mod.rs
  - drivers/src/runner/child.rs
  - drivers/src/watchdog/mod.rs
  - src/extension.ts
  - src/resolve-core.ts
signature_hash: 'sha256:3c050effcbb84d587bcdf366630b7b847070fd1efc7c18533e59fd9f83f2a07c'
body_hash: 'sha256:6a4f813d84d805f3d7f308a534cb7283e072be61e9f0de42acb629d469cf7656'
semantic_attestation: 'sha256:6a4f813d84d805f3d7f308a534cb7283e072be61e9f0de42acb629d469cf7656'
stability: stable
---

# Runner and forced-output boundary

Autopilot's child runner is split between a tiny npm wrapper and Rust Core-owned `agent-run` mode. Host code never chooses roles, modes, prompts, timeouts, runner paths, or result acceptance.

## Source map

| Concern | Source |
|---|---|
| Package-contained runner resolution | `src/resolve-core.ts` |
| Core command/spec construction | `drivers/src/runner/mod.rs` |
| Child runner validation and Pi JSONL handling | `drivers/src/runner/child.rs` |
| Terminal carrier acceptance | `drivers/src/seam/mod.rs` |
| Public generated contract | `data/contracts.kdl`, `docs/generated/contracts.md` |

## Parent-to-child launch

1. `CoreTransport` resolves `process.execPath` and `bin/autopilot-agent-run.mjs` from the installed package and passes them to Core as transport facts.
2. Core writes a strict `autopilot.agent_run_spec.v4`, rendered prompt, and a parent-selected generated terminal profile under deterministic `.pi/autopilot/<workstream>/...` paths.
3. Core emits a `background_action` whose nested `bg_run` object is byte-exactly the public `pi-background-tasks@0.6.1` `run` payload. Every Autopilot-owned descriptor keeps `notifyOnCompletion: true` for durable operator notification and sets `triggerOnCompletion: false`, so completion is machine-consumed without waking the unrestricted parent model.
4. The central `control.bg-run-exact.v1` boundary rejects any package-issued descriptor that disables notification or enables parent-turn triggering, then requires the Host call to match every descriptor byte.
5. The Host forwards that object over `pi.events`; it does not rewrite fields, synthesize defaults, or call a Pi context method named `bg_run`. Generic background tasks outside Autopilot retain the background service's normal trigger behavior.
6. The background service durably publishes one terminal event. The Host correlates it to the exact action and sends `task-completed` directly to Core; replay/re-emission and watchdog actions use the same machine-only completion profile.
7. If correlation, Core transport, or next-effect application fails, the Host appends a bounded `rejection:host-terminal:` machine status before operator prose and rethrows. If machine-status publication itself fails, Host reports both failures through the non-triggering operator channel and still rethrows the original terminal error. It never infers success or continues after a possibly partial state transition.

## Child acceptance

`agent-run` validates all identity and route facts before launching Pi. It rejects stale carrier files, path symlinks, non-UTF-8 paths, role/mode drift, roster/provider/model/thinking drift, non-subscription/API-key routes, unknown tools, prompt digest mismatch, and deterministic path mismatch.

The child Pi process uses a run-owned session directory with `--no-extensions` plus the one codegen-anchored child add-on, bounded stdout/stderr, a wall timeout, and no metered API-key environment variables. Before prompting, Core verifies the streamed and durable registration receipt, selected profile, exact active tools, add-on digest, and assignment binding.

Every model assignment terminates through one parent-selected generated tool profile. `tool_execution_end.result.details`, correlated to `message_end(toolResult)` by opaque call id, is authoritative; assistant terminal text, mixed tool batches, duplicate results, identity drift, and stale unconsumed carrier files fail loudly. Planning carriers retain their planning boundary payload. Delivery and Validation use model-only v2 submissions wrapped in package-owned v2 results with immutable runner identity and a digest-bound tool audit.

Delivery verification has two typed owners. `commands` are pre-package child evidence and are the only strings admitted into the exact bash allowlist. `package_checks` are closed Core-owned obligations; `clean-exact-package-tip` is proved only after an admitted succeeded submission by Core's exact commit/tree, base-ancestry, strictly clean worktree (including nonignored untracked residue), and changed-path equality checks. Package checks never become child shell. Every check declares unique in-range 1-based `criterion_ordinals`; Core emits a digest-bound package-check receipt only onto those criteria in the fact-only validation context, and validation admission requires each affected criterion to cite that exact receipt. The unchanged independent Validator can therefore use the package fact without executing model-authored post-commit shell or substituting the receipt as evidence for unrelated criteria. Missing package-check fields in older assignment artifacts fail closed rather than defaulting to child authority.

The child delivery policy records only unapproved bash requests refused before `local.exec` in a bounded digest-only denial ledger. The ledger cannot be supplied by model parameters, carries `effected=false`, and saturates visibly after 32 entries. Edit/write/path/topology refusals are not relabeled repairable. Core revalidates the ledger against the pinned add-on and audit digests and separately inspects Git; a denied request is therefore distinguishable from an effected mutation without trusting model prose.

Fresh subscription-backed child processes use the data-owned deterministic startup spread in `data/recovery.kdl`. The spread is derived from workstream plus planning ordinal or package lane identity, so planning and delivery/validation siblings in one wave occupy distinct bounded launch buckets instead of reading the OAuth credential store together. It does not inject credentials, use an API-key fallback, alter the route, retry model content, or apply to resumed sessions.

## Recovery Engineer

A semantically admitted model result can be wrong even when its general direction is correct. Autopilot therefore has one phase-bound `recovery-engineer` attempt before terminal escalation:

- A non-pass first plan review launches a fresh planning-repair assignment with the canonical work map, complete rejected-review carrier, original authority, atom registry, repository evidence, and the same review criteria. The Recovery Engineer independently verifies the diagnosis and returns one complete work map through the generated `recovery-work-map.v1` terminal profile. Core mechanically requires nonempty diagnosis/action/preservation evidence, identical unit identity/order/scope/dependencies/links, and an exact declaration of affected units. `repaired` requires declared surgical changes; `no-defect` requires every unit to remain unchanged. Both return to the unchanged full-review gate once. Another non-pass is terminal.
- A blocked delivery classified `semantic-repairable`, a mechanically reconciled pre-effect unapproved-command denial, or a first-round forward validation with semantic blockers launches the same role in a source-repair mode inside the original lane worktree. The package-issued delivery assignment carries a typed recovery directive containing the rejected carrier, findings, evidence, original gate, exact approved units, base/tree, and a one-attempt budget. The typed finding selects a phase-appropriate mode (`forward-critical`, `failed-test`, `closure-repair` for evidence gaps, or `conflict-resolution` for contract defects), and the directive binds that mode to the assignment. Its submission must carry one closed recovery disposition. `repaired` requires succeeded with actual changes; `no-defect` permits exact in-scope prior changes or a mechanically clean unchanged commit. Normal delivery admission, package commit derivation, and independent round-two validation remain unchanged. A blocked Recovery Engineer or blocked round-two validator is terminal.

Blocked delivery must classify its blocker as `semantic-repairable`, `requires-new-authority`, `infrastructure`, or `unsafe`, but the model-selected label is evidence rather than sole routing authority. Core computes a typed recovery assessment from the exact assignment/audit digests, denial ledger, base HEAD, and safe in-scope dirty paths. `requires-new-authority` may receive one diagnostic Recovery Engineer only when the audit proves at least one bounded unapproved bash request was denied before effect, the ledger did not overflow, HEAD still equals the exact base, and nonempty dirty paths remain wholly inside approved files. Core does not package or accept that blocked work. The fresh Recovery Engineer must independently submit `repaired` or `no-defect`; only then may Core package and send it to the unchanged independent gate. Missing denial evidence, clean/no-change state, path-policy denial, out-of-scope residue, HEAD movement, stale snapshot/provenance, infrastructure, unsafe state, or exhaustion stays terminal. A genuine authority gap therefore remains `requires-new-authority` after the one bounded diagnosis and never receives widened authority. The role cannot widen unit scope, change task authority or independent tests/gates, self-certify, mask infrastructure/provider errors, or create a second recovery loop. It may correct a task-owned implementation test only when that file is already in the approved unit and evidence proves the test contradicts unchanged authority.

Delivery recovery is event-before-action. `agent:delivery-blocked` records the typed admission and a content-sensitive worktree snapshot digest before any spawn. Restart re-reads the bound carrier, assignment, audit, HEAD, paths, file contents, and executable-mode summary; any mismatch rejects replay instead of adopting drift. Once the recovery binding exists, normal exact re-emission and terminal-consumption guards prevent duplicate attempts.

Planning provenance is immutable and unambiguous: the rejected synthesized map and recovered map use separate create-new projections, while each Recovery Engineer/reviewer binding records exactly one bounded subject carrier path and SHA-256. Recovery comparison and approved-plan promotion reread that exact carrier and reject digest drift; ordinal-two review receives only the recovered subject. Delivery and validation record a typed pending-recovery event before issuing the child. Restart folds that event, deterministically recreates or re-emits the same assignment, and never allocates ordinary replacement work across the recovery window.
