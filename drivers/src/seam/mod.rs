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
        "guard-query" => route_guard_query(frame, state),
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
    if (raw.starts_with("append:") || raw.starts_with("crash-window:") || raw.starts_with("state:"))
        && let Some((verb, rest)) = raw.split_once(':')
    {
        return legacy_command(frame.id, verb, rest, state);
    }
    let parsed = match admit_operator_command(&raw) {
        Ok(value) => value,
        Err(error) => return done(frame.id, boundary_status(&error)),
    };
    let id = frame.id;
    let caps = bgtasks::BgCapabilities::from_generated(&background_capabilities);
    let diagnostic = background_capability_diagnostic.as_deref();
    let result = match parsed.route.driver.as_str() {
        "planning" => bgtasks::require_before_mutation(&caps, diagnostic, || {
            route_plan(id, &parsed.args, state)
        })
        .unwrap_or_else(|error| done(id, bgtasks::pause_status(&error))),
        "allocation-dispatch-runner" => bgtasks::require_before_mutation(&caps, diagnostic, || {
            route_run(id, &parsed.args[0], state)
        })
        .unwrap_or_else(|error| done(id, bgtasks::pause_status(&error))),
        "state" => done(id, state.summary()),
        "lifecycle-close" => route_close(id, &parsed.args, state),
        "lifecycle-abort" => route_abort(id, &parsed.args[0], state),
        "roster-config" => route_config(id, &parsed.args),
        "handoff" => route_handoff(id, state),
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
    let assignments = planning_assignments(workstream)
        .map_err(|error| context_status("planning", error))?;
    let first = assignments
        .first()
        .ok_or("planning assignment plan is empty")?;
    write_planning_manifest(workstream, &input_set, &inventory, &dossier, &assignments)?;
    let issue = planning_bg_action(workstream, first, state.state.revision, &input_set, None)?;
    append_runner_invocation(state, &issue.binding)?;
    controlled_spawn(id, issue.action, state, "planning")
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
    controlled_spawn(id, issue.action, state, "delivery")
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
    if planning_result_consumed(state, &binding) {
        return done(
            id,
            format!(
                "agent-result:already-accepted:{};{}",
                carrier.boundary_id,
                state.summary()
            ),
        );
    }
    if let Err(error) = validate_agent_output(&binding, &carrier.raw_output) {
        return done(id, boundary_status(&error));
    }
    if let Err(error) = apply_planning_side_effects(&carrier) {
        return done(id, rejection("planning-postprocess", &error));
    }
    if let Some(payload) = terminal {
        append_terminal_event(state, payload, &binding)?;
        record_task_completion_control(state, payload)?;
    }
    if carrier.boundary_id == "planning.plan-review.v1" {
        state.append(
            EventKind("planning:ready-to-execute".to_owned()),
            vec![
                Ref(carrier.workstream.clone()),
                Ref(plan_path(&carrier.workstream).display().to_string()),
                Ref(assignment_id.0.clone()),
                Ref(carrier.action_id.clone()),
                Ref(carrier.boundary_id.clone()),
                Ref(carrier.spec_digest.clone()),
                planning_result_consumed_ref(&binding),
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
    state.append(
        EventKind("agent:result".to_owned()),
        vec![
            Ref(assignment_id.0.clone()),
            Ref(carrier.action_id.clone()),
            Ref(carrier.boundary_id.clone()),
            Ref(carrier.workstream.clone()),
            Ref(carrier.spec_digest.clone()),
            planning_result_consumed_ref(&binding),
        ],
    )?;
    if let Err(error) = ensure_atom_registry_after_task_atoms(&carrier.workstream, state) {
        return done(id, rejection("planning-postprocess", &error.to_string()));
    }
    if let Some(next) = next_planning_assignment(&carrier.workstream, state)
        .map_err(|error| context_status("planning", error))? {
        let input_set = read_planning_input_set(&carrier.workstream)
            .map_err(|error| format!("CONTEXT_GAP:planning-manifest:{error}"))?;
        let atom_registry = if next.boundary_id.as_deref() == Some("planning.work-map.v1") {
            match ensure_atom_registry(&carrier.workstream, state) {
                Ok(registry) => Some(registry),
                Err(error) => return done(id, rejection("planning-postprocess", &error.to_string())),
            }
        } else {
            None
        };
        let issue =
            planning_bg_action(&carrier.workstream, &next, state.state.revision, &input_set, atom_registry)?;
        append_runner_invocation(state, &issue.binding)?;
        return controlled_spawn(id, issue.action, state, "planning");
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
    if binding.result_contract.0 == "autopilot.delivery_result.v1" {
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
        let package = match runner::establish_delivery_package(&result, &expected) {
            Ok(value) => value,
            Err(error) => {
                return done(
                    frame.id,
                    rejection("delivery-rejected", &format!("{error:?}")),
                );
            }
        };
        let accepted = match runner::accept_delivery_with_package_facts(
            std::slice::from_ref(&result),
            &expected,
            &package,
        ) {
            Ok(value) => value,
            Err(error) => {
                return done(
                    frame.id,
                    rejection("delivery-rejected", &format!("{error:?}")),
                );
            }
        };
        append_terminal_event(state, &payload, &binding)?;
        record_task_completion_control(state, &payload)?;
        state.append(
            EventKind("agent:delivery-accepted".to_owned()),
            vec![
                Ref(binding.assignment_id.0.clone()),
                Ref(binding.action_id.0.clone()),
                Ref(accepted.package_commit.0.clone()),
                Ref(accepted.package_tree.0.clone()),
                accepted.audit_ref.clone(),
            ],
        )?;
        record_delivery_transcript(&binding, &carrier_text, state)?;
        return delivery_accepted(frame.id, &binding, &accepted, state);
    }
    if binding.result_contract.0 == "validation.verdict.v1" {
        append_terminal_event(state, &payload, &binding)?;
        record_task_completion_control(state, &payload)?;
        return validation_completed(frame.id, &binding, state);
    }
    if binding.result_contract.0.starts_with("planning.") {
        let carrier_text = match fs::read_to_string(&binding.carrier_path) {
            Ok(value) => value,
            Err(error) => {
                return done(
                    frame.id,
                    rejection("carrier-read", &format!("{}:{error}", binding.carrier_path)),
                );
            }
        };
        let carrier: AgentCarrier = match serde_json::from_str(&carrier_text) {
            Ok(value) => value,
            Err(error) => {
                return done(
                    frame.id,
                    rejection(
                        "planning-carrier",
                        &format!("{}:{error}", binding.carrier_path),
                    ),
                );
            }
        };
        return accept_planning_carrier(
            frame.id,
            &binding.assignment_id,
            carrier,
            state,
            Some(&payload),
        );
    }
    append_terminal_event(state, &payload, &binding)?;
    record_task_completion_control(state, &payload)?;
    done(frame.id, state.summary())
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

fn planning_result_consumed(state: &CoreState, binding: &runner::IssuedRunnerBinding) -> bool {
    state
        .state
        .refs
        .contains_key(&planning_result_consumed_ref(binding))
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

fn planning_result_consumed_ref(binding: &runner::IssuedRunnerBinding) -> Ref {
    Ref(format!(
        "planning-result-consumed:{}:{}:{}",
        binding.action_id.0, binding.assignment_id.0, binding.run_revision
    ))
}

fn terminal_status_allowed(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "killed")
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

fn route_handoff(id: u64, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let active = active_assignment_handles(state);
    if active.is_empty() {
        return done(id, rejection("handoff", "no-active-assignments"));
    }
    let checkpoints = checkpoint_records_for_handoff(state, &active)?;
    let outcome = handoff::intentional_handoff(&active, &checkpoints);
    state.append(
        EventKind("handoff:checkpointed".to_owned()),
        vec![
            Ref("module-wired:checkpoint".to_owned()),
            Ref("module-wired:recovery".to_owned()),
            Ref(format!("actions:{}", outcome.actions.len())),
            Ref(format!(
                "retained:{}",
                outcome.retained_child_sessions.len()
            )),
        ],
    )?;
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
    let final_input = final_gate_input_from_request(&request, state);
    let pass = match crate::finalize::verify_final_gate(&final_input) {
        Ok(value) => value,
        Err(condition) => {
            return done(
                id,
                rejection(
                    "lifecycle-close",
                    &format!(
                        "FinalGateFailed:{};workstream={};run={};expected_revision={};expected_event_tip={};expected_tip={};expected_tree={};expected_final_digest={}",
                        condition.id(),
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
    };
    let cwd = std::env::current_dir()?;
    let report = LocalLifecycle::new(&cwd, &cwd, cwd.join(".pi/autopilot/archive"))
        .close(lifecycle::CloseRequest {
            workstream: request.workstream.clone(),
            run_id: request.run_id.clone(),
            final_tip: pass.tip.clone(),
            target_ref: run_main_ref(&request.workstream),
            evidence: close_evidence(&request, state),
            cleanup: close_cleanup(&request.workstream),
        })
        .map_err(|error| format!("lifecycle:{error:?}"))?;
    state.append(
        EventKind("lifecycle:closed".to_owned()),
        vec![
            Ref(request.workstream),
            Ref(request.run_id),
            Ref(report.result_ref.clone().unwrap_or_default()),
            Ref(report.archive_dir.display().to_string()),
            Ref("module-wired:finalize".to_owned()),
        ],
    )?;
    done(
        id,
        format!(
            "lifecycle:close:result_ref={};archive={};{}",
            report.result_ref.unwrap_or_default(),
            report.archive_dir.display(),
            state.summary()
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
            return Err(format!(
                "expected close flag {flag} at position {index}, got {}",
                args[index]
            ));
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
        return Err(
            "expected-event-tip and expected-final-digest must be sha256:<64 lowercase hex>"
                .to_owned(),
        );
    }
    if !is_git_oid(&args[8]) || !is_git_oid(&args[10]) {
        return Err(
            "expected-tip and expected-tree must be 40-or-64 lowercase hex object ids".to_owned(),
        );
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
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .chars()
                .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
    })
}

fn is_git_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
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
        "workstream task-paths..." => args.len() >= 2,
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

fn controlled_spawn(
    id: u64,
    action: BackgroundAction,
    state: &mut CoreState,
    trigger: &str,
) -> Result<SeamEnvelope, AnyError> {
    let mut guard = crate::control::BgRunGuard::new(vec![action.clone()]);
    guard
        .admit(&action.bg_run)
        .map_err(|error| format!("control:bg-run:{error:?}"))?;
    let policy = crate::control::ControlPolicy::package()
        .map_err(|error| format!("control:policy:{error:?}"))?;
    let frame = crate::control::ControlFrameDocument::build(crate::control::FrameInput {
        frame_id: kernel::generated::Uuidv7(format!(
            "control-frame-{}-{}",
            state.state.revision + 1,
            action.action_id.0
        )),
        run_id: kernel::generated::Uuidv7(format!("run-{}", action.run_revision)),
        run_revision: action.run_revision,
        trigger_kind: kernel::generated::TriggerKind(trigger.to_owned()),
        trigger_refs: vec![Ref(action.action_id.0.clone())],
        counts: kernel::generated::ControlFrameCounts {
            implementers: active_implementers(state) as u32,
            validators: active_validators(state) as u32,
            fixers: 0,
            deterministic_jobs: 0,
            queued_candidates: queued_candidates(state) as u32,
        },
        observations: Vec::new(),
        actions: vec![action.clone()],
        next_watchdog_at: kernel::generated::Nullable(None),
    });
    let mut refs = vec![
        Ref("module-wired:control".to_owned()),
        Ref(format!("control:trigger:{trigger}")),
        Ref(format!(
            "control:action-kinds:{}",
            policy.action_kinds.join(",")
        )),
        Ref(format!(
            "control:return_to_idle:{}",
            frame.as_generated().return_to_idle
        )),
        Ref(action.action_id.0.clone()),
        action_ref(&action)?,
    ];
    refs.extend(record_context_prompt_for_action(state, &action));
    refs.extend(observe_checkpoint_for_action(state, &action));
    if let Some(watchdog) = arm_watchdog_if_needed(state, action.run_revision)? {
        refs.push(Ref(format!("watchdog:armed:{}", watchdog.action_id.0)));
        refs.push(action_ref(&watchdog)?);
    }
    state.append(EventKind("control:frame".to_owned()), refs)?;
    spawn(id, action)
}

fn record_task_completion_control(
    state: &mut CoreState,
    payload: &HostToCoreTaskCompletedPayload,
) -> Result<(), AnyError> {
    let config = crate::watchdog::WatchdogConfig::package()
        .map_err(|error| format!("watchdog:policy:{error:?}"))?;
    let turn = config.completed_turn(
        active_work(state),
        Id(format!("watchdog-action-{}", state.state.revision + 1)),
        state.state.revision + 1,
    );
    state.append(
        EventKind("control:task-completed".to_owned()),
        vec![
            Ref("module-wired:watchdog".to_owned()),
            Ref(payload.task_id.0.clone()),
            Ref(payload.action_id.0.clone()),
            Ref(format!("watchdog-effects:{}", turn.effects.len())),
            Ref(format!(
                "watchdog-semantic-authority:{}",
                turn.has_semantic_authority()
            )),
        ],
    )
}

fn arm_watchdog_if_needed(
    state: &CoreState,
    run_revision: u64,
) -> Result<Option<BackgroundAction>, String> {
    let config =
        crate::watchdog::WatchdogConfig::package().map_err(|error| format!("{error:?}"))?;
    Ok(config.arm_action(
        active_work(state),
        watchdog_already_armed(state),
        Id(format!("watchdog-action-{}", run_revision)),
        run_revision,
    ))
}

fn delivery_accepted(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    accepted: &runner::AcceptedDelivery,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let issue = validation_issue_for_delivery(binding, accepted, state.state.revision)?;
    append_runner_invocation(state, &issue.binding)?;
    state.append(
        EventKind("validation:required".to_owned()),
        vec![
            Ref("module-wired:validation".to_owned()),
            Ref(format!("producer-assignment:{}", binding.assignment_id.0)),
            Ref(format!(
                "validator-assignment:{}",
                issue.binding.assignment_id.0
            )),
            Ref(accepted.package_commit.0.clone()),
            Ref(accepted.package_tree.0.clone()),
        ],
    )?;
    controlled_spawn(id, issue.action, state, "delivery-accepted")
}

fn validation_completed(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let text = fs::read_to_string(&binding.carrier_path)
        .map_err(|error| format!("validation-carrier-read:{}:{error}", binding.carrier_path))?;
    let verdict: kernel::generated::ValidationVerdict = serde_json::from_str(&text)
        .map_err(|error| format!("validation-carrier:{}:{error}", binding.carrier_path))?;
    crate::validation::submit_validation_verdict(verdict.clone())
        .map_err(|error| boundary_status(&error))?;
    if verdict.assignment_id != binding.assignment_id
        || verdict.exact_commit.0.trim().is_empty()
        || verdict.exact_tree.0.trim().is_empty()
    {
        return done(id, rejection("validation-binding", "identity-or-tip-drift"));
    }
    let required = validation_required_criteria(binding, &verdict);
    let findings: Vec<kernel::generated::Finding> = Vec::new();
    let decision = match crate::validation::decide_forward_round(
        crate::validation::ForwardRound::One,
        &required,
        &verdict,
        &findings,
    ) {
        Ok(value) => value,
        Err(error) => return done(id, rejection("validation-verdict", &format!("{error:?}"))),
    };
    match decision {
        crate::validation::ForwardDecision::Release => {
            integrate_validated_candidate(id, binding, &verdict, state)
        }
        crate::validation::ForwardDecision::ConsolidatedFixer { blocker_ids } => {
            repair_needed(id, binding, blocker_ids, state)
        }
        crate::validation::ForwardDecision::Tier23 { blocker_ids } => done(
            id,
            rejection(
                "validation-tier23",
                &format!("blockers={}", ids(&blocker_ids)),
            ),
        ),
    }
}

fn integrate_validated_candidate(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    verdict: &kernel::generated::ValidationVerdict,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let workstream = &binding.workstream.0;
    let cwd = fs::canonicalize(std::env::current_dir()?)?;
    ensure_run_main(
        &cwd,
        workstream,
        binding
            .base_commit
            .as_ref()
            .map(|sha| sha.0.as_str())
            .unwrap_or(&verdict.exact_commit.0),
    )?;
    let candidate = crate::integration::CandidateRequest {
        candidate_id: binding.assignment_id.0.clone(),
        enqueue_sequence: state.state.sequence + 1,
        kind: crate::integration::CandidateKind::ForwardRelease,
        candidate_tip: verdict.exact_commit.0.clone(),
    };
    let mut queue = crate::integration::IntegrationQueue::default();
    queue.enqueue(candidate.clone());
    let request = queue
        .start_next()
        .map_err(|error| format!("integration:queue:{error:?}"))?;
    let checks = focused_integration_checks(binding, verdict)?;
    let root = cwd
        .join(".pi/autopilot")
        .join(workstream)
        .join("integration")
        .join(&binding.assignment_id.0);
    if let Some(parent) = root.parent() {
        fs::create_dir_all(parent)?;
    }
    let integrator =
        crate::integration::ReleaseIntegrator::new(&cwd, &cwd, run_main_ref(workstream));
    let prepared = match integrator.merge_and_cas(request, &root, &checks) {
        Ok(value) => value,
        Err(error @ crate::integration::IntegrationError::Git) => {
            return conflict_response(id, binding, &candidate, error, state);
        }
        Err(error) => return done(id, rejection("integration", &format!("{error:?}"))),
    };
    queue.complete_active();
    let change = crate::staleness::MergeChange {
        changed_paths: prepared.changed_paths.clone(),
        changed_surfaces: prepared.changed_paths.clone(),
        affected_forward_edges: vec![format!(
            "edge:{}",
            binding
                .lane_id
                .as_ref()
                .map(|id| id.0.as_str())
                .unwrap_or("unknown")
        )],
        closed_forward_edges: Vec::new(),
    };
    let records = vec![crate::staleness::ValidationRecord {
        evidence_id: format!("validation:{}", binding.assignment_id.0),
        role_id: binding.role_id.0.clone(),
        assignment_id: binding.assignment_id.0.clone(),
        commit: verdict.exact_commit.0.clone(),
        tree: verdict.exact_tree.0.clone(),
        covered: validation_coverage_from_verdict(verdict),
        command_evidence: crate::staleness::CommandEvidence {
            command: "git rev-parse --verify HEAD".to_owned(),
            exit_code: 0,
            output_ref: format!("validation-output:{}", binding.assignment_id.0),
        },
        forward_edges: change.affected_forward_edges.clone(),
        closure_edges: Vec::new(),
    }];
    let stale = crate::staleness::compute_staleness(&records, &change);
    let closure_bundle = closure_bundle_for_integration(&prepared, &stale)?;
    let policy = crate::closure::RepairPolicy::package()
        .map_err(|error| format!("closure-policy:{error:?}"))?;
    let mut ledger = crate::closure::RepairLedger::new(policy);
    let repair_route = ledger.record_fix_attempt(&closure_bundle);
    state.append(
        EventKind("integration:forward-integrated".to_owned()),
        vec![
            Ref("module-wired:integration".to_owned()),
            Ref("module-wired:staleness".to_owned()),
            Ref("module-wired:closure".to_owned()),
            Ref("module-wired:repair".to_owned()),
            Ref(prepared.request.candidate_id),
            Ref(prepared.old_tip),
            Ref(prepared.new_tip.clone()),
            Ref(prepared.tree.clone()),
            Ref(format!("stale:{}", stale.stale.len())),
            Ref(format!("repair-route:{repair_route:?}")),
            Ref(format!(
                "unit-closed:{}",
                binding
                    .lane_id
                    .as_ref()
                    .map(|id| id.0.as_str())
                    .unwrap_or("unknown")
            )),
        ],
    )?;
    done(
        id,
        format!(
            "integration:forward-integrated:{};{}",
            prepared.new_tip,
            state.summary()
        ),
    )
}

fn conflict_response(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    candidate: &crate::integration::CandidateRequest,
    error: crate::integration::IntegrationError,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let current = side_facts(&candidate.candidate_tip, "current");
    let incoming = side_facts(&candidate.candidate_tip, "incoming");
    let bundle = crate::conflict::ConflictBundle {
        common_base: binding
            .base_commit
            .as_ref()
            .map(|sha| sha.0.clone())
            .unwrap_or_default(),
        current,
        incoming,
        hunks: vec![crate::conflict::ConflictHunk {
            id: crate::conflict::ConflictId(format!("conflict:{}", binding.assignment_id.0)),
            path: "unknown".to_owned(),
            class: crate::conflict::ConflictClass::Textual,
        }],
        operator_atoms: vec![binding.workstream.0.clone()],
        constraints_for_both: vec!["preserve current and incoming behavior".to_owned()],
    };
    let plan = crate::conflict::check_plan(&bundle);
    state.append(
        EventKind("integration:conflict-route".to_owned()),
        vec![
            Ref("module-wired:conflict".to_owned()),
            Ref(format!("candidate:{}", candidate.candidate_id)),
            Ref(format!("error:{error:?}")),
            Ref(format!("checks:{}", plan.checks.len())),
        ],
    )?;
    done(
        id,
        rejection(
            "integration-conflict",
            &format!("resolver-required:{}", candidate.candidate_id),
        ),
    )
}

fn repair_needed(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    blocker_ids: Vec<Id>,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let run_main = git_stdout(
        &std::env::current_dir()?,
        &[
            "rev-parse",
            "--verify",
            &run_main_ref(&binding.workstream.0),
        ],
    )
    .unwrap_or_else(|_| {
        binding
            .base_commit
            .as_ref()
            .map(|sha| sha.0.clone())
            .unwrap_or_default()
    });
    let plan = crate::repair::plan_repair_merge(crate::repair::RepairMergeRequest {
        run_main: crate::repair::CommitId(run_main.trim().to_owned()),
        repair_base: crate::repair::CommitId(run_main.trim().to_owned()),
        repair_commits: blocker_ids
            .iter()
            .map(|id| crate::repair::CommitId(format!("repair-required-for-{}", id.0)))
            .collect(),
        original_lane_commits: vec![crate::repair::CommitId(binding.assignment_id.0.clone())],
    });
    state.append(
        EventKind("validation:repair-required".to_owned()),
        vec![
            Ref("module-wired:repair".to_owned()),
            Ref(binding.assignment_id.0.clone()),
            Ref(format!("repair-plan:{plan:?}")),
        ],
    )?;
    done(
        id,
        rejection(
            "validation-blocked",
            &format!("blockers={}", ids(&blocker_ids)),
        ),
    )
}

fn validation_issue_for_delivery(
    binding: &runner::IssuedRunnerBinding,
    accepted: &runner::AcceptedDelivery,
    run_revision: u64,
) -> Result<runner::IssuedRunnerAction, String> {
    if binding.role_id.0 == "validator" || binding.assignment_id.0.contains("validator") {
        return Err("validator cannot validate its own assignment".to_owned());
    }
    let cwd = fs::canonicalize(std::env::current_dir().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let validation_id = format!("validation-{}", binding.assignment_id.0);
    let assignment_id = Id(format!("validator-{}", binding.assignment_id.0));
    let action_id = Id(format!("action-{}", assignment_id.0));
    let base = workstream_dir(&binding.workstream.0)
        .join("validation")
        .join(&assignment_id.0);
    let prompt_path = cwd.join(base.join("prompt.md"));
    let spec_path = cwd.join(base.join("spec.json"));
    let carrier_path = cwd.join(base.join("carrier.json"));
    write_parent_file_local(&prompt_path, validator_prompt(binding, accepted).as_bytes())
        .map_err(|error| error.to_string())?;
    let prompt_digest =
        sha256_hex_local(&fs::read(&prompt_path).map_err(|error| error.to_string())?);
    let spec = serde_json::json!({
        "schema":"autopilot.validation_assignment.v1",
        "validation_id":validation_id,
        "assignment_id":assignment_id.0,
        "producer_assignment_ids":[binding.assignment_id.0],
        "role_id":"validator",
        "mode":"forward-release",
        "exact_commit":accepted.package_commit.0,
        "exact_tree":accepted.package_tree.0,
        "prompt_path":prompt_path.display().to_string(),
        "prompt_digest":prompt_digest,
        "carrier_path":carrier_path.display().to_string()
    });
    write_parent_file_local(
        &spec_path,
        &serde_json::to_vec_pretty(&spec).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let spec_digest = sha256_hex_local(&fs::read(&spec_path).map_err(|error| error.to_string())?);
    let command = validator_command(&prompt_path, &carrier_path)?;
    let binding = runner::IssuedRunnerBinding {
        action_id: action_id.clone(),
        assignment_id: assignment_id.clone(),
        run_revision,
        workstream: binding.workstream.clone(),
        role_id: Id("validator".to_owned()),
        mode: ModeId("forward-release".to_owned()),
        boundary_id: kernel::generated::ContractId("validation.verdict.v1".to_owned()),
        result_contract: kernel::generated::ContractId("validation.verdict.v1".to_owned()),
        prompt_path: prompt_path.display().to_string(),
        prompt_digest,
        spec_path: spec_path.display().to_string(),
        spec_digest,
        carrier_path: carrier_path.display().to_string(),
        session_id: runner::session_id_for(
            &binding.workstream,
            &assignment_id,
            &Id("validator".to_owned()),
            &ModeId("forward-release".to_owned()),
            &kernel::generated::ContractId("validation.verdict.v1".to_owned()),
        ),
        boundary_digest: sha256_hex_local(crate::validation::BOUNDARY_ID.as_bytes()),
        result_contract_digest: sha256_hex_local(crate::validation::BOUNDARY_ID.as_bytes()),
        settings_digest: runner::settings_digest(),
        context_digest: sha256_hex_local(
            serde_json::to_string(&spec)
                .map_err(|error| error.to_string())?
                .as_bytes(),
        ),
        skills_digest: runner::skills_digest(),
        subscription_digest: sha256_hex_local(b"validator-subscription-pi"),
        lane_id: binding.lane_id.clone(),
        attempt: binding.attempt,
        base_commit: binding.base_commit.clone(),
        worktree: binding.worktree.clone(),
        required_focused_evidence: 1,
    };
    let action = BackgroundAction {
        action_id,
        assignment_id,
        kind: kernel::generated::ActionKind::LaunchBackground,
        bg_run: kernel::generated::BackgroundActionBgRun {
            name: format!("autopilot-validator-run {}", binding.assignment_id.0),
            command: kernel::generated::Bytes(command),
            is_agent: true,
            timeout_seconds: Some(3600),
            notify_on_completion: true,
            trigger_on_completion: true,
        },
        run_revision,
        expires_at: None,
        supersession_state: kernel::generated::SupersessionState("live".to_owned()),
    };
    Ok(runner::IssuedRunnerAction { action, binding })
}

fn validator_command(prompt_path: &Path, carrier_path: &Path) -> Result<String, String> {
    if let Ok(command) = std::env::var("AUTOPILOT_VALIDATOR_COMMAND") {
        if command.trim().is_empty() {
            return Err("AUTOPILOT_VALIDATOR_COMMAND is empty".to_owned());
        }
        return Ok(command
            .replace(
                "{prompt}",
                &shell_quote_local(&prompt_path.display().to_string()),
            )
            .replace(
                "{carrier}",
                &shell_quote_local(&carrier_path.display().to_string()),
            ));
    }
    let provider = std::env::var("PI_PROVIDER")
        .map_err(|_| "missing AUTOPILOT_VALIDATOR_COMMAND and PI_PROVIDER".to_owned())?;
    let model = std::env::var("PI_MODEL")
        .map_err(|_| "missing AUTOPILOT_VALIDATOR_COMMAND and PI_MODEL".to_owned())?;
    let thinking = std::env::var("PI_REASONING_LEVEL").unwrap_or_else(|_| "high".to_owned());
    Ok(format!(
        "pi --mode json --provider {} --model {} --thinking {} -p \"$(cat {})\" > {}",
        shell_quote_local(&provider),
        shell_quote_local(&model),
        shell_quote_local(&thinking),
        shell_quote_local(&prompt_path.display().to_string()),
        shell_quote_local(&carrier_path.display().to_string())
    ))
}

fn validator_prompt(
    binding: &runner::IssuedRunnerBinding,
    accepted: &runner::AcceptedDelivery,
) -> String {
    format!(
        "Independent Validator assignment. You are not the Implementer. Validate producer_assignment={} at exact commit={} tree={}. Return validation.verdict.v1 JSON with validation_scope=forward, FORWARD_READY only if every criterion has evidence and coverage. Changed paths: {}",
        binding.assignment_id.0,
        accepted.package_commit.0,
        accepted.package_tree.0,
        accepted.changed_paths.join(",")
    )
}

fn validation_required_criteria(
    binding: &runner::IssuedRunnerBinding,
    verdict: &kernel::generated::ValidationVerdict,
) -> Vec<crate::validation::RequiredCriterion> {
    if verdict.criterion_results.is_empty() {
        return vec![crate::validation::RequiredCriterion {
            id: Id(format!("criterion:{}", binding.assignment_id.0)),
            covered_paths: vec![kernel::generated::Path(".".to_owned())],
            semantic_surface_ids: vec![Id("surface:default".to_owned())],
            forward_edge_ids: vec![Id(format!(
                "edge:{}",
                binding
                    .lane_id
                    .as_ref()
                    .map(|id| id.0.as_str())
                    .unwrap_or("unknown")
            ))],
        }];
    }
    verdict
        .criterion_results
        .iter()
        .map(|result| crate::validation::RequiredCriterion {
            id: result.criterion_id.clone(),
            covered_paths: result.covered_paths.clone(),
            semantic_surface_ids: result.semantic_surface_ids.clone(),
            forward_edge_ids: result.forward_edge_ids.clone(),
        })
        .collect()
}

fn focused_integration_checks(
    _binding: &runner::IssuedRunnerBinding,
    verdict: &kernel::generated::ValidationVerdict,
) -> Result<Vec<crate::integration::CheckCommand>, AnyError> {
    let linked = verdict
        .criterion_results
        .iter()
        .flat_map(|result| result.evidence_refs.iter())
        .map(|reference| crate::validation::CommandSpec {
            command: "git rev-parse --verify HEAD".to_owned(),
            cwd: ".".to_owned(),
            env_profile: "package".to_owned(),
            commit: reference.0.clone(),
        })
        .collect::<Vec<_>>();
    let selected = crate::validation::select_forward_commands(
        &linked,
        &[crate::validation::CommandSpec {
            command: "git rev-parse --verify HEAD".to_owned(),
            cwd: ".".to_owned(),
            env_profile: "package".to_owned(),
            commit: verdict.exact_commit.0.clone(),
        }],
    )
    .map_err(|error| format!("validation-commands:{error:?}"))?;
    Ok(selected.into_iter().map(command_spec_to_check).collect())
}

fn command_spec_to_check(spec: crate::validation::CommandSpec) -> crate::integration::CheckCommand {
    let mut parts = spec.command.split_whitespace();
    let program = parts.next().unwrap_or("git").to_owned();
    crate::integration::CheckCommand {
        program,
        args: parts.map(str::to_owned).collect(),
    }
}

fn closure_bundle_for_integration(
    prepared: &crate::integration::PreparedCandidate,
    stale: &crate::staleness::StalenessReport,
) -> Result<crate::closure::DeepValidationBundle, String> {
    let criteria = vec![crate::closure::Criterion {
        id: format!("closure:{}", prepared.request.candidate_id),
        paths: prepared.changed_paths.clone(),
        surfaces: prepared.changed_paths.clone(),
        witness_ids: stale.current_evidence.clone(),
    }];
    let observations = criteria
        .iter()
        .map(|criterion| crate::closure::CriterionObservation {
            criterion_id: criterion.id.clone(),
            verdict: crate::closure::Verdict::Pass,
            findings: Vec::new(),
            evidence_id: format!("evidence:{}", prepared.new_tip),
        })
        .collect();
    crate::closure::DeepValidationBundle::build(prepared.new_tip.clone(), &criteria, observations)
        .map_err(|error| format!("closure:{error:?}"))
}

fn validation_coverage_from_verdict(
    verdict: &kernel::generated::ValidationVerdict,
) -> Vec<crate::staleness::CriterionCoverage> {
    verdict
        .criterion_results
        .iter()
        .map(|result| crate::staleness::CriterionCoverage {
            criterion_id: result.criterion_id.0.clone(),
            witness_id: result
                .evidence_refs
                .first()
                .map(|r| r.0.clone())
                .unwrap_or_else(|| "missing".to_owned()),
            paths: result.covered_paths.iter().map(|p| p.0.clone()).collect(),
            surfaces: result
                .semantic_surface_ids
                .iter()
                .map(|id| id.0.clone())
                .collect(),
        })
        .collect()
}

fn final_gate_input_from_request(
    request: &ParsedCloseRequestArgs,
    state: &CoreState,
) -> crate::finalize::FinalGateInput {
    let tip = request.expected_tip.clone();
    crate::finalize::FinalGateInput {
        final_tip: tip.clone(),
        every_unit_closed: has_ref_prefix(state, "unit-closed:"),
        no_mandatory_findings: !has_ref_prefix(state, "mandatory-finding:"),
        no_stale_required_proof: !has_ref_prefix(state, "stale-required-proof:"),
        no_active_or_unknown_jobs: !active_work(state),
        attributable_integrated_diff: has_ref_prefix(state, "integration-diff:")
            || has_ref_prefix(state, "unit-closed:"),
        final_commands: tip_evidence(state, "final-commands-pass:", &tip),
        full_suite: tip_evidence(state, "full-suite-pass:", &tip),
        final_validator: tip_evidence(state, "final-validator-pass:", &tip),
        bughunter: optional_tip_evidence(state, "bughunter-pass:", &tip),
        triggers: crate::finalize::BughunterTriggers {
            implementation_lanes: active_implementers(state) as u16,
            risk: crate::finalize::RiskLevel::Low,
            protected_security_data_or_migration: false,
            semantic_conflict_resolution: has_ref_prefix(state, "integration:conflict-route"),
            operator_required: false,
        },
    }
}

fn tip_evidence(state: &CoreState, prefix: &str, tip: &str) -> crate::finalize::TipEvidence {
    crate::finalize::TipEvidence {
        tip: tip.to_owned(),
        passed: state
            .state
            .refs
            .contains_key(&Ref(format!("{prefix}{tip}"))),
    }
}
fn optional_tip_evidence(
    state: &CoreState,
    prefix: &str,
    tip: &str,
) -> Option<crate::finalize::TipEvidence> {
    state
        .state
        .refs
        .contains_key(&Ref(format!("{prefix}{tip}")))
        .then(|| tip_evidence(state, prefix, tip))
}
fn close_evidence(
    request: &ParsedCloseRequestArgs,
    state: &CoreState,
) -> Vec<lifecycle::ProtectedEvidence> {
    vec![lifecycle::ProtectedEvidence {
        name: "final-gate.txt".to_owned(),
        bytes: format!(
            "workstream={} run={} revision={} refs={} final_digest={}",
            request.workstream,
            request.run_id,
            state.state.revision,
            state.state.refs.len(),
            request.expected_final_digest
        ),
    }]
}
fn close_cleanup(workstream: &str) -> Vec<lifecycle::CleanupProof> {
    vec![lifecycle::CleanupProof {
        artifact: lifecycle::CleanupArtifact::PackageWorktree(
            workstream_dir(workstream).join("integration"),
        ),
        proven_safe: true,
    }]
}
fn active_validators(state: &CoreState) -> usize {
    state
        .state
        .refs
        .keys()
        .filter_map(|reference| runner::decode_binding_ref(&reference.0))
        .filter(|binding| binding.role_id.0 == "validator" && !terminal_consumed(state, binding))
        .count()
}
fn active_work(state: &CoreState) -> bool {
    active_implementers(state) > 0 || active_validators(state) > 0
}
fn queued_candidates(state: &CoreState) -> usize {
    state
        .state
        .refs
        .keys()
        .filter(|reference| reference.0.starts_with("candidate-queued:"))
        .count()
}
fn watchdog_already_armed(state: &CoreState) -> bool {
    has_ref_prefix(state, "watchdog:armed:")
}
fn has_ref_prefix(state: &CoreState, prefix: &str) -> bool {
    state
        .state
        .refs
        .keys()
        .any(|reference| reference.0.starts_with(prefix))
}

fn ensure_run_main(repo: &Path, workstream: &str, base: &str) -> Result<(), String> {
    let run_main = run_main_ref(workstream);
    if git_stdout(repo, &["rev-parse", "--verify", &run_main]).is_ok() {
        return Ok(());
    }
    git_status(repo, &["update-ref", &run_main, base]).map_err(|error| format!("run-main:{error}"))
}
fn run_main_ref(workstream: &str) -> String {
    format!(
        "refs/heads/autopilot/run/{}/main",
        safe_ref_component(workstream)
    )
}
fn lane_branch_ref(workstream: &str, lane_id: &Id, attempt: u32) -> String {
    format!(
        "refs/heads/autopilot/run/{}/lane/{}/a{}",
        safe_ref_component(workstream),
        safe_ref_component(&lane_id.0),
        attempt
    )
}
fn safe_ref_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned()
}
fn side_facts(commit: &str, label: &str) -> crate::conflict::SideFacts {
    crate::conflict::SideFacts {
        commit: commit.to_owned(),
        tree: String::new(),
        diff: label.to_owned(),
        criteria: vec![format!("criteria:{label}")],
        open_findings: Vec::new(),
        changed_paths: vec!["unknown".to_owned()],
        focused_tests: vec!["git rev-parse --verify HEAD".to_owned()],
        downstream_contracts: Vec::new(),
    }
}
fn ids(values: &[Id]) -> String {
    values
        .iter()
        .map(|id| id.0.clone())
        .collect::<Vec<_>>()
        .join(",")
}
fn write_parent_file_local(path: &Path, data: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, data)
}
fn sha256_hex_local(data: &[u8]) -> String {
    use sha2::{Digest as _, Sha256};
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
fn shell_quote_local(value: &str) -> String {
    if value.is_empty() {
        "''".to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}
fn git_status(repo: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn route_guard_query(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let payload: HostToCoreGuardQueryPayload = serde_json::from_value(frame.payload)?;
    if payload.tool_name != "bg_run" {
        return guard_decision(
            frame.id,
            "deny",
            &format!("unsupported-tool:{}", payload.tool_name),
        );
    }
    let call = match bg_run_from_guard_args(&payload.arguments) {
        Ok(value) => value,
        Err(error) => {
            return guard_decision(frame.id, "deny", &format!("control:bg-run-shape:{error}"));
        }
    };
    let actions = issued_actions(state);
    let mut mismatch = None;
    for candidate in actions {
        let mut guard = crate::control::BgRunGuard::new(vec![candidate]);
        match guard.admit(&call) {
            Ok(crate::control::GuardOutcome::Accepted { action, .. })
            | Ok(crate::control::GuardOutcome::Duplicate { action }) => {
                state.append(
                    EventKind("control:bg-run-admitted".to_owned()),
                    vec![
                        Ref("module-wired:control".to_owned()),
                        Ref(action.action_id.0.clone()),
                        Ref(action.assignment_id.0.clone()),
                    ],
                )?;
                return guard_decision(
                    frame.id,
                    "allow",
                    "control.bg-run-exact.v1:matched-live-action",
                );
            }
            Err(crate::control::GuardRejection::Mismatch { valid }) => {
                mismatch = Some(valid.action_id.0.clone());
            }
            Err(crate::control::GuardRejection::Unsafe { failure }) => {
                return guard_decision(
                    frame.id,
                    "deny",
                    &format!("control.bg-run-exact.v1:unsafe:{failure:?}"),
                );
            }
        }
    }
    guard_decision(
        frame.id,
        "deny",
        &format!(
            "control.bg-run-exact.v1:mismatch:valid_action={}",
            mismatch.unwrap_or_else(|| "<none>".to_owned())
        ),
    )
}

fn bg_run_from_guard_args(
    value: &serde_json::Value,
) -> Result<kernel::generated::BackgroundActionBgRun, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "arguments-not-object".to_owned())?;
    let name = string_field(obj, "name").or_else(|_| string_field(obj, "display_name"))?;
    let command = string_field(obj, "command").or_else(|_| string_field(obj, "command_bytes"))?;
    let is_agent = bool_field(obj, "isAgent").or_else(|_| bool_field(obj, "is_agent"))?;
    let timeout_seconds = match obj
        .get("timeoutSeconds")
        .or_else(|| obj.get("timeout_seconds"))
    {
        Some(serde_json::Value::Number(number)) => Some(
            number
                .as_u64()
                .ok_or_else(|| "timeoutSeconds-not-u64".to_owned())
                .and_then(|n| u32::try_from(n).map_err(|_| "timeoutSeconds-overflow".to_owned()))?,
        ),
        Some(serde_json::Value::Null) => return Err("timeoutSeconds-null".to_owned()),
        Some(_) => return Err("timeoutSeconds-not-number".to_owned()),
        None => None,
    };
    let notify_on_completion = bool_field(obj, "notifyOnCompletion")
        .or_else(|_| bool_field(obj, "notify_on_completion"))?;
    let trigger_on_completion = bool_field(obj, "triggerOnCompletion")
        .or_else(|_| bool_field(obj, "trigger_on_completion"))?;
    Ok(kernel::generated::BackgroundActionBgRun {
        name,
        command: kernel::generated::Bytes(command),
        is_agent,
        timeout_seconds,
        notify_on_completion,
        trigger_on_completion,
    })
}

fn string_field(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<String, String> {
    obj.get(key)
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .ok_or_else(|| format!("missing-string:{key}"))
}

fn bool_field(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Result<bool, String> {
    obj.get(key)
        .and_then(|value| value.as_bool())
        .ok_or_else(|| format!("missing-bool:{key}"))
}

fn action_ref(action: &BackgroundAction) -> Result<Ref, AnyError> {
    Ok(Ref(format!(
        "control-action:{}",
        serde_json::to_string(action)?
    )))
}

fn decode_action_ref(value: &str) -> Option<BackgroundAction> {
    serde_json::from_str(value.strip_prefix("control-action:")?).ok()
}

fn issued_actions(state: &CoreState) -> Vec<BackgroundAction> {
    state
        .state
        .refs
        .keys()
        .filter_map(|reference| decode_action_ref(&reference.0))
        .collect()
}

fn binding_for_action(
    state: &CoreState,
    action: &BackgroundAction,
) -> Option<runner::IssuedRunnerBinding> {
    binding_for(state, &action.action_id.0, &action.assignment_id.0).ok()
}

fn record_context_prompt_for_action(state: &CoreState, action: &BackgroundAction) -> Vec<Ref> {
    let Some(binding) = binding_for_action(state, action) else {
        return vec![Ref(
            "module-unreachable:context-prompt:no-runner-binding".to_owned()
        )];
    };
    let assignment_text = fs::read_to_string(&binding.spec_path)
        .unwrap_or_else(|error| format!("spec-read-error:{}:{error}", binding.spec_path));
    let estimate = crate::context::estimate_tokens(assignment_text.as_bytes(), 512);
    let budget = crate::context::route_budget(estimate, 200_000, estimate / 2);
    let manifest = crate::context::manifest_shell(
        kernel::generated::Uuidv7(format!("manifest-{}", binding.assignment_id.0)),
        kernel::generated::Uuidv7(format!("run-{}", binding.run_revision)),
        binding.assignment_id.clone(),
        binding.role_id.clone(),
        budget,
    );
    let manifest_text = match serde_json::to_string_pretty(&manifest) {
        Ok(value) => value,
        Err(error) => return vec![Ref(format!("module-unreachable:context:serialize:{error}"))],
    };
    let prompt_input = crate::prompt::PromptInput {
        role_id: binding.role_id.0.clone(),
        mode_id: binding.mode.0.clone(),
        assignment_revision: binding.run_revision.to_string(),
        plan_revision: binding.spec_digest.clone(),
        runtime_revision: state.state.revision,
        context_manifest_id: manifest.manifest_id.0.clone(),
        git_identity: binding
            .base_commit
            .as_ref()
            .map(|sha| sha.0.clone())
            .unwrap_or_else(|| "planning-no-base-commit".to_owned()),
        assignment: assignment_text,
        context_manifest: manifest_text.clone(),
        contract: binding.result_contract.0.clone(),
        runtime_overlay: None,
    };
    match crate::prompt::render(&prompt_input) {
        Ok(rendered) => {
            let sidecar = PathBuf::from(&binding.prompt_path).with_extension("package-rendered.md");
            match write_parent_file_local(&sidecar, rendered.text.as_bytes()) {
                Ok(()) => vec![
                    Ref("module-wired:context".to_owned()),
                    Ref("module-wired:prompt".to_owned()),
                    Ref(format!(
                        "context-route:{:?}:{}",
                        budget.route, budget.estimated_percent
                    )),
                    Ref(format!("prompt-rendered:{}", rendered.digest)),
                    Ref(sidecar.display().to_string()),
                ],
                Err(error) => vec![Ref(format!("module-unreachable:prompt-write:{error}"))],
            }
        }
        Err(error) => vec![
            Ref("module-wired:context".to_owned()),
            Ref(format!("module-unreachable:prompt-render:{error:?}")),
        ],
    }
}

fn observe_checkpoint_for_action(state: &CoreState, action: &BackgroundAction) -> Vec<Ref> {
    let Some(binding) = binding_for_action(state, action) else {
        return Vec::new();
    };
    let Some(lane_id) = binding.lane_id.clone() else {
        return Vec::new();
    };
    let assignment_state = crate::checkpoint::AssignmentState {
        assignment_id: binding.assignment_id.clone(),
        lane_id,
        run_revision: binding.run_revision,
        base_commit: binding
            .base_commit
            .clone()
            .unwrap_or_else(|| Sha("unknown".to_owned())),
        current_commit: binding
            .base_commit
            .clone()
            .unwrap_or_else(|| Sha("unknown".to_owned())),
        dirty_paths: Vec::new(),
        completed: Vec::new(),
        remaining: vec![binding.assignment_id.clone()],
        next_action: "continue".to_owned(),
        session_ref: Ref(format!("session:{}", binding.action_id.0)),
    };
    let decision = crate::checkpoint::observe_context(50, &assignment_state);
    let restart = crate::recovery::reconcile_restart(&crate::recovery::RestartInput {
        assignment_id: binding.assignment_id.clone(),
        event_refs: state.state.refs.keys().cloned().collect(),
        git_refs: binding
            .base_commit
            .clone()
            .map(|sha| vec![Ref(sha.0)])
            .unwrap_or_default(),
        create_once_refs: Vec::new(),
        checkpoint_refs: Vec::new(),
        result: None,
        lock: crate::recovery::LockState::Free,
    });
    vec![
        Ref("module-wired:checkpoint".to_owned()),
        Ref("module-wired:recovery".to_owned()),
        Ref(format!("checkpoint-observe:{decision:?}")),
        Ref(format!("recovery-restart:{restart:?}")),
    ]
}

fn record_delivery_transcript(
    binding: &runner::IssuedRunnerBinding,
    raw_output: &str,
    state: &mut CoreState,
) -> Result<(), AnyError> {
    let runtime = runner::role_runtime(&binding.role_id.0)
        .map_err(|error| format!("transcript-runtime:{error}"))?;
    let record = crate::transcript::TranscriptRecord::real(
        binding.result_contract.0.clone(),
        raw_output.to_owned(),
        crate::transcript::TranscriptProvenance {
            provider: runtime.provider,
            model: runtime.model,
            thinking: runtime.thinking,
            session_id: safe_ref_component(&binding.action_id.0),
        },
    );
    let root = workstream_dir(&binding.workstream.0).join("transcripts");
    crate::transcript::TranscriptStore::new(root)
        .record(&record)
        .map_err(|error| format!("transcript:{error:?}"))?;
    state.append(
        EventKind("transcript:recorded".to_owned()),
        vec![
            Ref("module-wired:transcript".to_owned()),
            Ref(binding.assignment_id.0.clone()),
            Ref(binding.result_contract.0.clone()),
        ],
    )
}

fn active_assignment_handles(state: &CoreState) -> Vec<AssignmentHandle> {
    state
        .state
        .refs
        .keys()
        .filter_map(|reference| task_binding_ref(&reference.0))
        .filter_map(|task| {
            binding_for(state, &task.action_id.0, &task.assignment_id.0)
                .ok()
                .map(|binding| (task, binding))
        })
        .filter(|(_task, binding)| !terminal_consumed(state, binding))
        .map(|(task, binding)| AssignmentHandle {
            assignment_id: binding.assignment_id.clone(),
            task_id: task.task_id,
            child_session_ref: Ref(format!("session:{}", binding.action_id.0)),
            worktree_ref: Ref(binding
                .worktree
                .clone()
                .unwrap_or_else(|| binding.workstream.0.clone())),
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct TaskBindingRef {
    task_id: Id,
    action_id: Id,
    assignment_id: Id,
}

fn task_binding_ref(value: &str) -> Option<TaskBindingRef> {
    serde_json::from_str(value.strip_prefix("task-binding:")?).ok()
}

fn checkpoint_records_for_handoff(
    state: &mut CoreState,
    active: &[AssignmentHandle],
) -> Result<Vec<CooperativeCheckpoint>, AnyError> {
    let mut checkpoints = Vec::new();
    for handle in active {
        let checkpoint_ref = Ref(format!(
            "checkpoint:{}:{}",
            handle.assignment_id.0,
            state.state.revision + 1
        ));
        let restart = crate::recovery::reconcile_restart(&crate::recovery::RestartInput {
            assignment_id: handle.assignment_id.clone(),
            event_refs: state.state.refs.keys().cloned().collect(),
            git_refs: Vec::new(),
            create_once_refs: Vec::new(),
            checkpoint_refs: Vec::new(),
            result: None,
            lock: crate::recovery::LockState::Free,
        });
        state.append(
            EventKind("checkpoint:handoff".to_owned()),
            vec![
                Ref("module-wired:checkpoint".to_owned()),
                Ref("module-wired:recovery".to_owned()),
                checkpoint_ref.clone(),
                Ref(format!("restart:{restart:?}")),
            ],
        )?;
        checkpoints.push(CooperativeCheckpoint {
            assignment_id: handle.assignment_id.clone(),
            checkpoint_ref,
        });
    }
    Ok(checkpoints)
}
