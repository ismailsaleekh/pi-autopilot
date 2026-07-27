use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use kernel::boundary::Rejection;
use kernel::generated::{
    AllocationLaneProposal, BackgroundAction, CONTRACT_VERSION, CoreToHostDonePayload,
    CoreToHostGuardDecisionPayload, CoreToHostSpawnPayload, CoreToHostUiPayload,
    DeliveryBoundary, EventKind, EventRow, GuardDecision, HostToCoreAgentResultPayload,
    HostToCoreCommandPayload, HostToCoreGuardQueryPayload, HostToCoreOperatorAnswerPayload,
    HostToCoreShutdownPayload, HostToCoreTaskCompletedPayload, Id, ModeId, Ref, SeamEnvelope,
    Sha, TestId, UiKind,
};
use kernel::schedule::ResourceFacts;
use kernel::state::{State, apply};
use kernel_macros::acceptance_boundary;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::allocation::{self, AllocationPolicy, AllocationSubmission, ApprovedUnit, FutureUnit};
use crate::dispatch::{self, DispatchInput, LaneReadiness};
use crate::handoff::{self, AssignmentHandle, CooperativeCheckpoint};
use crate::lifecycle::{self, AbortRequest, CleanupProof, CloseRequest, LocalLifecycle};
use crate::planning::{self, TaskAuthority, TaskDocument};
use crate::roles::kdl::boundary_runtime;
use crate::roster;
use crate::runner::{self, RunnerAssignment};
use crate::vcs::GitVcs;

pub mod sim_host;

const BOUNDARY_ID: &str = "seam.host-frame.v1";
const COMMAND_BOUNDARY_ID: &str = "seam.operator-command.v1";
const COMMANDS_KDL: &str = include_str!("../../../data/commands.kdl");
type AnyError = Box<dyn std::error::Error>;

#[derive(Debug)]
pub struct CoreState { event_path: Option<PathBuf>, state: State }
#[derive(Clone, Debug)]
pub struct Route { name: String, driver: String, args: String, expects: String }
#[derive(Clone, Debug)]
pub struct ParsedCommand { route: Route, args: Vec<String> }

impl CoreState {
    pub fn open(event_path: Option<PathBuf>) -> Result<Self, AnyError> {
        Ok(Self { state: match event_path.as_deref() { Some(path) => replay_path(path)?, None => State::EMPTY }, event_path })
    }
    fn append(&mut self, kind: EventKind, artifact_refs: Vec<Ref>) -> Result<(), AnyError> {
        let event = EventRow { sequence: self.state.sequence.checked_add(1).ok_or("event sequence overflow")?, previous_revision: self.state.revision, new_revision: self.state.revision.checked_add(1).ok_or("event revision overflow")?, kind, artifact_refs };
        if let Some(path) = &self.event_path { append_event(path, &event)?; }
        self.state = apply(self.state.clone(), &event);
        Ok(())
    }
    fn summary(&self) -> String { format!("state:sequence={};revision={};hash={}", self.state.sequence, self.state.revision, self.state.state_hash().0) }
}

pub fn run<R: BufRead, W: Write>(reader: R, writer: &mut W, state: &mut CoreState) -> Result<(), AnyError> {
    for line in reader.lines() { write_frame(writer, &handle_line(&line?, state)?)?; }
    Ok(())
}

pub fn handle_line(line: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let envelope = match serde_json::from_str::<SeamEnvelope>(line) { Ok(frame) => frame, Err(error) => return done(0, rejection("malformed-json", &error.to_string())) };
    let id = envelope.id;
    match admit_host_frame(envelope) { Ok(frame) => dispatch(frame, state), Err(error) => done(id, rejection(error.boundary_id(), error.actual())) }
}

#[acceptance_boundary(
    id = "seam.host-frame.v1",
    producer = Producer::Host,
    visible = true,
    admits = "Host newline JSON must be contract v=1 with a known host-to-core kind and generated payload shape.",
    mode = BoundaryMode::Enforce
)]
pub fn admit_host_frame(frame: SeamEnvelope) -> Result<SeamEnvelope, Rejection> {
    if frame.v != CONTRACT_VERSION as u32 { boundary_runtime(BOUNDARY_ID).reject(format!("version-mismatch:{}", frame.v))?; }
    match frame.kind.as_str() {
        "agent-result" => payload::<HostToCoreAgentResultPayload>(&frame)?, "command" => payload::<HostToCoreCommandPayload>(&frame)?, "guard-query" => payload::<HostToCoreGuardQueryPayload>(&frame)?,
        "operator-answer" => payload::<HostToCoreOperatorAnswerPayload>(&frame)?, "shutdown" => payload::<HostToCoreShutdownPayload>(&frame)?, "task-completed" => payload::<HostToCoreTaskCompletedPayload>(&frame)?,
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
    let routes = match routes() { Ok(value) => value, Err(error) => return command_reject(format!("commands.kdl:{error}")) };
    let trimmed = raw.trim().trim_start_matches('/');
    let mut words = trimmed.split_whitespace();
    let Some(name) = words.next() else { return command_reject(format!("expected={};actual=<empty>", valid(&routes))) };
    let Some(route) = routes.iter().find(|item| item.name == name).cloned() else { return command_reject(format!("unknown-command:{name};valid={}", valid(&routes))) };
    let args = words.map(str::to_owned).collect::<Vec<_>>();
    if !args_valid(&route.args, &args) { return command_reject(format!("expected={};actual={raw}", route.expects)); }
    Ok(ParsedCommand { route, args })
}

fn dispatch(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    match frame.kind.as_str() {
        "command" => command(frame, state), "agent-result" => route_agent_result(frame, state), "guard-query" => guard_decision(frame.id, "deny", "core guard policy is not configured"), "shutdown" => done(frame.id, "ok:shutdown".to_owned()),
        "task-completed" | "operator-answer" => done(frame.id, "ok:recorded".to_owned()), other => done(frame.id, rejection("unknown-kind", other)),
    }
}

fn command(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let HostToCoreCommandPayload { raw } = serde_json::from_value(frame.payload)?;
    if raw == "state" { return done(frame.id, state.summary()); }
    if matches!(raw.as_str(), "append" | "crash-window") { return done(frame.id, rejection("malformed-command", &raw)); }
    if let Some((verb, rest)) = raw.split_once(':') { return legacy_command(frame.id, verb, rest, state); }
    let parsed = match admit_operator_command(&raw) { Ok(value) => value, Err(error) => return done(frame.id, boundary_status(&error)) };
    product_command(frame.id, parsed, state)
}

fn legacy_command(id: u64, verb: &str, rest: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let pause = match verb { "append" => false, "crash-window" => true, "state" => return done(id, rejection("malformed-command", verb)), other => return done(id, rejection("unknown-command", other)) };
    let (kind, reference) = match event_parts(rest) { Ok(parts) => parts, Err(status) => return done(id, status) };
    state.append(kind, vec![reference])?;
    if pause { eprintln!("autopilot-core: crash-window-ready {}", state.summary()); thread::sleep(Duration::from_secs(30)); }
    done(id, state.summary())
}

fn product_command(id: u64, parsed: ParsedCommand, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let result = match parsed.route.driver.as_str() {
        "planning" => route_plan(id, &parsed.args, state), "allocation-dispatch-runner" => route_run(id, &parsed.args[0], state), "state" => done(id, state.summary()),
        "lifecycle-close" => route_close(id, &parsed.args[0], state), "lifecycle-abort" => route_abort(id, &parsed.args[0], state), "roster-config" => route_config(id, &parsed.args),
        "handoff" => route_handoff(id), "workstream-attach" => { let key = crate::state_root::repo_key(".").map_err(|error| format!("state-root:{error:?}"))?; state.append(EventKind("workstream-attach".to_owned()), vec![Ref(parsed.args[0].clone()), Ref(key.0)])?; done(id, format!("attach:workstream={};{}", parsed.args[0], state.summary())) }
        "planning-onboard" => route_onboard(id, &parsed.args), other => done(id, rejection("unknown-driver", other)),
    };
    match result { Ok(frame) => Ok(frame), Err(error) => done(id, rejection("driver-error", &error.to_string())) }
}

fn route_plan(id: u64, args: &[String], state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let workstream = &args[0];
    let source = TaskFiles(args[1..].iter().map(PathBuf::from).collect());
    let inventory = planning::p1_inventory(&source).map_err(|error| context_status("planning", error))?;
    let cwd = std::env::current_dir()?;
    let dossier = planning::p2_ground(&RepoGrounding { repo: cwd }, &inventory).map_err(|error| context_status("planning", error))?;
    let plan = planning::AssignmentPlan::d72_default();
    plan.validate(25).map_err(|error| context_status("planning", error))?;
    let assignments = planning_assignments(workstream, &plan);
    let first = assignments.first().ok_or("planning assignment plan is empty")?;
    write_planning_manifest(workstream, &inventory, &dossier, &assignments)?;
    append_agent_invocation(state, workstream, first)?;
    spawn(id, planning_bg_action(first, state.state.revision))
}

fn route_run(id: u64, workstream: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let approved = read_approved_plan(workstream).map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
    let submission = allocation_submission_from_plan(workstream, &approved).map_err(|error| format!("CONTEXT_GAP:allocation:{error}"))?;
    let allocation = allocation::validate_allocation(&approved, &submission, AllocationPolicy { parallel_cap: 8, active_implementers: active_implementers(state) }).map_err(|error| format!("allocation:{error:?}"))?;
    let readiness = lane_readiness_from_events(&submission.lanes, &approved, state);
    let resources = host_resource_facts().map_err(|error| format!("CONTEXT_GAP:resources:{error}"))?;
    let selected = dispatch::select_ready_lanes(&DispatchInput { lanes: allocation.lanes, readiness, active_implementers: active_implementers(state), parallel_cap: 8, resources });
    let Some(lane_id) = selected.first() else { return done(id, rejection("dispatch", "no-ready-lane")) };
    let assignment = assignment(workstream, lane_id)?;
    append_agent_invocation(state, workstream, &AgentAssignment { assignment_id: assignment.assignment_id.0.clone(), role: "implementer".to_owned(), mode: assignment.mode.0.clone(), boundary_id: None })?;
    spawn(id, runner::bg_action(&assignment))
}

fn route_agent_result(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let HostToCoreAgentResultPayload { assignment_id, carrier } = serde_json::from_value(frame.payload)?;
    let carrier: AgentCarrier = serde_json::from_value(carrier).map_err(|error| format!("agent-result-carrier:{error}"))?;
    validate_agent_output(&carrier.boundary_id, &carrier.raw_output).map_err(|error| boundary_status(&error))?;
    state.append(EventKind("agent:result".to_owned()), vec![Ref(assignment_id.0.clone()), Ref(carrier.boundary_id.clone()), Ref(carrier.workstream.clone())])?;
    if carrier.boundary_id == "planning.work-map.v1" {
        write_work_map(&carrier.workstream, &carrier.raw_output)?;
    }
    if carrier.boundary_id == "planning.plan-review.v1" {
        let work_map = read_work_map(&carrier.workstream).map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
        let units = parse_approved_units(&work_map).map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
        write_approved_plan(&carrier.workstream, &units)?;
        state.append(EventKind("planning:ready-to-execute".to_owned()), vec![Ref(carrier.workstream.clone()), Ref(plan_path(&carrier.workstream).display().to_string())])?;
        return done(frame.id, format!("ready-to-execute:workstream={};{}", carrier.workstream, state.summary()));
    }
    if let Some(next) = next_planning_assignment(&carrier.workstream, state) {
        append_agent_invocation(state, &carrier.workstream, &next)?;
        return spawn(frame.id, planning_bg_action(&next, state.state.revision));
    }
    done(frame.id, format!("agent-result:accepted:{};{}", carrier.boundary_id, state.summary()))
}

fn route_config(id: u64, args: &[String]) -> Result<SeamEnvelope, AnyError> {
    let roster = roster::Roster::package().map_err(|error| format!("roster:{error:?}"))?;
    let Some(slot) = roster.slots().next() else { return done(id, rejection("roster", "empty")) };
    roster::guard_route(&slot.route()).map_err(|error| format!("roster:{error:?}"))?;
    ui(id, "text", serde_json::json!({"driver":"roster-config","slots":roster.slots().count(),"request":args}))
}

fn route_handoff(id: u64) -> Result<SeamEnvelope, AnyError> {
    let active = vec![AssignmentHandle { assignment_id: idv("handoff-a1"), task_id: idv("task-1"), child_session_ref: Ref("session:1".to_owned()), worktree_ref: Ref("worktree:1".to_owned()) }];
    let outcome = handoff::intentional_handoff(&active, &[CooperativeCheckpoint { assignment_id: idv("handoff-a1"), checkpoint_ref: Ref("checkpoint:1".to_owned()) }]);
    ui(id, "text", serde_json::json!({"driver":"handoff","actions":outcome.actions.len(),"retained":outcome.retained_child_sessions.len()}))
}

fn route_onboard(id: u64, args: &[String]) -> Result<SeamEnvelope, AnyError> {
    let source = InlineTask(args.join(" "));
    let inventory = planning::p1_inventory(&source).map_err(|error| format!("planning:{error:?}"))?;
    ui(id, "text", serde_json::json!({"driver":"planning-onboard","atoms":inventory.atoms.len()}))
}

fn route_abort(id: u64, workstream: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let cwd = std::env::current_dir()?;
    let report = LocalLifecycle::new(&cwd, &cwd, cwd.join(".pi/autopilot/archive")).abort(AbortRequest { workstream: workstream.to_owned(), run_id: format!("run-{}", state.state.revision + 1), reason: "operator abort command".to_owned(), evidence: Vec::<lifecycle::ProtectedEvidence>::new() }).map_err(|error| format!("lifecycle:{error:?}"))?;
    done(id, format!("lifecycle:abort:archive={}", report.archive_dir.display()))
}

fn route_close(id: u64, workstream: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let cwd = std::env::current_dir()?; let vcs = GitVcs::new(&cwd); let tip = vcs.read_tip(&cwd, "HEAD").map_err(|error| format!("vcs:{error:?}"))?;
    let report = LocalLifecycle::new(&cwd, &cwd, cwd.join(".pi/autopilot/archive")).close(CloseRequest { workstream: workstream.to_owned(), run_id: format!("run-{}", state.state.revision + 1), final_tip: tip, target_ref: "HEAD".to_owned(), evidence: Vec::<lifecycle::ProtectedEvidence>::new(), cleanup: Vec::<CleanupProof>::new() }).map_err(|error| format!("lifecycle:{error:?}"))?;
    let result_ref = match report.result_ref { Some(value) => value, None => "<none>".to_owned() };
    done(id, format!("lifecycle:close:{result_ref}"))
}

include!(concat!(env!("CARGO_MANIFEST_DIR"), "/../data/seam_real_producers.rs"));


fn args_valid(spec: &str, args: &[String]) -> bool { match spec { "none" => args.is_empty(), "workstream" => args.len() == 1, "workstream task-paths..." => args.len() >= 2, "request..." => !args.is_empty(), "show|parallel-cap" => (args.len() == 1 && args[0] == "show") || (args.len() == 2 && args[0] == "parallel-cap" && args[1].parse::<u32>().is_ok()), _ => false } }
fn command_reject(actual: String) -> Result<ParsedCommand, Rejection> { loop { boundary_runtime(COMMAND_BOUNDARY_ID).reject(actual.clone())?; } }
fn boundary_status(error: &Rejection) -> String { rejection(error.boundary_id(), &format!("expected={};actual={}", error.expected(), error.actual())) }

fn event_parts(rest: &str) -> Result<(EventKind, Ref), String> {
    let (kind, reference) = match rest.split_once(':') { Some(parts) => parts, None => return Err(rejection("malformed-command", "missing-event-ref")) };
    if kind.is_empty() { return Err(rejection("malformed-command", "empty-event-kind")); }
    if reference.is_empty() { return Err(rejection("malformed-command", "empty-event-ref")); }
    Ok((EventKind(kind.to_owned()), Ref(reference.to_owned())))
}
fn payload<T: DeserializeOwned>(frame: &SeamEnvelope) -> Result<(), Rejection> { if let Err(error) = serde_json::from_value::<T>(frame.payload.clone()) { boundary_runtime(BOUNDARY_ID).reject(format!("payload-mismatch:{}:{error}", frame.kind))?; } Ok(()) }
fn done(id: u64, status: String) -> Result<SeamEnvelope, AnyError> { Ok(SeamEnvelope { v: CONTRACT_VERSION as u32, id, kind: "done".to_owned(), payload: serde_json::to_value(CoreToHostDonePayload { status })? }) }
fn spawn(id: u64, action: BackgroundAction) -> Result<SeamEnvelope, AnyError> { Ok(SeamEnvelope { v: CONTRACT_VERSION as u32, id, kind: "spawn".to_owned(), payload: serde_json::to_value(CoreToHostSpawnPayload { action })? }) }
fn ui(id: u64, ui_kind: &str, content: serde_json::Value) -> Result<SeamEnvelope, AnyError> { Ok(SeamEnvelope { v: CONTRACT_VERSION as u32, id, kind: "ui".to_owned(), payload: serde_json::to_value(CoreToHostUiPayload { ui_kind: UiKind(ui_kind.to_owned()), content })? }) }
fn guard_decision(id: u64, value: &str, reason: &str) -> Result<SeamEnvelope, AnyError> { Ok(SeamEnvelope { v: CONTRACT_VERSION as u32, id, kind: "guard-decision".to_owned(), payload: serde_json::to_value(CoreToHostGuardDecisionPayload { decision: GuardDecision(value.to_owned()), reason: reason.to_owned() })? }) }
fn write_frame<W: Write>(writer: &mut W, frame: &SeamEnvelope) -> Result<(), AnyError> { serde_json::to_writer(&mut *writer, frame)?; writer.write_all(b"\n")?; writer.flush()?; Ok(()) }
fn replay_path(path: &Path) -> Result<State, AnyError> {
    let file = match File::open(path) { Ok(file) => file, Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(State::EMPTY), Err(error) => return Err(error.into()) };
    let mut state = State::EMPTY; for line in io::BufReader::new(file).lines() { state = apply(state, &serde_json::from_str::<EventRow>(&line?)?); } Ok(state)
}
fn append_event(path: &Path, event: &EventRow) -> Result<(), AnyError> { if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; } let mut file = OpenOptions::new().create(true).append(true).open(path)?; serde_json::to_writer(&mut file, event)?; file.write_all(b"\n")?; file.sync_data()?; Ok(()) }
fn rejection(code: &str, detail: &str) -> String { format!("rejection:{code}:{detail}") }
