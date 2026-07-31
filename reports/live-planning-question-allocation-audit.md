# LIVE planning/question/allocation audit

Read-only audit under `live-functional-acceptance-amendment.md`. Package source/tests/data were not edited; only this report was written. LOC/readability debt is treated as waived structural debt for LIVE, but every behavior item below is non-waived.

## Current product path and LIVE blockers

### `/autopilot-plan` through P1-P6

1. Host registers generated commands in `src/commands.ts::registerAutopilotCommands`; `/autopilot-plan` is a generated `HOST_COMMANDS` raw command from `src/generated/host-runtime-tables.ts`.
2. Host sends `HostToCoreCommandPayload` through `forwardCommand` -> `CoreTransport.request("command", ...)`.
3. Core `drivers/src/seam/mod.rs::handle_line` decodes `SeamEnvelope`, calls generated `tables::admit_host_to_core`, then `dispatch` -> `command` -> `admit_operator_command`.
4. `admit_operator_command` still calls hidden runtime parser `routes()` from `data/seam_real_producers.rs` over `data/commands.kdl`; driver `planning` routes to `route_plan`.
5. `route_plan` runs P1/P2 locally: `TaskFiles::input_set` -> `planning::classify_task_file_pack`, `planning::p1_inventory_from_input_set`; `RepoGrounding::facts_for_atoms` runs `git rev-parse`, `git ls-files`, and reads files; `planning::p2_ground` builds a dossier.
6. `write_planning_manifest` writes `.pi/autopilot/<workstream>/planning-manifest.json` with assignments from `data/planning.kdl`.
7. `next_planning_outcome` launches waves from `planning::next_planning_wave`: P1.extract, P2.scout, P2.curate, optionally P3.resolve, P4.compile, P4.synth-1, P4.synth-2 canonical output, P5.review. `planning_wave_actions` issues agents via `runner::planning_issue`, records `agent:spawn`, and `controlled_spawn_wave` records `control:frame`.
8. Planning terminal carriers are accepted by `route_task_completed` for result contracts starting `planning.` or by legacy `agent-result`; both parse hidden `AgentCarrier` from `data/seam_real_producers.rs`, validate equality in `validate_planning_binding`, and validate raw model output via `runner::validate_child_boundary`.
9. P4 canonical work map side effect: `apply_planning_side_effects` writes `.pi/autopilot/<workstream>/work-map.md` only for canonical `planning.work-map.v1` assignments.
10. P5 plan review side effect: any shape-valid `planning.plan-review.v1` causes `apply_planning_side_effects` to read work-map, `parse_approved_units`, `write_approved_plan`, then `accept_planning_carrier` appends `planning:ready-to-execute`.
11. P6 is not implemented as a distinct conversational approval transition. There is no durable approval packet; plan review completion immediately becomes ready-to-execute.

### Questions and `/autopilot-answer`

- P3 is declared in `data/planning.kdl` as `planning_wave "P3.resolve" ... activation_ref="planning-resolution-required"` and `question_gate` declares classes.
- No production code emits `planning-resolution-required` from accepted `planning.questions.v1`; `planning_refs_from_state` only observes that ref if already present.
- `planning::accept_questions` validates only the model payload shape; `accept_planning_carrier` records it as ordinary `agent:result` with `planning-result-consumed:*`.
- `/autopilot-answer` is registered by `data/host-runtime.kdl` and `src/commands.ts::forwardOperatorAnswer`, but Core `dispatch` handles `HostToCoreRoute::OperatorAnswer(_) => done(id, "ok:recorded")` only. No event, artifact, journal, unblock, idempotency key, or restart behavior exists.

**LIVE blocker:** the Question Gate is ack-only/missing. Questions are not durable, cannot block planning, and answers cannot unblock anything.

### Approved plan persistence

Current `ApprovedPlanArtifact { units: Vec<ApprovedUnit> }` is hidden in `data/seam_real_producers.rs`. `approved_units_from_work_map` fabricates rather than preserves authority:

- criteria become synthetic ids `AC-<unit>-<n>` and lose exact criterion text;
- dependencies are linearized by array order instead of taken from WorkMap/plan authority;
- predecessor criteria become `FC<n>` and downstream edges `EDGE<n>`;
- decisions are just `unit.links`.

**LIVE blocker:** persisted approved plans do not preserve exact criteria/dependencies/edges and are not typed/generated/package-owned authority.

### `/autopilot` allocation/readiness/dispatch

1. Host `/autopilot` follows the same command route; `data/commands.kdl` maps to driver `allocation-dispatch-runner`, calling `route_run`.
2. `route_run` reads `.pi/autopilot/<workstream>/approved-plan.json` via hidden `read_approved_plan`.
3. It does **not** issue `execution-allocator`. Instead `allocation_submission_from_plan` deterministically synthesizes first-six lanes from approved units.
4. `allocation::validate_allocation` validates that synthesized submission. The model boundary `allocation::accept_lane_proposal` exists, the role `roles/execution-allocator/*` exists, and `data/known-incomplete-tools.kdl` explicitly says `autopilot_submit_allocation` is retained incomplete because “Core currently synthesizes allocation submissions”.
5. `lane_readiness_from_events` derives readiness from prefix refs `gate:*`, `blocker:*`, `unit-active:*` and a live `git rev-parse` preflight; these are not canonical persisted lifecycle facts.
6. `host_resource_facts` probes `df`, `/proc/meminfo`, or `sysctl` at dispatch time; facts are not package-persisted evidence.
7. `dispatch::select_ready_lanes` can return multiple ready lanes, but `route_run` uses only `selected.first()`.
8. `assignment`/`prepare_delivery_worktree` then creates one plain `git worktree add` branch worktree under `.pi/autopilot/<workstream>/worktrees/<lane>`. It bypasses `dispatch::launch_lanes` and `vcs::GitVcs::prepare`, which are the sparse worktree APIs used by component tests.
9. Delivery and validation terminal carrier acceptance are package-owned for `autopilot.delivery_result.v2` / `autopilot.validation_result.v2`, but no analogous allocation terminal carrier exists.

**LIVE blockers:** fake allocator, no allocation agent terminal carrier, no canonical resource/readiness facts, single-lane dispatch despite cap, and plain-worktree fallback.

## Dependency-ordered functional verticals

1. **Question Gate vertical**
   - Reuse: `planning::accept_questions`, `PlanningWaveOutcome`, `CoreState::append`, `runner::planning_issue`, Host `/autopilot-answer` adapter.
   - Add artifacts/events: `planning.questions.v1` content artifact, `planning:question-raised`, `planning:question-gate-open`, `operator:answer-recorded`, `planning:question-resolved`, `planning:question-gate-closed`.
   - Add APIs: `QuestionGateStore::record_questions`, `QuestionGateStore::record_answer`, `QuestionGateStore::pending(workstream)`, `PlanningFacade::resume_after_answers`.
   - Semantics: stable question ids from `(workstream, assignment_id, question index, question digest)`; create-once question artifacts; append-only answer journal keyed by question id and answer digest; duplicate answer is idempotent; conflicting duplicate rejects; restart folds events only. P3/P4/P5 are gated while material questions are pending.
   - Stop using: `OperatorAnswer(_) => ok:recorded`; bare `planning-result-consumed` for questions without question events.

2. **Typed planning carrier + approved plan vertical**
   - Reuse: `planning::accept_work_map`, `planning::accept_plan_review`, `TaskAnchorRegistry`, `runner::planning_issue`, `runner::AcceptedPlanningArtifactBinding`.
   - Add generated/kernel types: `PlanningCarrierV1`, `ApprovedPlanArtifactV1`, `ApprovedPlanUnitV1`, `PlanApprovalEnvelopeV1`.
   - Add events/artifacts: `planning:work-map-accepted`, `planning:plan-review-accepted`, `planning:approved-plan-written`, `planning:ready-to-execute` with approved-plan content ref and digest.
   - Semantics: approved plan preserves exact unit ids, objective, criteria ids/text, dependencies, predecessor criteria, downstream edges, links, review verdicts, and approval metadata. No fabricated `AC-*`, `FC*`, `EDGE*`.
   - Stop using/delete: hidden `AgentCarrier`, `ApprovedPlanArtifact`, `write_work_map`, `write_approved_plan`, `approved_units_from_work_map` as authority.

3. **Real Allocator issuance and terminal acceptance vertical**
   - Reuse: `allocation::accept_lane_proposal`, `allocation::validate_allocation`, `roles/execution-allocator`, `runner` spec/action patterns, terminal profile infrastructure.
   - Add APIs: `runner::allocation_issue(&AllocationRunnerRequest, &RunnerTransportFacts)`, `runner::accept_allocation_result`, `allocation::AllocationResultV1` package wrapper.
   - Add events/artifacts: `allocation:required`, `allocation:agent-spawned`, `allocation:result-accepted`, `allocation:canonical-lanes-written`.
   - Semantics: `/autopilot` from ready-to-execute issues an Allocator agent against approved-plan artifact; package accepts exactly one terminal allocation carrier bound to assignment/action/spec/profile and validates all lanes against approved plan. No deterministic first-six synthesis.
   - Stop using/delete: `allocation_submission_from_plan`; `data/known-incomplete-tools.kdl` retained-incomplete classification for `autopilot_submit_allocation` once terminal path is live.

4. **Canonical readiness/resource/multi-lane dispatch vertical**
   - Reuse: `dispatch::select_ready_lanes`, `dispatch::launch_lanes`, `kernel::schedule::ResourceFacts`, `vcs::GitVcs::prepare`.
   - Add events/artifacts: `resource:facts-observed`, `lane:readiness-recorded`, `lane:launch-action`, `lane:active`, `lane:blocked`, `lane:predecessor-satisfied`.
   - Semantics: readiness and resource facts are persisted package facts, folded by lane/unit; predecessor gates come from typed lane states, not `gate:*` prefixes. Dispatch launches every selected ready lane up to cap and records active lanes idempotently before spawning.
   - Stop using/delete: `lane_readiness_from_events`, `host_resource_facts`, `df_available_bytes`, `physical_memory_bytes`, `available_memory_bytes`, single `selected.first()` dispatch.

5. **Sparse VCS-only launch vertical**
   - Reuse: `GitVcs::prepare`, `dispatch::launch_lanes`, `runner::delivery_issue_with_facts`, `runner::reject_link_components_for_path`.
   - Add API: `LaneWorktreeService::prepare_sparse_lane(workstream, lane, base, sparse_profile)` returning persisted launch facts.
   - Semantics: all production lane worktrees are detached sparse worktrees from recorded run-main tip; no branch/plain checkout fallback and no operator checkout mutation.
   - Stop using/delete: `prepare_delivery_worktree`, `lane_branch_ref` branch launch path for delivery, raw seam `git_stdout` for worktree creation.

## Focused deterministic/mutation tests

- `/autopilot-plan` with question output creates pending questions and refuses P4/P5 until `/autopilot-answer` journals exact answers; restart between question and answer resumes exactly once.
- Duplicate same answer is idempotent; changed answer for same question id rejects; unknown question id rejects.
- Plan review blocker/failed verdict cannot write approved plan; positive approval preserves exact criteria/dependencies/edges from WorkMap.
- Approved-plan mutation dropping criterion text, dependency, predecessor criterion, or edge fails validation.
- `/autopilot` emits Allocator spawn first; no Implementer spawn occurs before allocation terminal carrier acceptance.
- Allocation carrier identity drift, unbound assistant JSON, changed approved authority, invented ownership, duplicate unit, and missing future reason reject without side effects.
- Multi-lane ready frontier launches N lanes up to cap; mutating route to `selected.first()` fails.
- Resource/readiness restart test proves dispatch is derived from persisted `resource:facts-observed`/`lane:readiness-recorded`, not live probes or prefixes.
- Production `git worktree add` without sparse `GitVcs::prepare` fails static and behavioral guards.
- Full product seam walkthrough: `/autopilot-plan` -> questions -> `/autopilot-answer` -> review -> approved plan -> `/autopilot` -> allocator -> multi-lane sparse delivery spawns.

## Immediate LIVE blockers vs waived structural debt

Immediate non-waived LIVE blockers:

1. `operator-answer` is ack-only and no Question Gate exists.
2. P3 questions do not block/unblock planning; `planning-resolution-required` is only externally injectable.
3. P6 approval is missing; plan-review shape acceptance directly writes ready-to-execute.
4. Approved plan persistence fabricates criteria/dependencies/edges.
5. `/autopilot` uses `allocation_submission_from_plan` instead of a real Allocator agent/result.
6. Allocator terminal tool/carrier is declared incomplete.
7. Readiness/resources are fake or live-probed, not canonical persisted facts.
8. Dispatch launches only `selected.first()`.
9. Production lane launch uses plain `git worktree add`, not sparse VCS.
10. Legacy `append:` remains capable of forging refs used by planning/final gates.

Structural debt waived for LIVE only, not to be relabeled green: Core/Host LOC/readability red, hidden include physical placement where behavior is unchanged, generated descriptor/runtime cleanup, runtime KDL parsers, tuple terminal-profile plumbing, and descriptor-only seam refactor.

LIVE_PLANNING_AUDIT_READY
