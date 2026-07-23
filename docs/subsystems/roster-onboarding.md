---
doc_id: subsystems/roster-onboarding
mode: mixed
review_policy: contract
covers_surfaces:
  - /autopilot
  - autopilot-agent-run
  - autopilot.assignment.v1
  - autopilot.auth_summary.v1
  - autopilot.billing_summary.v1
  - autopilot.capability_summary.v1
  - autopilot.certification_manifest.v1
  - autopilot.certification_role_result.v1
  - autopilot.context_ref.v2
  - autopilot.evidence_ref.v1
  - autopilot.existing_run_resolution_request.v1
  - autopilot.existing_run_resolution_result.v1
  - autopilot.historical_fixed_roster_adapter_admission.v1
  - autopilot.historical_fixed_roster_adapter_request.v1
  - autopilot.historical_fixed_roster_adapter_result.v1
  - autopilot.historical_fixed_roster_artifact.v1
  - autopilot.historical_fixed_roster_role.v1
  - autopilot.inventory_model.v1
  - autopilot.inventory_provider.v1
  - autopilot.observed_profile.v1
  - autopilot.pre_run_selection.v1
  - autopilot.pre_run_selection_publish_request.v1
  - autopilot.pre_run_selection_publish_result.v1
  - autopilot.profile_template.v1
  - autopilot.provider_recipe.v1
  - autopilot.receipt.v2
  - autopilot.receipt_validation_request.v1
  - autopilot.receipt_validation_result.v1
  - autopilot.recipe_resolution_request.v1
  - autopilot.recipe_resolution_result.v1
  - autopilot.request_profile.v1
  - autopilot.role_template.v1
  - autopilot.roster.v1
  - autopilot.roster_candidate.v1
  - autopilot.roster_candidate_set.v1
  - autopilot.roster_config.v1
  - autopilot.roster_diagnostic.v1
  - autopilot.roster_doctor_result.v1
  - autopilot.roster_inventory.v1
  - autopilot.roster_setup_receipt.v1
  - autopilot.roster_tool_request.v1
  - autopilot.roster_tool_result.v1
  - autopilot.roster_transition.v1
  - autopilot.route_policy.v1
  - autopilot.route_resolution_request.v1
  - autopilot.route_resolution_result.v1
  - autopilot.saved_roster_ref.v1
  - autopilot.unit_spec.v2
covers_sources:
  - src/extension.ts
  - src/core/roster/activation-fence.ts
  - src/core/roster/artifact-compatibility.ts
  - src/core/roster/canonical.ts
  - src/core/roster/contracts.ts
  - src/core/roster/doctor.ts
  - src/core/roster/historical-adapter.ts
  - src/core/roster/paths.ts
  - src/core/roster/provider-recipes.ts
  - src/core/roster/providers/index.ts
  - src/core/roster/resolve.ts
  - src/core/roster/route-policies.ts
  - src/core/roster/run-selection.ts
  - src/core/roster/runtime-consumers.ts
  - src/core/roster/runtime-spec.ts
  - src/core/roster/setup-approval.ts
  - src/core/roster/setup-context.ts
  - src/core/roster/setup-receipt.ts
  - src/core/roster/setup-tool.ts
  - src/core/roster/skill-package.ts
  - src/core/roster/snapshot.ts
  - src/core/roster/storage.ts
  - src/core/roster/transaction.ts
  - src/core/forced-output/identity.ts
  - src/internal/execution-observer-extension.ts
  - templates/skills/autopilot-roster-setup/SKILL.md
  - templates/skills/autopilot-roster-setup/payload.json
signature_hash: 'sha256:7f6d8bf57292542434db2fc0a38054f371f1888f0f8cfee86ea5cb91685837d6'
body_hash: 'sha256:108311b7bdc07a2833145595c02fc388fb0dba107c1ada3df604cf974b6c1b6c'
stability: evolving
---

# Roster Onboarding, Selection, and Provider Qualification

Phase 37 W0-W4 roster work is shipped in this package: agent-first setup contracts,
provider seed packs, v2 runtime identity, W3/W4 registry gates, and historical v1
adapters are source-backed at `bacbd85`. Its purpose is to bind every new run to an
immutable roster, pre-run selection, and request profile before worktree mutation or
model spend. It is fail-closed: missing, corrupt, untrusted, unqualified, or mismatched
authority blocks activation rather than falling through to a lower-precedence default
or a provider guess.

## Current readiness truth

**Current package truth:** every offline W4 provider pack in this package is blocked
or non-certifying for launch authority. The generated table below lists the current
packs and pin counts; setup cannot save a launchable roster until package-reviewed
live W3 trust pins and trusted certified roster hashes exist in the central W4 provider
registry.

<!-- GENERATED:roster-readiness START (source: src/core/roster/provider-recipes.ts, src/core/roster/route-policies.ts, src/core/roster/providers/index.ts) -->
### W4 provider registry (current package pins)

| Provider pack | Provider | Recipe | Route policy | Ready profiles | Registry readiness | Required evidence refs | Trusted manifest pins | Trusted certified roster pins |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `anthropic-sanitized` | `anthropic` | `anthropic-sanitized@1` | `anthropic-sanitized-v1@1` | none | `blocked-current-pack` | 0 | 0 | 0 |
| `codex-subscription-w4-offline` | `openai-codex` | `codex-subscription@1` | `codex-subscription-v1@1` | none | `blocked-current-pack` | 0 | 0 | 0 |
| `kimi-coding-plan-w4-provider-pack` | `kimi-coding` | `kimi-coding-plan@1` | `kimi-coding-plan-v1@1` | `precision` | `strict-w3-manifest` | 10 | 0 | 0 |
| `opencode-go-plan-w4-provider-pack` | `opencode-go` | `opencode-go-plan@1` | `opencode-go-plan-v1@1` | `precision` | `strict-w3-manifest` | 10 | 0 | 0 |
| `zai-coding-plan-w4-provider-pack` | `zai` | `zai-coding-plan@1` | `zai-coding-plan-v1@1` | `precision` | `strict-w3-manifest` | 40 | 0 | 0 |

### Route policies

| Provider | Route policy | Billing route | APIs | Auth classes | Auth sources | Service tiers | Cache policies | System prompt profiles | Policy state | Qualification state | Non-certifying seed | Requires live billing proof | Forbidden gateways |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `anthropic` | `anthropic-sanitized-v1@1` | `third-party-metered-blocked` | `anthropic-messages` | `api-key` | `runtime`, `stored` | `null` | `provider-default` | `anthropic-autopilot-sanitized.v1` | `blocked-live-certification` | `blocked-live-certification` | yes | yes | `arbitrary-api-key`, `metered-frontier`, `openrouter` |
| `openai-codex` | `codex-subscription-v1@1` | `subscription-oauth` | `openai-codex-responses` | `oauth` | `runtime`, `stored` | `null`, `priority` | `provider-default` | `pi-default.v1` | `unqualified-seed` | `unqualified-non-certifying-seed` | yes | yes | `arbitrary-api-key`, `metered-frontier`, `openrouter` |
| `kimi-coding` | `kimi-coding-plan-v1@1` | `plan-api-token` | `openai-completions` | `api-key-plan-token` | `runtime`, `stored` | `null` | `provider-default` | `pi-default.v1` | `unqualified-seed` | `unqualified-non-certifying-seed` | yes | yes | `arbitrary-api-key`, `metered-frontier`, `openrouter` |
| `opencode-go` | `opencode-go-plan-v1@1` | `plan-api-token` | `openai-completions` | `api-key-plan-token` | `runtime`, `stored` | `null` | `provider-default` | `pi-default.v1` | `unqualified-seed` | `unqualified-non-certifying-seed` | yes | yes | `arbitrary-api-key`, `metered-frontier`, `openrouter` |
| `zai` | `zai-coding-plan-v1@1` | `plan-api-token` | `openai-completions` | `api-key-plan-token` | `runtime`, `stored` | `null` | `provider-default` | `pi-default.v1` | `unqualified-seed` | `unqualified-non-certifying-seed` | yes | yes | `arbitrary-api-key`, `metered-frontier`, `openrouter` |

### Seed candidates

| Candidate | Profile | Recipe | Route policy | Roster ID | Revision | Roster SHA-256 | Assignment-set SHA-256 | Candidate state | Launch readiness | Qualification state | Non-certifying seed | Synthetic fixture ready only | Diagnostics |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `codex-afterburner-v1` | `afterburner` | `codex-subscription@1` | `codex-subscription-v1@1` | `afterburner-codex-subscription-7814ccd19c58` | 1 | `sha256:ba7d0cdd955589f24fb9afbb403057c8b5461fe9d62c8265b347ec7827578a85` | `sha256:7814ccd19c5807b001764c9a6a40f6d1e7e669c6fda29220c1f4e0e96c309e5d` | `qualification-required` | `not-ready-until-w4` | `unqualified-non-certifying-seed` | yes | no | `ROSTER_PRIORITY_PROOF_REQUIRED`, `ROSTER_QUALIFICATION_REQUIRED` |
| `codex-cruise-v1` | `cruise` | `codex-subscription@1` | `codex-subscription-v1@1` | `cruise-codex-subscription-bdb4f15f0ff9` | 1 | `sha256:f3ac0895d9abedfbe3616a79af0c1c3691962d24d5f17d195a78e6ab24d2b4a0` | `sha256:bdb4f15f0ff90aff9d1e46a3a56bfdfddabafcf3c7f5c293a7b558ff2f22a3c4` | `qualification-required` | `not-ready-until-w4` | `unqualified-non-certifying-seed` | yes | no | `ROSTER_CONVERGED_ASSIGNMENT_SET`, `ROSTER_QUALIFICATION_REQUIRED` |
| `anthropic-precision-v1` | `precision` | `anthropic-sanitized@1` | `anthropic-sanitized-v1@1` | `precision-anthropic-sanitized-b7321cad3237` | 1 | `sha256:15592a2eb13b6a89b89bbdb56193baed9cd14617457dcd510f45064802038a1e` | `sha256:b7321cad32374c9299499d1edbb6f0f2038f4bc5fdee82b9af892cea47bdc724` | `blocked-live-certification` | `blocked` | `blocked-live-certification` | yes | no | `ROSTER_QUALIFICATION_REQUIRED`, `ROSTER_ROUTE_FORBIDDEN` |
| `codex-precision-v1` | `precision` | `codex-subscription@1` | `codex-subscription-v1@1` | `precision-codex-subscription-bdb4f15f0ff9` | 1 | `sha256:3cb35e9f63613f85e8d586a3de6fe7e418d3bb935f088651ec3300d63f82b7f9` | `sha256:bdb4f15f0ff90aff9d1e46a3a56bfdfddabafcf3c7f5c293a7b558ff2f22a3c4` | `qualification-required` | `not-ready-until-w4` | `unqualified-non-certifying-seed` | yes | no | `ROSTER_QUALIFICATION_REQUIRED` |
| `kimi-coding-precision-v1` | `precision` | `kimi-coding-plan@1` | `kimi-coding-plan-v1@1` | `precision-kimi-coding-plan-af83b830e2e6` | 1 | `sha256:669061f5e1a419552c9b43f03e4ca4ca28f238b60283113d54f52000ef164a77` | `sha256:af83b830e2e6f39fa4558c88f0e4260ee1253e64bd0f8602745fe86d394d96c4` | `qualification-required` | `not-ready-until-w4` | `unqualified-non-certifying-seed` | yes | no | `ROSTER_QUALIFICATION_REQUIRED` |
| `opencode-go-precision-v1` | `precision` | `opencode-go-plan@1` | `opencode-go-plan-v1@1` | `precision-opencode-go-plan-b41a3cb01adc` | 1 | `sha256:132f02106fab13bd2c95812b4f26991c5cf3b23efb9dadeaa684e4c0728bdb07` | `sha256:b41a3cb01adcd2698fd58b49484898b1446650537c9fe7b09648fc8b08c6e00a` | `qualification-required` | `not-ready-until-w4` | `unqualified-non-certifying-seed` | yes | no | `ROSTER_QUALIFICATION_REQUIRED` |
| `zai-precision-v1` | `precision` | `zai-coding-plan@1` | `zai-coding-plan-v1@1` | `precision-zai-coding-plan-3e1073d30a26` | 1 | `sha256:563ee93ee2abc26b71ee75dcea58da4a23791cdfc9fd230154fbb434ee68f0dd` | `sha256:3e1073d30a26616a4a0ad3446d0b9719ff2ed93dd0981e08e0f9760ef0d2eaf8` | `qualification-required` | `not-ready-until-w4` | `unqualified-non-certifying-seed` | yes | no | `ROSTER_QUALIFICATION_REQUIRED` |
<!-- GENERATED:roster-readiness END -->

Interpretation of the tables:

- A provider pack with `readiness` `blocked-current-pack` is not readiness authority,
  even when its recipe and route policy are structurally valid.
- A provider pack with `readiness` `strict-w3-manifest` still certifies nothing while
  its trusted manifest and trusted certified roster pin counts are zero.
- A candidate is launchable only when
  `src/core/roster/activation-fence.ts` accepts it as `w4-certified-ready` with
  `non_certifying_seed=false`, `synthetic_fixture_ready_only=false`, registry readiness
  authority, a provider-pack binding, a certification manifest binding, a recipe hash,
  a route-policy hash, and an exact roster hash.
- Synthetic fixture success, offline structural compatibility, or a self-hashed
  manifest is not production certification.

## New-run precedence

`src/core/roster/resolve.ts` resolves new runs in exactly this order:

1. explicit `--roster <id>`;
2. trusted-project default under the trusted project authority root;
3. user default under the user authority root;
4. agent-first onboarding.

Any present higher-precedence authority that is corrupt, hash-mismatched, missing its
roster bytes, or untrusted blocks the run. Lower-precedence defaults are not consulted.
Existing runs do not use onboarding or defaults: they use only their immutable pre-run
selection plus the runtime mirror and pinned roster bytes.

## No-roster onboarding and inactive tool activation

When no selectable roster exists, `/autopilot` stays pre-run. `src/extension.ts`:

- verifies the packaged `autopilot-roster-setup` skill and payload by exact bytes and
  hashes via `src/core/roster/skill-package.ts`;
- registers and activates `autopilot_manage_rosters` for this ordinary Pi session only;
- emits a follow-up prompt beginning with `/skill:autopilot-roster-setup`, the activation
  token, the exact original `/autopilot ...` command, and the packaged skill/payload
  hashes;
- avoids parent model selection, worktree preparation, run creation, child launch,
  provider calls, tests, builds, or source mutation.

The tool is normally inactive. It rejects calls with a missing or stale activation token,
and `session_start`/`session_shutdown` deactivate it. `inspect`, `propose`/`refine`,
`doctor`, and `reject` are zero-write and zero-lock operations.

## Approval and save binding

The setup lane is an ordinary agent conversation, not a wizard. Natural language such
as an approval of the current recommendation can authorize a save only after the
package has presented the current exact approval facts. The host accepts only a
nonempty bounded `user`, `interactive`, or `rpc` input turn after that presentation; the
setup agent still owns the semantic interpretation.

The save request must bind the exact current values:

- `scope`;
- `candidate_set_sha256`;
- `approved_roster_sha256s` in proposal order;
- `default_roster_id`, `default_roster_revision`, `default_roster_sha256`;
- `original_command`.

Stale candidate sets, stale config, reordered or missing roster hashes, stale approval
tokens, non-user input sources, duplicate authorization, and unlaunchable candidates all
block before storage. Current offline W4 candidates are unlaunchable, so save blocks
with zero writes and zero locks unless a future package-reviewed live trust pin promotes
a candidate through the central registry.

A successful save, when possible, writes immutable roster revision files first, writes
`config.json` last, reads back every byte/hash, emits a secret-free receipt, sets
`fresh_session_required=true`, and forbids same-session auto-start. The user must open a
fresh Pi session and retry the receipt's original command byte-for-byte.

## Paths and authority roots

`src/core/roster/paths.ts` fixes the user root to `~/.pi/agent/autopilot/` unless a
test injects an absolute state root. Roster authority paths are:

| Authority | Path |
| --- | --- |
| User default config | `~/.pi/agent/autopilot/config.json` |
| User roster revision | `~/.pi/agent/autopilot/rosters/<roster-id>/revision-<revision>.json` |
| User pre-run selection | `~/.pi/agent/autopilot/roster-selections/<repo-id>/<workstream-run>.json` |
| Trusted-project config | `<trusted-project>/.autopilot/config.json` |
| Trusted-project roster revision | `<trusted-project>/.autopilot/rosters/<roster-id>/revision-<revision>.json` |

Trusted-project reads and writes require project trust. Pre-run selection files are
create-only: byte-identical replay is idempotent, different existing bytes are a
conflict.

## Strict v2 launch and observed identity

New runs materialize only `autopilot.unit_spec.v2` and `autopilot.receipt.v2`. The v2
spec pins `roster_id`, `roster_revision`, `roster_sha256`, `assignment_sha256`,
`pre_run_selection_sha256`, and the full `request_profile`. Before preflight authority
or spend, `autopilot-agent-run` authenticates all of these against:

- the active run/resource and runtime root;
- the runtime roster mirror under `.pi/autopilot/<workstream>/roster-snapshot.json`;
- the external create-only pre-run selection bytes;
- the pinned roster revision file;
- the role assignment and request-profile hash.

Historical `autopilot.unit_spec.v1` and `autopilot.receipt.v1` bytes remain historical
evidence only. They require exact grandfather or historical-adapter authority and are
never relabeled or enriched as v2.

At execution, the runner validates that the Pi request profile is exactly supportable
before model spend. With Pi `0.80.6`, supported pre-spend request-profile facts are the
provider/model/thinking/API route that Pi can set plus `service_tier=null`,
`cache_policy=provider-default`, and `system_prompt_profile=pi-default.v1`. Non-null
service tiers, non-default cache policies, and non-default prompt profiles are rejected
by the current adapter.

After the child finishes, `src/internal/execution-observer-extension.ts` records the
observed provider/model/API, system-prompt hash/profile, service tier, cache policy, and
route policy. Receipt v2 acceptance compares requested and observed profile fields and
fails closed on model, thinking, API, tier, cache, prompt, route, or hash drift.

## Provider route facts and custom/mixed contract boundaries

Provider routes are explicit facts, not provider-name inference. The generated route
policy table above is the authoritative current list of APIs, auth classes/sources,
service tiers, cache policies, system-prompt profiles, billing route classes, and
forbidden gateways.

OpenRouter, arbitrary API keys, and metered-frontier gateways are forbidden for these
roster routes. The contract schemas reserve `custom_roster`, `user-custom`, and
`autopilot.roster_transition.v1` terms, but at `bacbd85` production launch authority is
limited to centrally certified W4 provider-registry candidates plus byte-faithful
historical v1 adapter handling. Mixed billing routes are rejected by production seed
roster construction. Structural compatibility is not certified readiness.

## Transitions and history

Allowed transition semantics are explicit; only the bullets tied to existing source
paths are documented as shipped behavior:

- `setup-required` activates the setup lane and writes no run state.
- A certified save path publishes roster/config authority and requires a fresh session;
  current package candidates are not certified, so this path cannot produce launch
  authority from offline W4 seeds.
- A new run commits one immutable pre-run selection before worktree mutation or spend.
- The main worktree mirrors that selection for runtime recovery.
- Child materialization consumes v2 spec/receipt identity only after strict external,
  mirror, and roster authentication.
- Existing-run recovery requires external selection, mirror, spec identity, and pinned
  roster availability; otherwise it reports `ROSTER_PINNED_SELECTION_UNAVAILABLE` and
  `ROSTER_TRANSITION_REQUIRED`.
- Historical v1 evidence can pass only through the byte-faithful historical adapter and
  never mutates historical bytes.

## Troubleshooting

| Symptom / diagnostic | Meaning | Next safe action |
| --- | --- | --- |
| `ROSTER_QUALIFICATION_REQUIRED` | The candidate is structural or seed evidence only. | Wait for package-reviewed live W3 pins and a trusted certified roster hash; do not save it for launch. |
| `ROSTER_ROUTE_FORBIDDEN` | The route is blocked by policy, such as the current Anthropic metered route. | Choose no workaround; the route needs approved live certification. |
| `ROSTER_RECOMMENDED_PROFILE_BLOCKED` / `ROSTER_EXPLICIT_CHOICE_REQUIRED` | Cruise or the recommended profile is unavailable for launch. | Ask for an explicit qualified choice only when one exists. Current package has none. |
| `ROSTER_APPROVAL_STALE_CANDIDATE_SET` | Approval or save bindings no longer match the current proposal. | Re-present the current facts and request a new explicit approval turn. |
| `ROSTER_APPROVAL_STALE_CONFIG` | Stored default config changed after presentation. | Re-inspect and re-present before attempting save. |
| `ROSTER_PROJECT_UNTRUSTED` / `ROSTER_STORAGE_TRUST_REQUIRED` | Trusted-project scope lacks project trust. | Use user scope or restore project trust; do not write project authority. |
| `ROSTER_CREATE_ONLY_CONFLICT` | A selection or roster path already has different bytes. | Preserve existing bytes and investigate; do not overwrite. |
| `ROSTER_PINNED_SELECTION_UNAVAILABLE` | Existing-run selection/mirror/roster authentication failed. | Repair or recover the exact pinned artifacts; do not onboard as a replacement. |
| `pre-spend-profile-mismatch` | Pi cannot set the requested profile exactly before spend. | Use only a request profile supported by the current Pi adapter. |

## Related tests

Focused W0-W4 coverage lives in `tests/phase37/phase37-w0-contract-freeze.test.ts`,
`tests/unit/roster-*.test.ts`, `tests/e2e/roster-*.test.ts`,
`tests/model/roster-provider-*.test.ts`, `tests/sdk/roster-setup-sdk.test.ts`,
`tests/rpc/roster-setup-rpc.test.ts`, and `tests/package/roster-*.test.ts`.
