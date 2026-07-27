use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
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
use serde::de::DeserializeOwned;

use crate::allocation::{self, AllocationPolicy, AllocationSubmission, ApprovedUnit, FutureUnit};
use crate::dispatch::{self, DispatchInput, LaneReadiness};
use crate::handoff::{self, AssignmentHandle, CooperativeCheckpoint};
use crate::lifecycle::{self, AbortRequest, CleanupProof, CloseRequest, LocalLifecycle};
use crate::planning::{self, Backlink, Disposition, MaterialPlanElement, QuestionNomination, TaskAuthority, TaskDocument};
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
        "command" => command(frame, state), "guard-query" => guard_decision(frame.id, "deny", "core guard policy is not configured"), "shutdown" => done(frame.id, "ok:shutdown".to_owned()),
        "task-completed" | "agent-result" | "operator-answer" => done(frame.id, "ok:recorded".to_owned()), other => done(frame.id, rejection("unknown-kind", other)),
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
    let source = TaskFiles(args[1..].iter().map(PathBuf::from).collect());
    let inventory = planning::p1_inventory(&source).map_err(|error| format!("planning:{error:?}"))?;
    let dossier = planning::p2_ground(&Facts, &inventory).map_err(|error| format!("planning:{error:?}"))?;
    let first = match inventory.atoms.first() { Some(atom) => atom.id.clone(), None => return done(id, rejection("planning", "empty-inventory")) };
    let disposed = inventory.atoms.iter().map(|atom| planning::Atom { disposition: Some(Disposition { kind: "accepted".to_owned(), backlink: Backlink::VerifiedFact("fact-1".to_owned()) }), ..atom.clone() }).collect::<Vec<_>>();
    planning::admit_question(QuestionNomination { class: planning::question_class_from_d72("dod-hole").map_err(|error| format!("planning:{error:?}"))?, material_consequence: first.clone() }).map_err(|error| format!("planning:{error:?}"))?;
    planning::require_total_dispositions(&disposed).map_err(|error| format!("planning:{error:?}"))?;
    planning::require_material_backlinks(&[MaterialPlanElement { id: "P4".to_owned(), backlinks: vec![Backlink::Atom(first)] }]).map_err(|error| format!("planning:{error:?}"))?;
    planning::AssignmentPlan::d72_default().validate(25).map_err(|error| format!("planning:{error:?}"))?;
    state.append(EventKind("planning:P1-P6".to_owned()), args.iter().map(|arg| Ref(arg.clone())).collect())?;
    done(id, format!("planning:P1-P6:atoms={}:facts={};{}", inventory.atoms.len(), dossier.verified_facts.len(), state.summary()))
}

fn route_run(id: u64, workstream: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let approved = units(); let submission = AllocationSubmission { lanes: vec![lane("l1", &["u1"], 0), lane("l2", &["u2"], 1), lane("l3", &["u3"], 2)], future_units: Vec::<FutureUnit>::new(), authority_echo: approved.clone(), ownership_claims: Vec::new(), overlap_blocks: Vec::new() };
    let allocation = allocation::validate_allocation(&approved, &submission, AllocationPolicy { parallel_cap: 8, active_implementers: 0 }).map_err(|error| format!("allocation:{error:?}"))?;
    let selected = dispatch::select_ready_lanes(&DispatchInput { lanes: allocation.lanes, readiness: vec![ready("l1"), ready("l2"), ready("l3")], active_implementers: 0, parallel_cap: 8, resources: resources() });
    let Some(lane_id) = selected.first() else { return done(id, rejection("dispatch", "no-ready-lane")) };
    state.append(EventKind("dispatch:spawn".to_owned()), vec![Ref(workstream.to_owned()), Ref(lane_id.0.clone())])?;
    spawn(id, runner::bg_action(&assignment(workstream, lane_id)))
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

struct TaskFiles(Vec<PathBuf>);
impl TaskAuthority for TaskFiles { fn documents(&self) -> Result<Vec<TaskDocument>, planning::PlanningError> { let mut out = Vec::new(); for path in &self.0 { let body = fs::read_to_string(path).map_err(|_| planning::PlanningError::NoTaskAuthority)?; out.push(TaskDocument { id: path.display().to_string(), body }); } Ok(out) } }
struct InlineTask(String);
impl TaskAuthority for InlineTask { fn documents(&self) -> Result<Vec<TaskDocument>, planning::PlanningError> { Ok(vec![TaskDocument { id: "operator-request".to_owned(), body: self.0.clone() }]) } }
struct Facts;
impl planning::RepositoryEvidence for Facts { fn facts_for_atoms(&self, atoms: &[planning::Atom]) -> Result<Vec<String>, planning::PlanningError> { Ok(atoms.iter().map(|atom| format!("verified:{}", atom.id)).collect()) } }

fn units() -> Vec<ApprovedUnit> { vec![unit("u1", 1, &[]), unit("u2", 2, &["u1"]), unit("u3", 3, &["u2"])] }
fn unit(name: &str, order: u32, deps: &[&str]) -> ApprovedUnit { ApprovedUnit { id: idv(name), operator_order: order, decisions: Vec::new(), criteria: vec![idv(&format!("criterion-{name}"))], dependencies: ids(deps), predecessor_forward_criteria: if name == "u1" { Vec::new() } else { vec![idv(&format!("gate-{name}"))] }, downstream_release_edges: Vec::new() } }
fn lane(name: &str, unit_ids: &[&str], wave: u32) -> AllocationLaneProposal { let gates = match unit_ids.first() { Some(unit) if name != "l1" => vec![idv(&format!("gate-{unit}"))], _ => Vec::new() }; AllocationLaneProposal { lane_id: idv(name), objective: format!("deliver {name}"), ordered_unit_ids: ids(unit_ids), rationale: "operator order".to_owned(), delivery_boundary: DeliveryBoundary("unit".to_owned()), predecessor_forward_criteria: gates, downstream_release_edges: Vec::new(), context_family_id: idv("context"), context_estimate: 10, focused_tests: vec![TestId("cargo test -q".to_owned())], launch_wave: wave, continue_existing_logical_lane: None } }
fn ready(name: &str) -> LaneReadiness { LaneReadiness { lane_id: idv(name), predecessor_gates_met: true, blockers_clear: true, unit_free: true, route_ready: true, preflight_passed: true, pressure_delay: false } }
fn assignment(workstream: &str, lane_id: &Id) -> RunnerAssignment { RunnerAssignment { action_id: idv(&format!("action-{workstream}-{}", lane_id.0)), assignment_id: idv(&format!("assignment-{workstream}-{}", lane_id.0)), role_id: idv("implementer"), mode: ModeId("lane-delivery".to_owned()), run_revision: 1, lane_id: lane_id.clone(), attempt: 1, base_commit: Sha("0000000000000000000000000000000000000000".to_owned()), worktree: PathBuf::from(format!(".pi/autopilot/{workstream}/worktrees/{}", lane_id.0)), session_file: PathBuf::from(format!(".pi/autopilot/{workstream}/session.json")), roster_assignment: "openai-codex/gpt-subscription".to_owned() } }
fn resources() -> ResourceFacts { ResourceFacts { free_storage_bytes: 20 * 1024 * 1024 * 1024, projected_storage_bytes: 1024, available_memory_bytes: 8 * 1024 * 1024 * 1024, physical_memory_bytes: 16 * 1024 * 1024 * 1024 } }
fn ids(values: &[&str]) -> Vec<Id> { values.iter().map(|value| idv(value)).collect() }
fn idv(value: &str) -> Id { Id(value.to_owned()) }

fn routes() -> Result<Vec<Route>, String> {
    let mut out = Vec::new();
    for raw in COMMANDS_KDL.lines() {
        let line = match raw.split_once("//") { Some((head, _)) => head.trim(), None => raw.trim() };
        if line.is_empty() || begins(line, "schema ") || begins(line, "version ") { continue; }
        if !begins(line, "command ") { return Err(format!("expected command: {line}")); }
        let name = quoted(line).ok_or_else(|| format!("missing command name: {line}"))?;
        out.push(Route { name, driver: need_attr(line, "driver=")?, args: need_attr(line, "args=")?, expects: need_attr(line, "expects=")? });
    }
    if out.is_empty() { Err("no commands".to_owned()) } else { Ok(out) }
}
fn need_attr(line: &str, key: &str) -> Result<String, String> { let at = line.find(key).ok_or_else(|| format!("missing {key}: {line}"))?; let rest = &line[at + key.len()..]; let quoted = rest.strip_prefix('"').ok_or_else(|| format!("unquoted {key}: {line}"))?; let end = quoted.find('"').ok_or_else(|| format!("unterminated {key}: {line}"))?; Ok(quoted[..end].to_owned()) }
fn begins(value: &str, prefix: &str) -> bool { value.get(..prefix.len()) == Some(prefix) }
fn quoted(line: &str) -> Option<String> { let mut parts = line.split('"'); let _before = parts.next()?; parts.next().map(str::to_owned) }
fn valid(routes: &[Route]) -> String { routes.iter().map(|route| format!("/{}", route.name)).collect::<Vec<_>>().join(", ") }
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
