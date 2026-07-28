# DESIGN A — prompt pipeline, lens binding, context policy

## Evidence and verdicts

All source references are against the concurrently edited working tree. The following read-only audits returned `rc=0`:

- **E1 — template audit:** a Python comparison of every `roles/*/base.md` H2 list and every `roles/*/modes/*.md` H2 list against `data/driver-tables.kdl` printed `PASS roles=15 mode_templates=32`.
- **E2 — live SMF audit:** a Python audit of `/Users/lizavasilyeva/work/ai-pipeline/.pi/autopilot/schema-migration-framework/planning` printed seven 292,379-byte extractor prompts, one normalized SHA-256 for all seven (`f468ab…` after replacing `task-extractor-NN`), `raw_role_instruction False`, `raw_terminal_instruction False`, and mixed atom-kind sets for all seven carriers. It also proved SHA-256 of the raw `.md` equals `spec.prompt_digest`.
- **E3 — policy/parameter audit:** a Python parse of `data/roles.kdl` and `data/context-policy.kdl` printed 15 role policy references, zero explicit policy IDs, eight role/mode rows, and exactly one `mode_parameters` declaration.
- **E4 — runtime-reference audit:** `rg` found one `package-rendered` reference (the write at `drivers/src/seam/mod.rs:2038`), no read of that suffix, and no runtime inclusion/reference to `context-policy.kdl` under `drivers/`.

| Defect | Verdict | Verified evidence |
|---|---|---|
| D1 | **CONFIRMED** | `planning_issue` calls the hardcoded `planning_prompt` and writes it to the real path (`drivers/src/runner/mod.rs:315-316`; formatter at `:885`). That path becomes `AgentRunSpec.prompt_path` (`:338`). The child reads exactly it, verifies its digest, and passes the bytes as Pi `-p` (`drivers/src/runner/child.rs:100-110,122,527-556`). The seven-layer renderer exists (`drivers/src/prompt/mod.rs:61-106`) but its only production caller writes a differently suffixed file (`drivers/src/seam/mod.rs:1998-2040`); `controlled_spawn` invokes that audit path only after issue/binding (`:1089`). E2 proves the real-run consequence. E1 proves all 15 bases and all 32 declared mode templates satisfy `check_sections`' exact H2 order (`drivers/src/prompt/mod.rs:167-183`). |
| D2 | **PARTLY-WRONG** | The core defect is confirmed: the seven values are data (`data/roles.kdl:36-40`), parsed into `Role.mode_parameters` (`drivers/src/roles/mod.rs:14,60`), absent from `PromptInput` (`drivers/src/prompt/mod.rs:14-27`), and absent from `AgentAssignment`/allocation (`data/seam_real_producers.rs:24,52-64`). Only this role declares parameters (E3). E2 confirms identical normalized prompts and mixed outputs. Correction: the prompts also differ in the derived `action_id`, not only `assignment_id`; and the docs generator merely accepts/parses the node (`scripts/docs-generate.mjs:29,274-287`)—`renderRoles` does not render it (`:374-377`). |
| D3 | **PARTLY-WRONG** | Planning policies are absent and every planning issue receives the complete authority pack (`data/seam_real_producers.rs:66-80`); `planning_prompt` inlines every authority document and the first context (`drivers/src/runner/mod.rs:885-916`), while the post-issue mutator appends any further contexts (`data/seam_real_producers.rs:107-132`). The manifest used by the sidecar is an empty shell (`drivers/src/context/mod.rs:68-106`) and policy data is not a runtime input (E4). Correction: `data/context-policy.kdl:2-57` has rows named `implementer`, `validator`, `fixer`, and `curator`, but only implementer and validator IDs/modes match actual roles. `fixer`/`targeted-repair` and `curator`/`context-reprioritization` are orphan names; actual IDs/modes are `fixer-integrator` and `context-curator` (`data/roles.kdl:157-170,228-241`). The file defines no IDs such as `task-extractor.v1` at all (E3), and none of all 15 role references is cross-checked. |

### Further corrections that affect the design

1. A raw planning prompt does contain `role: task-extractor` and `mode: inventory` labels (`drivers/src/runner/mod.rs:887-900`); it lacks role **instructions**, prohibitions, declared terminal path, and output-contract text. Do not describe it as lacking every role label.
2. Planning children do **not** currently have `context_budget`. Role data declares it, but `is_builtin_tool` admits only `read/grep/find/ls/bash/edit/write` (`drivers/src/runner/mod.rs:1013-1018`); the spec receives that filtered list (`:333`), and Pi receives the spec list (`drivers/src/runner/child.rs:527-555`). Policy design must not rely on a nonexistent child tool.
3. Existing budget routing is observational only: it estimates the finalized spec, routes against hardcoded `200_000`, then records refs (`drivers/src/seam/mod.rs:2003-2035`). It neither consumes policy tiers nor changes/refuses the launch. `mandatory_pack` has only test callers (`drivers/src/context/mod.rs:61-66`; `tests/context_budget.rs:27-39`).
4. The sidecar manifest is not canonical for the assignment: `manifest_shell` hardcodes mode `lane-delivery`, empty freshness, `context_window: 0`, and empty tiers (`drivers/src/context/mod.rs:84-106`). Making the sidecar the real prompt without rebuilding it would promote another defect.
5. Later planning roles do not receive accepted extractor/scout artifacts. Every assignment is rebuilt from the original `TaskInputSet` (`data/seam_real_producers.rs:66-80,138-161`), and side effects retain only work-map/review products (`:173-179`). A policy asking for atom/scout ledgers therefore needs a durable accepted-artifact catalog; raw authority fallback is not an acceptable substitute.
6. `context-curator` is scheduled with `planning.scout-dossier.v1` (`data/seam_real_producers.rs:57` and `drivers/src/runner/mod.rs:627`) while its role terminal is `autopilot_submit_context` and its declared result contract is `context-curator.v1` (`data/roles.kdl:163-171`). Renderer cutover will expose this contradiction. Curator launch must fail until one generated, enforced contract/tool path is selected; do not silently show one contract and accept another.

## Design 1 — make the rendered prompt the bound prompt

### One-pass issuance

Replace the planning formatter path, not the child. `runner::planning_issue` must perform this order exactly:

1. validate the request, role/mode/parameter, complete task/context documents, and referenced accepted-artifact digests;
2. write a strict package-produced assignment artifact;
3. resolve the role policy and build/write the canonical context manifest;
4. resolve the output contract from `data/contracts.kdl`/`generated/prompts`, then call `prompt::render`;
5. write `RenderedPrompt.text` once to `RunnerPaths.prompt_path`, hash those bytes, and put that path/hash in the spec and binding;
6. write the spec and create the action.

Delete `planning_prompt` (`drivers/src/runner/mod.rs:885-917`) and delete `augment_planning_issue_with_context_documents` (`data/seam_real_producers.rs:107-136`). The request must carry `context_documents: Vec<RunnerTaskDocument>` from the start rather than one alias followed by JSON/file mutation. This removes the current digest rewrite and guarantees rendering sees all inputs.

Use the already-declared `AgentRunSpec.assignment_path/assignment_digest` and `context_manifest_path/context_manifest_digest` fields (`data/contracts.kdl:468-471`) instead of embedding the finalized spec as Layer 4. Extend `RunnerPaths` (`drivers/src/runner/mod.rs:244-248,552-573`) with deterministic `assignments/<id>.json` and `manifests/<id>.json` paths. Extend `IssuedRunnerBinding` with those four path/digest values so resume and carrier acceptance bind them.

The assignment artifact should be package-authored and internally strict:

```text
PlanningPromptAssignmentV1 {
  schema, workstream, action_id, assignment_id, run_revision,
  role_id, mode_id, mode_parameter: string|null,
  authority_set_id, context_policy_id, result_contract_id,
  upstream_assignment_ids: [id...], allowed_tools: [tool...], git_identity
}
```

Declare it in `data/contracts.kdl` near `task_document`/`agent_run_spec`; generate Rust/TS with codegen. It is not model-produced, so the loose model-output schema rule does not apply.

### Exact renderer input

Change `PromptInput` to add `mode_parameter: Option<String>` and replace the unstructured context string with:

```text
PromptContext {
  manifest_json: String,                    // exact persisted manifest bytes
  mandatory_inline: Vec<InlineContextBlock>
}
InlineContextBlock { item_id, source_uri, source_digest, content_digest, content }
```

Layer 5 renders the manifest and each inline block inside the existing quoted-data boundary. The context builder must verify every inline block against its manifest item and source/content digest before rendering.

Populate fields as follows:

- role/mode/parameter: persisted `AgentAssignment`;
- `assignment_revision`: SHA-256 of the canonical assignment artifact;
- `plan_revision`: digest of the immutable planning manifest plus accepted-artifact ledger at issue time;
- `runtime_revision`: request/run revision;
- `context_manifest_id`: generated manifest ID;
- `git_identity`: the planning manifest's pinned `HEAD`, never the current placeholder `planning-no-base-commit`;
- assignment: exact canonical assignment artifact bytes;
- context: policy builder output;
- contract: exact generated prompt text for `boundary_id`, found by artifact `schema` in `data/contracts.kdl`; missing/duplicate schema or generated file is a typed error. Do not use the shorter duplicate constants at `drivers/src/runner/mod.rs:27-35`;
- overlay: exact checkpoint/failure artifact when present, otherwise `None`.

The output contract resolver must be data-driven; no `boundary_id => filename` hand map. Role `boundary_prompts` remain additional contract material, with the current generated-source parity test retained.

### Sidecar decision

Remove `.package-rendered.md` and the prompt-rendering branch from `record_context_prompt_for_action`. The real `<assignment>.md` is already the audit artifact bound by SHA-256 in spec/binding/carrier; a second copy has no independent authority and can drift. Keep context/budget event refs, but derive them from the persisted manifest/binding produced before spawn. E2 already shows the two files have different hashes in the broken run.

The same shared issuance primitive should subsequently replace hardcoded `delivery_prompt` (`drivers/src/runner/mod.rs:919-941`) and `validator_prompt` (`drivers/src/seam/mod.rs:1542-1554`); until then, do not claim all 15 runtime roles are wired. The Goal-2 planning cutover is nevertheless a real production consumer, not unused renderer infrastructure.

## Design 2 — deterministic lens allocation and enforcement

### Binding and persistence

Add `mode_parameter: Option<String>` to internal `AgentAssignment`, `PlanningRunnerRequest`, and `PromptInput`. Persist it in the assignment artifact and the full assignment rows in `planning-manifest.json`; change `next_planning_assignment` to read that persisted plan rather than recomputing `AssignmentPlan::d72_default()` on every result (`data/seam_real_producers.rs:138-139`). Include the assignment digest (therefore the parameter) in session identity. On resume, current role data and the persisted plan must match exactly or resume fails as stale—never reassign a live ID.

`planning_assignments()` is the correct allocation point because it alone fixes role groups, counts, order, and stable `...-NN` IDs (`data/seam_real_producers.rs:52-64`). Make it return `Result`. Its generic cardinality law is:

```text
parameter_count == 0                 => every assignment gets None
parameter_count == assignment_count  => stable declaration-order zip to Some(value)
otherwise                            => ModeParameterCardinality error before any write/spawn
```

Thus five scouts with no declared parameters are valid without a scout special case; six extractors against seven declared parameters fail loudly. Reject empty/duplicate parameters in `RoleRegistry`.

For current data the persisted mapping is exactly `01 WORK`, `02 DECISION`, `03 CONSTRAINT`, `04 ACCEPTANCE`, `05 PREMISE`, `06 QUESTION`, `07 REFERENCE`. Put the exact parameter-to-`planning_atom_kind` mapping in `data/driver-tables.kdl`, not in substring/case guessing.

### Model delivery and value enforcement

Use one exact `{{MODE_PARAMETER}}` token in `roles/task-extractor/modes/inventory.md`: “Apply exactly one lens parameter: `{{MODE_PARAMETER}}`.” `Renderer::render` must require exactly one token when the role declares parameters, require a bound value from that role's closed list, substitute it in Layer 3, and reject a token/value for a parameterless role. This is preferable to an eighth layer (violates the seven-layer contract) or assignment-only placement (Layer 4 is explicitly quoted data, not the mode instruction). The assignment artifact also records the value for audit; it is not the instruction source.

Prompting is insufficient as an invariant. In both child value acceptance and seam carrier acceptance, strictly deserialize `TaskAtoms` and compare every parsed enum `kind` with the assigned parameter's exact data-table value. A mixed or wrong-lens payload becomes a typed value rejection and uses the existing bounded repair loop; it can never enter the accepted atom registry. No scan of model text is permitted.

## Design 3 — planning context policies that are real and lossless

### Registry and resolver

Replace the anonymous rows in `data/context-policy.kdl` with explicit resolvable entries:

```kdl
context_policy schema="autopilot.context_policy.v1" revision=2 {
  category id="task-authority" source="task-document" class="authority"
  category id="repository-context" source="task-document" class="context/non-authority"
  category id="task-atoms" source="accepted-planning-artifact" boundary="planning.task-atoms.v1"
  // scout-findings, compiler-work-maps, synthesized-work-map, review-verdicts,
  // contradiction-bundle, authority-index, artifact-index

  policy id="task-extractor.v1" role="task-extractor" {
    mode id="inventory" {
      mandatory_inline "authority-index"
      required_reads "task-authority"
      excluded "repository-context"
    }
  }
}
```

Implement `ContextPolicyRegistry` in new `drivers/src/context/policy.rs`; keep manifest construction in `drivers/src/context/planning.rs` and small generic budget/anchor primitives in `context/mod.rs`. At package validation/issue time require: every `Role.context_policy` ID exists; role IDs match; every declared mode has exactly one row; no unknown mode/category/tier duplication exists; all mandatory/required categories resolve to at least one available item. Missing mandatory/required input is a typed context gap and prevents spawn. Migrate all 15 references in the same change—otherwise fail-closed validation would correctly expose the currently orphaned nonplanning policies.

Build `ContextItem`s only from ground truth: classified `TaskDocument`s, pinned Git identity, and validated accepted carriers whose digests were recorded at acceptance. Add an immutable accepted-planning-artifact ledger (assignment, role, boundary, carrier path, payload digest) when `accept_planning_carrier` succeeds; later context resolution rehashes before use. Never classify a document by filename/content substring and never trust an unaccepted carrier merely because the file exists.

### Planning-role matrix

“Inline” below means body bytes in Layer 5. “Required read” means an exact repo-relative path/digest in the manifest that the built-in `read` tool can fetch from the pinned checkout. Indexes are package-generated path/class/digest/anchor records, not model summaries.

| Role/mode | `mandatory_inline` | `required_reads` | `on_demand` / excluded | Reason |
|---|---|---|---|---|
| task-extractor / inventory | authority index; lens is already in Layer 3/4 | **all authority documents, complete** | repository context excluded | A lens may occur anywhere in TASK/contracts/verification. `contracts.md` (178 KB in E2's run) need not be inline, but it must remain a complete required read. Grep-selected “relevant” clauses would be an ungrounded heuristic and could starve atoms. |
| repository-scout / initial-grounding | accepted atom index and assignment scope | atom carriers, their cited authority anchors, repository-evidence context | repository source anchors on demand | Scouts need task intent plus current facts, but non-authority evidence cannot create work. |
| plan-compiler / initial-plan | authority/atom/scout artifact indexes and assigned compiler scope | complete accepted atom and scout ledgers; authority sources cited by atoms | repository context/source anchors on demand | Compiler must account for all inputs without re-inlining the 291 KB pack. If no deterministic compiler scope exists, give every compiler the complete ledgers; do not invent semantic sharding. |
| context-curator / planning-context | current artifact index, measured overage, manifest gaps | atom/scout/compiler ledgers and current manifests | source bodies on demand | It selects navigation; it does not scout or author requirements. Launch remains blocked until its result contract mismatch is fixed. |
| plan-synthesizer / initial-plan | compiler-map index and package-generated atom/criterion coverage index | all accepted compiler maps plus atom/scout ledgers | cited task/repository sources on demand | Synthesis needs every proposal/trace, not duplicate raw authority by default. |
| plan-reviewer / full-review | canonical synthesized candidate(s) and trace/criterion index | task authority, atom/scout ledgers, compiler maps used by synthesis | repository source anchors on demand | Review must test omission/invention against ground truth; raw sources remain reachable. |
| contradiction-resolver / fact-resolution | one exact review finding/contradiction bundle with both sides | every source cited by that bundle and the affected plan/authority records | remaining ledgers/source anchors on demand | A resolver gets exact symmetric evidence. If no typed contradiction bundle exists, emit a context gap rather than all-authority fallback. |

The full task authority requirement for extractors is deliberate. Current task packs have no package-authored lens-to-section index. Until such an index is explicit authority, lossless lens-specific slicing is impossible; heading/keyword selection would violate the no-heuristics rule.

### Budget behavior

Make policy construction the production consumer of `estimate_tokens`, `route_budget`, and `mandatory_pack` before prompt/spec write. Obtain model context windows from roster data, not hardcoded `200_000`. Estimate rendered fixed layers + assignment + manifest + mandatory bodies exactly; record each required-read token estimate separately. `NormalLaunch` launches, `ReprioritizeOnce` may move only policy-permitted on-demand material, and `SplitAssignment` must create a deterministic persisted split or return a typed refusal. Never use the current unexplained `estimate / 2` as a “post-pass,” never truncate mandatory/required material, and never merely record a split route while launching unchanged.

Do not make this depend on child `context_budget`. If the concurrent RPC work later provides an attested package tool, it can report/check the same persisted manifest; policy correctness and prelaunch refusal remain Core-owned.

## Sequencing

1. **After merging Goal-1 contract/RPC edits**, land context-policy/category data, the planning-assignment contract, lens mapping, parsers, complete cross-validation, and generated outputs. This must precede renderer cutover because today's sidecar has an empty, wrong-mode manifest and a circular full-spec Layer 4.
2. Land deterministic assignment persistence, lens allocation, accepted-artifact ledger, and parameter-aware typed output validation. Prove cardinality, resume stability, and wrong-lens rejection failing-first.
3. Land context manifest construction/budget enforcement as a production input to `planning_issue`; remove post-issue context mutation.
4. Atomically switch `planning_issue` to the renderer, bind its real path/hash, and remove the sidecar. Do not leave “renderer now, runner consumer later.”
5. Cut delivery and validator issuance to the same primitive before claiming package-wide renderer completion; separately resolve the curator output-contract mismatch.

## Blast radius

### Production consumers

- `drivers/src/prompt/mod.rs`: input/context shapes, parameter substitution, contract resolution.
- `drivers/src/roles/mod.rs`: duplicate/empty parameter checks and policy cross-validation input.
- `drivers/src/context/{mod.rs,policy.rs,planning.rs}`: real policy registry, manifest builder, budget enforcement.
- `data/seam_real_producers.rs`: assignment result type/persistence, full context vectors, artifact ledger; remove augmentation.
- `drivers/src/runner/mod.rs`: request/binding/paths/session identity, planning issue cutover, delete formatter and duplicate contract text.
- `drivers/src/runner/child.rs` and `drivers/src/planning/mod.rs`: strict assignment/manifest digest checks and parameter-aware typed atom validation.
- `drivers/src/seam/mod.rs`: accepted-artifact digest recording, no sidecar renderer, prompt/context refs from issued binding.
- `data/contracts.kdl`, `data/context-policy.kdl`, `data/driver-tables.kdl`, `roles/task-extractor/modes/inventory.md`; generated Rust/TS/docs only through codegen.
- `scripts/docs-generate.mjs`/`docs/generated/roles.md`: render actual parameter values and policy IDs rather than silently accepting `mode_parameters`.

### Existing tests

- `tests/prompt_render.rs`: seven-layer order/quoted-data/generated-admits checks are **genuine invariants**; extend across all roles/modes and parameter token rules. Its current hand-built `PromptInput` needs the new context shape.
- `tests/task_path_classification.rs::task_path_classification_exact_four_path_command_spawns_and_hlo_replacement_does_not_mutate`: pack classification/order/context-non-authority checks are **genuine**. Assertions that all body sentinels occur in the prompt pin **broken eager inlining** (`:263-271`) and must become manifest tier/path/digest plus role/terminal assertions.
- `tests/runner_child.rs::autopilot_plan_preserves_multiple_context_documents_in_manifest_spec_and_prompt`: preserving every context document in spec/manifest is **genuine**; requiring `CTX1/CTX2` bodies in the initial prompt (`:213-218`) pins **broken eager inlining**. Direct-spec helpers must provide bound assignment/manifest artifacts once those become required.
- `tests/context_budget.rs::manifest_uses_generated_contract_fields`: generated shape is **genuine**; asserting every tier is empty (`:55-57`) pins the current shell and must be replaced with policy-resolved items. Threshold/no-truncation tests remain genuine.
- `tests/role_matrix_parity.rs`: role/tool/mode parity is **genuine**; the hardcoded phrase based on `role.id` (`:8-12`) does not test parameter values and must be replaced by exact list/order and complete policy-reference parity.
- `tests/planning_phases.rs`: assignment cap/counts remain **genuine**; add generic 0-or-exact cardinality and stable ordering tests.
- `tests/command_routing.rs`, `tests/task_path_classification.rs`, and carrier helpers that echo `prompt_path/prompt_digest` test **genuine binding identity** and should remain green with new bytes.
- Generated-doc/codegen checks will change legitimately for the new package artifact/policy rendering. No test may be weakened to keep the raw formatter or empty manifest.

## Falsifiability / required failing-first witnesses

1. **Renderer delivery:** production `autopilot-plan` test follows `spec.prompt_path`, asserts Layers 1–7, role prohibitions, terminal path, and exact generated output contract, and asserts the fake Pi `-p` bytes equal that file. Pre-fix witness: E2 prints both required instruction booleans `False`.
2. **No shadow copy:** the same route asserts no `.package-rendered.md` exists and the bound `.md` hash equals spec/binding/carrier. A current live sidecar exists and E4 finds its write, so this fails pre-fix.
3. **Lens map/resume:** route through all seven persisted assignments and assert the exact 01→WORK … 07→REFERENCE mapping before and after reopening state. Pre-fix assignment rows have no parameter.
4. **Cardinality:** a production allocator fixture with zero parameters/five assignments succeeds with five `None`; seven parameters/six assignments returns `ModeParameterCardinality` before writes. Pre-fix allocator cannot express either invariant.
5. **Lens enforcement:** submit strictly valid `TaskAtoms` containing two different parsed kinds to a WORK-bound child. It must value-reject and never record acceptance; current boundary-only validation accepts mixed kinds.
6. **Policy fail-closed:** delete/rename a referenced policy/category in a temp package registry and call the real issue path. It must return typed missing-policy/category before prompt/spec/action creation. Current issue path succeeds because policy is unread.
7. **Tier delivery:** use three authority + one context sentinels; extractor prompt must contain authority index and required-read paths/digests, not body sentinels or context body; all sources remain readable. Current tests/E2 prove bodies are eagerly present.
8. **Upstream ledger:** after accepting an extractor/scout carrier, the next compiler manifest must reference its recorded payload digest; mutate the carrier and issue must fail. Current compiler prompt is rebuilt only from the original `TaskInputSet`.
9. **Template matrix:** run the real renderer for every registered role/mode. E1 proves today's section structure, while the new test catches future missing files/sections and parameter-token misuse.

Every proposed semantic change above has a deterministic failing-first witness; none requires a live model assertion.

## No-regress list

- Keep seven layers and their authority order; assignment/context/runtime data remain injection-quoted.
- Keep SHA-256 prompt/spec/context binding, strict path/symlink checks, session reuse, existing-carrier validation, and bounded typed value-repair behavior.
- Keep subscription-only provider routing and API-key removal. No metered call is part of this design.
- Keep Core stdout newline-delimited JSON only; all subprocess output remains captured/piped.
- Keep model outputs typed and loose at the tool boundary; lens checking occurs after strict typed deserialization against closed data, never text scanning.
- Keep all task authority reachable and complete; repository context never creates task atoms. No budget route truncates mandatory/required content.
- Keep the exact variadic authority/context documents and their digests in the internal runner spec even when their bodies are not initially inlined to Pi.
- Do not hand-edit generated kernel/TS files or increase the kernel LOC budget.
- Missing policy, source, accepted-artifact digest, parameter, contract, or deterministic split is a loud typed refusal—never an empty manifest or raw-all-authority fallback.

## Conflict/serialization note

The operator is concurrently editing shared files. Serialize these implementation regions after Goal 1:

- `data/contracts.kdl`: this design adds `planning_prompt_assignment` immediately between current `task_document` (`~421-429`) and `agent_run_spec` (`~430`); it does **not** touch the operator's `agent_handoff` block at current `~505-513`. Run one combined codegen after both edits; retain both sets of generated changes in `kernel/src/generated/mod.rs` and `src/generated/index.ts`.
- `drivers/src/runner/mod.rs`: preserve operator `pub mod rpc;` at line 20. This design touches imports/constants `1-35`, `PlanningRunnerRequest` `107-119`, `IssuedRunnerBinding` `191-226`, `RunnerPaths` `244-248`, `planning_issue` `301-413`, `planning_paths` `552-573`, session/request/digest validation `635-850`, and deletes/replaces `planning_prompt` `885-917`. Goal-1 RPC integration may overlap issuance/child launch; merge semantically, never by whole-file replacement.
- Operator-owned tests that this design would later update: `tests/runner_child.rs` (multi-context and direct-spec helpers), `tests/planning_phases.rs` (assignment plan), `tests/role_matrix_parity.rs` (parameters/policies), and `tests/task_path_classification.rs` (real prompt assertions). Changes must be applied after the operator's versions, in named test functions only.

## Not verified

- I did not run Cargo, nextest, codegen, full gates, or any model call; this is a read-only design audit plus filesystem/source scripts.
- I did not prove delivery/validator/onboard/orchestrator runtime cutover; I only identified the additional hardcoded delivery/validator bypasses.
- I did not verify a child `context_budget` implementation because the current child tool filter proves it is absent.
- I did not design semantic per-heading lens slicing: current authority has no ground-truth lens index, so claiming a lossless slice would be invention.
- I did not resolve the `context-curator` result-contract/tool mismatch or the broader planning phase-order semantics; the design requires a loud block rather than a workaround.
