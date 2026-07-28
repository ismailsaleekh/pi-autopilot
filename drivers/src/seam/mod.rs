use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use kernel::boundary::Rejection;
use kernel::generated::{
    AllocationLaneProposal, BackgroundAction, CONTRACT_VERSION, CoreToHostDonePayload,
    CoreToHostGuardDecisionPayload, CoreToHostSpawnPayload, CoreToHostUiPayload, DeliveryBoundary,
    DeliveryResult, EventKind, EventRow, GuardDecision, HostToCoreAgentResultPayload,
    HostToCoreCommandPayload, HostToCoreGuardQueryPayload, HostToCoreOperatorAnswerPayload,
    HostToCoreShutdownPayload, HostToCoreTaskCompletedPayload, Id, ModeId, Ref, SeamEnvelope, Sha,
    TestId, UiKind,
};
use kernel::schedule::ResourceFacts;
use kernel::state::{State, apply};
use kernel_macros::acceptance_boundary;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::allocation::{self, AllocationPolicy, AllocationSubmission, ApprovedUnit, FutureUnit};
use crate::bgtasks;
use crate::dispatch::{self, DispatchInput, LaneReadiness};
use crate::handoff::{self, AssignmentHandle, CooperativeCheckpoint};
use crate::lifecycle::{self, AbortRequest, LocalLifecycle};
use crate::planning::{self, TaskAuthority};
use crate::roles::kdl::boundary_runtime;
use crate::roster;
use crate::runner::{self, RunnerAssignment};

pub mod sim_host;

const BOUNDARY_ID: &str = "seam.host-frame.v1";
const COMMAND_BOUNDARY_ID: &str = "seam.operator-command.v1";
const COMMANDS_KDL: &str = include_str!("../../../data/commands.kdl");
type AnyError = Box<dyn std::error::Error>;

#[derive(Debug)]
pub struct CoreState {
    event_path: Option<PathBuf>,
    state: State,
}
#[derive(Clone, Debug)]
pub struct Route {
    name: String,
    driver: String,
    args: String,
    expects: String,
}
#[derive(Clone, Debug)]
pub struct ParsedCommand {
    route: Route,
    args: Vec<String>,
}

impl CoreState {
    pub fn open(event_path: Option<PathBuf>) -> Result<Self, AnyError> {
        Ok(Self {
            state: match event_path.as_deref() {
                Some(path) => replay_path(path)?,
                None => State::EMPTY,
            },
            event_path,
        })
    }
    fn append(&mut self, kind: EventKind, artifact_refs: Vec<Ref>) -> Result<(), AnyError> {
        let event = EventRow {
            sequence: self
                .state
                .sequence
                .checked_add(1)
                .ok_or("event sequence overflow")?,
            previous_revision: self.state.revision,
            new_revision: self
                .state
                .revision
                .checked_add(1)
                .ok_or("event revision overflow")?,
            kind,
            artifact_refs,
        };
        if let Some(path) = &self.event_path {
            append_event(path, &event)?;
        }
        self.state = apply(self.state.clone(), &event);
        Ok(())
    }
    fn summary(&self) -> String {
        format!(
            "state:sequence={};revision={};hash={}",
            self.state.sequence,
            self.state.revision,
            self.state.state_hash().0
        )
    }
}

pub fn run<R: BufRead, W: Write>(
    reader: R,
    writer: &mut W,
    state: &mut CoreState,
) -> Result<(), AnyError> {
    for line in reader.lines() {
        write_frame(writer, &handle_line(&line?, state)?)?;
    }
    Ok(())
}

pub fn handle_line(line: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let envelope = match serde_json::from_str::<SeamEnvelope>(line) {
        Ok(frame) => frame,
        Err(error) => return done(0, rejection("malformed-json", &error.to_string())),
    };
    let id = envelope.id;
    match admit_host_frame(envelope) {
        Ok(frame) => dispatch(frame, state),
        Err(error) => done(id, rejection(error.boundary_id(), error.actual())),
    }
}

#[acceptance_boundary(
    id = "seam.host-frame.v1",
    producer = Producer::Host,
    visible = true,
    admits = "Host newline JSON must be contract v=1 with a known host-to-core kind and generated payload shape.",
    mode = BoundaryMode::Enforce
)]
pub fn admit_host_frame(frame: SeamEnvelope) -> Result<SeamEnvelope, Rejection> {
    if frame.v != CONTRACT_VERSION as u32 {
        boundary_runtime(BOUNDARY_ID).reject(format!("version-mismatch:{}", frame.v))?;
    }
    match frame.kind.as_str() {
        "agent-result" => payload::<HostToCoreAgentResultPayload>(&frame)?,
        "command" => payload::<HostToCoreCommandPayload>(&frame)?,
        "guard-query" => payload::<HostToCoreGuardQueryPayload>(&frame)?,
        "operator-answer" => payload::<HostToCoreOperatorAnswerPayload>(&frame)?,
        "shutdown" => payload::<HostToCoreShutdownPayload>(&frame)?,
        "task-completed" => payload::<HostToCoreTaskCompletedPayload>(&frame)?,
        other => boundary_runtime(BOUNDARY_ID).reject(format!("unknown-kind:{other}"))?,
    }
    Ok(frame)
}

#[acceptance_boundary(
    id = "seam.operator-command.v1",
    producer = Producer::Operator,
    visible = true,
    admits = "Valid invocations are exactly: /autopilot-plan <workstream> <task-paths...>; /autopilot <workstream>; /autopilot-status; /autopilot-close <workstream>; /autopilot-abort <workstream>; /autopilot-config show; /autopilot-config parallel-cap <n>; /autopilot-handoff; /autopilot-inject <workstream>; /autopilot-onboard <request...>.",
    mode = BoundaryMode::Enforce
)]
pub fn admit_operator_command(raw: &str) -> Result<ParsedCommand, Rejection> {
    let routes = match routes() {
        Ok(value) => value,
        Err(error) => return command_reject(format!("commands.kdl:{error}")),
    };
    let trimmed = raw.trim().trim_start_matches('/');
    let mut words = trimmed.split_whitespace();
    let Some(name) = words.next() else {
        return command_reject(format!("expected={};actual=<empty>", valid(&routes)));
    };
    let Some(route) = routes.iter().find(|item| item.name == name).cloned() else {
        return command_reject(format!("unknown-command:{name};valid={}", valid(&routes)));
    };
    let args = words.map(str::to_owned).collect::<Vec<_>>();
    if !args_valid(&route.args, &args) {
        return command_reject(format!("expected={};actual={raw}", route.expects));
    }
    Ok(ParsedCommand { route, args })
}

fn dispatch(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    match frame.kind.as_str() {
        "command" => command(frame, state),
        "agent-result" => route_agent_result(frame, state),
        "guard-query" => guard_decision(frame.id, "deny", "core guard policy is not configured"),
        "shutdown" => done(frame.id, "ok:shutdown".to_owned()),
        "task-completed" => route_task_completed(frame, state),
        "operator-answer" => done(frame.id, "ok:recorded".to_owned()),
        other => done(frame.id, rejection("unknown-kind", other)),
    }
}

fn command(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let HostToCoreCommandPayload {
        raw,
        background_capabilities,
        background_capability_diagnostic,
    } = serde_json::from_value(frame.payload)?;
    if raw == "state" {
        return done(frame.id, state.summary());
    }
    if matches!(raw.as_str(), "append" | "crash-window") {
        return done(frame.id, rejection("malformed-command", &raw));
    }
    if raw.starts_with("append:") || raw.starts_with("crash-window:") || raw.starts_with("state:") {
        if let Some((verb, rest)) = raw.split_once(':') {
            return legacy_command(frame.id, verb, rest, state);
        }
    }
    let parsed = match admit_operator_command(&raw) {
        Ok(value) => value,
        Err(error) => return done(frame.id, boundary_status(&error)),
    };
    let caps = bgtasks::BgCapabilities::from_generated(&background_capabilities);
    product_command(
        frame.id,
        parsed,
        state,
        &caps,
        background_capability_diagnostic.as_deref(),
    )
}

fn legacy_command(
    id: u64,
    verb: &str,
    rest: &str,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let pause = match verb {
        "append" => false,
        "crash-window" => true,
        "state" => return done(id, rejection("malformed-command", verb)),
        other => return done(id, rejection("unknown-command", other)),
    };
    let (kind, reference) = match event_parts(rest) {
        Ok(parts) => parts,
        Err(status) => return done(id, status),
    };
    state.append(kind, vec![reference])?;
    if pause {
        eprintln!("autopilot-core: crash-window-ready {}", state.summary());
        thread::sleep(Duration::from_secs(30));
    }
    done(id, state.summary())
}

fn product_command(
    id: u64,
    parsed: ParsedCommand,
    state: &mut CoreState,
    caps: &bgtasks::BgCapabilities,
    diagnostic: Option<&str>,
) -> Result<SeamEnvelope, AnyError> {
    let result = match parsed.route.driver.as_str() {
        "planning" => bgtasks::require_before_mutation(caps, diagnostic, || {
            route_plan(id, &parsed.args, state)
        })
        .unwrap_or_else(|error| done(id, bgtasks::pause_status(&error))),
        "allocation-dispatch-runner" => bgtasks::require_before_mutation(caps, diagnostic, || {
            route_run(id, &parsed.args[0], state)
        })
        .unwrap_or_else(|error| done(id, bgtasks::pause_status(&error))),
        "state" => done(id, state.summary()),
        "lifecycle-close" => route_close(id, &parsed.args, state),
        "lifecycle-abort" => route_abort(id, &parsed.args[0], state),
        "roster-config" => route_config(id, &parsed.args),
        "handoff" => route_handoff(id),
        "workstream-attach" => {
            let key = crate::state_root::repo_key(".")
                .map_err(|error| format!("state-root:{error:?}"))?;
            state.append(
                EventKind("workstream-attach".to_owned()),
                vec![Ref(parsed.args[0].clone()), Ref(key.0)],
            )?;
            done(
                id,
                format!("attach:workstream={};{}", parsed.args[0], state.summary()),
            )
        }
        "planning-onboard" => route_onboard(id, &parsed.args),
        other => done(id, rejection("unknown-driver", other)),
    };
    match result {
        Ok(frame) => Ok(frame),
        Err(error) => done(id, rejection("driver-error", &error.to_string())),
    }
}

fn route_plan(id: u64, args: &[String], state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let workstream = &args[0];
    let source = TaskFiles(args[1..].iter().map(PathBuf::from).collect());
    let input_set = source
        .input_set()
        .map_err(|error| context_status("planning", error))?;
    let inventory = planning::p1_inventory_from_input_set(&input_set)
        .map_err(|error| context_status("planning", error))?;
    let cwd = std::env::current_dir()?;
    let dossier = planning::p2_ground(&RepoGrounding { repo: cwd }, &inventory)
        .map_err(|error| context_status("planning", error))?;
    let plan = planning::AssignmentPlan::d72_default();
    plan.validate(25)
        .map_err(|error| context_status("planning", error))?;
    let assignments = planning_assignments(workstream, &plan);
    let first = assignments
        .first()
        .ok_or("planning assignment plan is empty")?;
    write_planning_manifest(workstream, &input_set, &inventory, &dossier, &assignments)?;
    let issue = planning_bg_action(workstream, first, state.state.revision, &input_set)?;
    append_runner_invocation(state, &issue.binding)?;
    spawn(id, issue.action)
}

fn route_run(id: u64, workstream: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let approved = read_approved_plan(workstream)
        .map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
    let submission = allocation_submission_from_plan(workstream, &approved)
        .map_err(|error| format!("CONTEXT_GAP:allocation:{error}"))?;
    let allocation = allocation::validate_allocation(
        &approved,
        &submission,
        AllocationPolicy {
            parallel_cap: 8,
            active_implementers: active_implementers(state),
        },
    )
    .map_err(|error| format!("allocation:{error:?}"))?;
    let readiness = lane_readiness_from_events(&submission.lanes, &approved, state);
    let resources =
        host_resource_facts().map_err(|error| format!("CONTEXT_GAP:resources:{error}"))?;
    let selected = dispatch::select_ready_lanes(&DispatchInput {
        lanes: allocation.lanes,
        readiness,
        active_implementers: active_implementers(state),
        parallel_cap: 8,
        resources,
    });
    let Some(lane_id) = selected.first() else {
        return done(id, rejection("dispatch", "no-ready-lane"));
    };
    let assignment = assignment(workstream, lane_id)?;
    let issue =
        runner::delivery_issue_with_facts(&assignment, &runner::RunnerTransportFacts::from_env()?)?;
    append_runner_invocation(state, &issue.binding)?;
    spawn(id, issue.action)
}

fn route_agent_result(
    frame: SeamEnvelope,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let HostToCoreAgentResultPayload {
        assignment_id,
        carrier,
    } = serde_json::from_value(frame.payload)?;
    let carrier: AgentCarrier = match serde_json::from_value(carrier) {
        Ok(value) => value,
        Err(error) => {
            return done(
                frame.id,
                rejection("agent-result-carrier", &error.to_string()),
            );
        }
    };
    accept_planning_carrier(frame.id, &assignment_id, carrier, state, None)
}

fn accept_planning_carrier(
    id: u64,
    assignment_id: &Id,
    carrier: AgentCarrier,
    state: &mut CoreState,
    terminal: Option<&HostToCoreTaskCompletedPayload>,
) -> Result<SeamEnvelope, AnyError> {
    if carrier.schema != "autopilot.planning_carrier.v1" || carrier.assignment_id != assignment_id.0
    {
        return done(
            id,
            rejection("agent-carrier-identity", &carrier.assignment_id),
        );
    }
    let binding = match binding_for(state, &carrier.action_id, &carrier.assignment_id) {
        Ok(value) => value,
        Err(error) => return done(id, rejection("terminal-binding", &error)),
    };
    if let Err(error) = validate_planning_binding(&carrier, &binding) {
        return done(id, rejection("agent-carrier-binding", &error));
    }
    if let Err(error) = validate_agent_output(&carrier.boundary_id, &carrier.raw_output) {
        return done(id, boundary_status(&error));
    }
    if let Some(payload) = terminal {
        append_terminal_event(state, payload, &binding)?;
    }
    state.append(
        EventKind("agent:result".to_owned()),
        vec![
            Ref(assignment_id.0.clone()),
            Ref(carrier.action_id.clone()),
            Ref(carrier.boundary_id.clone()),
            Ref(carrier.workstream.clone()),
            Ref(carrier.spec_digest.clone()),
        ],
    )?;
    if carrier.boundary_id == "planning.work-map.v1" {
        write_work_map(&carrier.workstream, &carrier.raw_output)?;
    }
    if carrier.boundary_id == "planning.plan-review.v1" {
        let work_map = read_work_map(&carrier.workstream)
            .map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
        let units = parse_approved_units(&work_map)
            .map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
        write_approved_plan(&carrier.workstream, &units)?;
        state.append(
            EventKind("planning:ready-to-execute".to_owned()),
            vec![
                Ref(carrier.workstream.clone()),
                Ref(plan_path(&carrier.workstream).display().to_string()),
            ],
        )?;
        return done(
            id,
            format!(
                "ready-to-execute:workstream={};{}",
                carrier.workstream,
                state.summary()
            ),
        );
    }
    if let Some(next) = next_planning_assignment(&carrier.workstream, state) {
        let input_set = read_planning_input_set(&carrier.workstream)
            .map_err(|error| format!("CONTEXT_GAP:planning-manifest:{error}"))?;
        let issue =
            planning_bg_action(&carrier.workstream, &next, state.state.revision, &input_set)?;
        append_runner_invocation(state, &issue.binding)?;
        return spawn(id, issue.action);
    }
    done(
        id,
        format!(
            "agent-result:accepted:{};{}",
            carrier.boundary_id,
            state.summary()
        ),
    )
}

fn route_task_completed(
    frame: SeamEnvelope,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let payload: HostToCoreTaskCompletedPayload = serde_json::from_value(frame.payload)?;
    let binding = match binding_for(state, &payload.action_id.0, &payload.assignment_id.0) {
        Ok(value) => value,
        Err(error) => return done(frame.id, rejection("terminal-binding", &error)),
    };
    if terminal_consumed(state, &binding) {
        return done(frame.id, rejection("terminal-binding", "already-consumed"));
    }
    if !terminal_status_allowed(&payload.status) {
        return done(frame.id, rejection("terminal-status", &payload.status));
    }
    if payload.status != "completed" {
        append_terminal_event(state, &payload, &binding)?;
        return done(frame.id, state.summary());
    }
    let carrier_path = PathBuf::from(&binding.carrier_path);
    let carrier_text = match fs::read_to_string(&carrier_path) {
        Ok(value) => value,
        Err(error) => {
            return done(
                frame.id,
                rejection("carrier-read", &format!("{}:{error}", binding.carrier_path)),
            );
        }
    };
    if binding.result_contract.0 == "autopilot.delivery_result.v1" {
        let result: DeliveryResult = match serde_json::from_str(&carrier_text) {
            Ok(value) => value,
            Err(error) => {
                return done(
                    frame.id,
                    rejection(
                        "delivery-carrier",
                        &format!("{}:{error}", binding.carrier_path),
                    ),
                );
            }
        };
        let expected = match delivery_expectation_from_binding(&binding) {
            Ok(value) => value,
            Err(error) => return done(frame.id, rejection("delivery-binding", &error)),
        };
        let accepted = match runner::accept_delivery(&[result], &expected) {
            Ok(value) => value,
            Err(error) => {
                return done(
                    frame.id,
                    rejection("delivery-rejected", &format!("{error:?}")),
                );
            }
        };
        append_terminal_event(state, &payload, &binding)?;
        state.append(
            EventKind("agent:delivery-accepted".to_owned()),
            vec![
                Ref(binding.assignment_id.0.clone()),
                Ref(binding.action_id.0.clone()),
                Ref(accepted.package_commit.0),
                Ref(accepted.package_tree.0),
                accepted.audit_ref,
            ],
        )?;
        return done(
            frame.id,
            format!(
                "delivery:accepted:{};{}",
                binding.assignment_id.0,
                state.summary()
            ),
        );
    }
    let carrier: AgentCarrier = match serde_json::from_str(&carrier_text) {
        Ok(value) => value,
        Err(error) => {
            return done(
                frame.id,
                rejection(
                    "agent-carrier",
                    &format!("{}:{error}", binding.carrier_path),
                ),
            );
        }
    };
    accept_planning_carrier(
        frame.id,
        &payload.assignment_id,
        carrier,
        state,
        Some(&payload),
    )
}

fn validate_planning_binding(
    carrier: &AgentCarrier,
    binding: &runner::IssuedRunnerBinding,
) -> Result<(), String> {
    if carrier.action_id != binding.action_id.0
        || carrier.assignment_id != binding.assignment_id.0
        || carrier.run_revision != binding.run_revision
        || carrier.workstream != binding.workstream.0
        || carrier.role_id != binding.role_id.0
        || carrier.mode != binding.mode.0
        || carrier.boundary_id != binding.boundary_id.0
        || carrier.result_contract != binding.result_contract.0
        || carrier.prompt_path != binding.prompt_path
        || carrier.prompt_digest != binding.prompt_digest
        || carrier.boundary_digest != binding.boundary_digest
        || carrier.result_contract_digest != binding.result_contract_digest
        || carrier.settings_digest != binding.settings_digest
        || carrier.context_digest != binding.context_digest
        || carrier.skills_digest != binding.skills_digest
        || carrier.subscription_digest != binding.subscription_digest
        || carrier.spec_digest != binding.spec_digest
        || carrier.spec_path != binding.spec_path
        || carrier.carrier_path != binding.carrier_path
    {
        return Err(format!(
            "expected action={} assignment={} revision={} boundary={}",
            binding.action_id.0,
            binding.assignment_id.0,
            binding.run_revision,
            binding.boundary_id.0
        ));
    }
    if binding.result_contract.0 == "autopilot.delivery_result.v1" {
        return Err("planning carrier for delivery binding".to_owned());
    }
    Ok(())
}

fn binding_for(
    state: &CoreState,
    action_id: &str,
    assignment_id: &str,
) -> Result<runner::IssuedRunnerBinding, String> {
    let mut matches = state
        .state
        .refs
        .keys()
        .filter_map(|reference| runner::decode_binding_ref(&reference.0))
        .filter(|binding| {
            binding.action_id.0 == action_id && binding.assignment_id.0 == assignment_id
        })
        .collect::<Vec<_>>();
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err(format!(
            "unknown action/assignment: {action_id}/{assignment_id}"
        )),
        count => Err(format!(
            "ambiguous action/assignment: {action_id}/{assignment_id}:{count}"
        )),
    }
}

fn terminal_consumed(state: &CoreState, binding: &runner::IssuedRunnerBinding) -> bool {
    state
        .state
        .refs
        .contains_key(&terminal_consumed_ref(binding))
}

fn append_terminal_event(
    state: &mut CoreState,
    payload: &HostToCoreTaskCompletedPayload,
    binding: &runner::IssuedRunnerBinding,
) -> Result<(), AnyError> {
    let task_binding = serde_json::json!({"task_id":payload.task_id,"action_id":payload.action_id,"assignment_id":payload.assignment_id,"run_revision":binding.run_revision});
    state.append(
        EventKind("background:terminal".to_owned()),
        vec![
            Ref(payload.task_id.0.clone()),
            Ref(payload.action_id.0.clone()),
            Ref(payload.assignment_id.0.clone()),
            Ref(payload.status.clone()),
            Ref(binding.run_revision.to_string()),
            Ref(format!("task-binding:{task_binding}")),
            terminal_consumed_ref(binding),
        ],
    )
}

fn terminal_consumed_ref(binding: &runner::IssuedRunnerBinding) -> Ref {
    Ref(format!(
        "terminal-consumed:{}:{}:{}",
        binding.action_id.0, binding.assignment_id.0, binding.run_revision
    ))
}

fn terminal_status_allowed(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "killed" | "interrupted" | "canceled" | "cancelled"
    )
}

fn delivery_expectation_from_binding(
    binding: &runner::IssuedRunnerBinding,
) -> Result<runner::DeliveryExpectation, String> {
    Ok(runner::DeliveryExpectation {
        assignment_id: binding.assignment_id.clone(),
        role_id: binding.role_id.clone(),
        mode: binding.mode.clone(),
        run_revision: binding.run_revision,
        lane_id: binding
            .lane_id
            .clone()
            .ok_or_else(|| "missing lane_id".to_owned())?,
        attempt: binding
            .attempt
            .ok_or_else(|| "missing attempt".to_owned())?,
        base_commit: binding
            .base_commit
            .clone()
            .ok_or_else(|| "missing base_commit".to_owned())?,
        worktree: PathBuf::from(
            binding
                .worktree
                .clone()
                .ok_or_else(|| "missing worktree".to_owned())?,
        ),
        required_focused_evidence: binding.required_focused_evidence as usize,
        binding: Some(runner::DeliveryBindingExpectation {
            action_id: binding.action_id.clone(),
            prompt_path: binding.prompt_path.clone(),
            prompt_digest: binding.prompt_digest.clone(),
            spec_path: binding.spec_path.clone(),
            spec_digest: binding.spec_digest.clone(),
            carrier_path: binding.carrier_path.clone(),
            boundary_digest: binding.boundary_digest.clone(),
            result_contract_digest: binding.result_contract_digest.clone(),
            settings_digest: binding.settings_digest.clone(),
            context_digest: binding.context_digest.clone(),
            skills_digest: binding.skills_digest.clone(),
            subscription_digest: binding.subscription_digest.clone(),
        }),
    })
}

fn route_config(id: u64, args: &[String]) -> Result<SeamEnvelope, AnyError> {
    let roster = roster::Roster::package().map_err(|error| format!("roster:{error:?}"))?;
    let Some(slot) = roster.slots().next() else {
        return done(id, rejection("roster", "empty"));
    };
    roster::guard_route(&slot.route()).map_err(|error| format!("roster:{error:?}"))?;
    ui(
        id,
        "text",
        serde_json::json!({"driver":"roster-config","slots":roster.slots().count(),"request":args}),
    )
}

fn route_handoff(id: u64) -> Result<SeamEnvelope, AnyError> {
    let active = vec![AssignmentHandle {
        assignment_id: idv("handoff-a1"),
        task_id: idv("task-1"),
        child_session_ref: Ref("session:1".to_owned()),
        worktree_ref: Ref("worktree:1".to_owned()),
    }];
    let outcome = handoff::intentional_handoff(
        &active,
        &[CooperativeCheckpoint {
            assignment_id: idv("handoff-a1"),
            checkpoint_ref: Ref("checkpoint:1".to_owned()),
        }],
    );
    ui(
        id,
        "text",
        serde_json::json!({"driver":"handoff","actions":outcome.actions.len(),"retained":outcome.retained_child_sessions.len()}),
    )
}

fn route_onboard(id: u64, args: &[String]) -> Result<SeamEnvelope, AnyError> {
    let source = InlineTask(args.join(" "));
    let inventory =
        planning::p1_inventory(&source).map_err(|error| format!("planning:{error:?}"))?;
    ui(
        id,
        "text",
        serde_json::json!({"driver":"planning-onboard","atoms":inventory.atoms.len()}),
    )
}

fn route_abort(id: u64, workstream: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let cwd = std::env::current_dir()?;
    let report = LocalLifecycle::new(&cwd, &cwd, cwd.join(".pi/autopilot/archive"))
        .abort(AbortRequest {
            workstream: workstream.to_owned(),
            run_id: format!("run-{}", state.state.revision + 1),
            reason: "operator abort command".to_owned(),
            evidence: Vec::<lifecycle::ProtectedEvidence>::new(),
        })
        .map_err(|error| format!("lifecycle:{error:?}"))?;
    done(
        id,
        format!("lifecycle:abort:archive={}", report.archive_dir.display()),
    )
}

fn route_close(id: u64, args: &[String], state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let request = match parse_close_request_args(args) {
        Ok(value) => value,
        Err(error) => return done(id, rejection("seam.operator-command.v1", &error)),
    };
    if !state.state.refs.contains_key(&Ref("final-verification-pass".to_owned())) {
        return done(
            id,
            rejection(
                "lifecycle-close",
                &format!(
                    "NotReadyToClose:workstream={};run={};expected_revision={};expected_event_tip={};expected_tip={};expected_tree={};expected_final_digest={}",
                    request.workstream,
                    request.run_id,
                    request.expected_revision,
                    request.expected_event_tip,
                    request.expected_tip,
                    request.expected_tree,
                    request.expected_final_digest
                ),
            ),
        );
    }
    done(
        id,
        rejection(
            "lifecycle-close",
            "NotReadyToClose:authoritative close finalizer is not assembled; no result ref/archive/event was created",
        ),
    )
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct ParsedCloseRequestArgs {
    workstream: String,
    run_id: String,
    expected_revision: u64,
    expected_event_tip: String,
    expected_tip: String,
    expected_tree: String,
    expected_final_digest: String,
}

fn parse_close_request_args(args: &[String]) -> Result<ParsedCloseRequestArgs, String> {
    if args.len() != 13 {
        return Err("expected=/autopilot-close <workstream> --run <run-id> --expected-revision <u64> --expected-event-tip <sha256:...> --expected-tip <git-oid> --expected-tree <git-oid> --expected-final-digest <sha256:...>".to_owned());
    }
    let workstream = args[0].clone();
    let pairs = [
        ("--run", 1usize),
        ("--expected-revision", 3usize),
        ("--expected-event-tip", 5usize),
        ("--expected-tip", 7usize),
        ("--expected-tree", 9usize),
        ("--expected-final-digest", 11usize),
    ];
    for (flag, index) in pairs {
        if args[index] != flag {
            return Err(format!("expected close flag {flag} at position {index}, got {}", args[index]));
        }
    }
    for value_index in [2usize, 4, 6, 8, 10, 12] {
        if args[value_index].starts_with('-') {
            return Err(format!("close value at position {value_index} is missing"));
        }
    }
    let expected_revision = args[4]
        .parse::<u64>()
        .map_err(|_| "--expected-revision must be a u64".to_owned())?;
    if !is_sha256_ref(&args[6]) || !is_sha256_ref(&args[12]) {
        return Err("expected-event-tip and expected-final-digest must be sha256:<64 lowercase hex>".to_owned());
    }
    if !is_git_oid(&args[8]) || !is_git_oid(&args[10]) {
        return Err("expected-tip and expected-tree must be 40-or-64 lowercase hex object ids".to_owned());
    }
    Ok(ParsedCloseRequestArgs {
        workstream,
        run_id: args[2].clone(),
        expected_revision,
        expected_event_tip: args[6].clone(),
        expected_tip: args[8].clone(),
        expected_tree: args[10].clone(),
        expected_final_digest: args[12].clone(),
    })
}

fn is_sha256_ref(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| hex.len() == 64 && hex.chars().all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()))
}

fn is_git_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.chars().all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
}

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../data/seam_real_producers.rs"
));

fn args_valid(spec: &str, args: &[String]) -> bool {
    match spec {
        "none" => args.is_empty(),
        "workstream" => args.len() == 1,
        "close-request-v1" => parse_close_request_args(args).is_ok(),
        "workstream task-paths..." => args.len() == 5,
        "request..." => !args.is_empty(),
        "show|parallel-cap" => {
            (args.len() == 1 && args[0] == "show")
                || (args.len() == 2 && args[0] == "parallel-cap" && args[1].parse::<u32>().is_ok())
        }
        _ => false,
    }
}
fn command_reject(actual: String) -> Result<ParsedCommand, Rejection> {
    loop {
        boundary_runtime(COMMAND_BOUNDARY_ID).reject(actual.clone())?;
    }
}
fn boundary_status(error: &Rejection) -> String {
    rejection(
        error.boundary_id(),
        &format!("expected={};actual={}", error.expected(), error.actual()),
    )
}

fn event_parts(rest: &str) -> Result<(EventKind, Ref), String> {
    let (kind, reference) = match rest.split_once(':') {
        Some(parts) => parts,
        None => return Err(rejection("malformed-command", "missing-event-ref")),
    };
    if kind.is_empty() {
        return Err(rejection("malformed-command", "empty-event-kind"));
    }
    if reference.is_empty() {
        return Err(rejection("malformed-command", "empty-event-ref"));
    }
    Ok((EventKind(kind.to_owned()), Ref(reference.to_owned())))
}
fn payload<T: DeserializeOwned>(frame: &SeamEnvelope) -> Result<(), Rejection> {
    if let Err(error) = serde_json::from_value::<T>(frame.payload.clone()) {
        boundary_runtime(BOUNDARY_ID).reject(format!("payload-mismatch:{}:{error}", frame.kind))?;
    }
    Ok(())
}
fn done(id: u64, status: String) -> Result<SeamEnvelope, AnyError> {
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "done".to_owned(),
        payload: serde_json::to_value(CoreToHostDonePayload { status })?,
    })
}
fn spawn(id: u64, action: BackgroundAction) -> Result<SeamEnvelope, AnyError> {
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "spawn".to_owned(),
        payload: serde_json::to_value(CoreToHostSpawnPayload { action })?,
    })
}
fn ui(id: u64, ui_kind: &str, content: serde_json::Value) -> Result<SeamEnvelope, AnyError> {
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "ui".to_owned(),
        payload: serde_json::to_value(CoreToHostUiPayload {
            ui_kind: UiKind(ui_kind.to_owned()),
            content,
        })?,
    })
}
fn guard_decision(id: u64, value: &str, reason: &str) -> Result<SeamEnvelope, AnyError> {
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "guard-decision".to_owned(),
        payload: serde_json::to_value(CoreToHostGuardDecisionPayload {
            decision: GuardDecision(value.to_owned()),
            reason: reason.to_owned(),
        })?,
    })
}
fn write_frame<W: Write>(writer: &mut W, frame: &SeamEnvelope) -> Result<(), AnyError> {
    serde_json::to_writer(&mut *writer, frame)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}
fn replay_path(path: &Path) -> Result<State, AnyError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(State::EMPTY),
        Err(error) => return Err(error.into()),
    };
    let mut state = State::EMPTY;
    for line in io::BufReader::new(file).lines() {
        state = apply(state, &serde_json::from_str::<EventRow>(&line?)?);
    }
    Ok(state)
}
fn append_event(path: &Path, event: &EventRow) -> Result<(), AnyError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, event)?;
    file.write_all(b"\n")?;
    file.sync_data()?;
    Ok(())
}
fn rejection(code: &str, detail: &str) -> String {
    format!("rejection:{code}:{detail}")
}
