use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use kernel::boundary::Rejection;
use kernel::generated::{
    AllocationLaneProposal, BackgroundAction, CONTRACT_VERSION, CoreToHostDonePayload,
    CoreToHostSpawnPayload, CoreToHostSpawnWavePayload, CoreToHostUiPayload, DeliveryBoundary,
    DeliveryResult, EventKind, EventRow, HostToCoreAgentResultPayload, HostToCoreCommandPayload,
    HostToCoreSpawnResultPayload, HostToCoreTaskCompletedPayload, Id, ModeId, Ref, SeamEnvelope,
    Sha, TestId, UiKind,
};
use kernel::schedule::ResourceFacts;
use kernel::state::{State, apply};
use kernel_macros::acceptance_boundary;
use serde::{Deserialize, Serialize};

use crate::allocation::{self, AllocationPolicy, AllocationSubmission, ApprovedUnit, FutureUnit};
use crate::bgtasks;
use crate::dispatch::{self, DispatchInput, LaneReadiness};
use crate::generated::tables::{self, HostToCoreRoute, SeamAdmissionError};
use crate::handoff::{self, AssignmentHandle, CooperativeCheckpoint};
use crate::lifecycle::{self, AbortRequest, LocalLifecycle};
use crate::planning::{self, TaskAuthority};
use crate::roles::kdl::boundary_runtime;
use crate::roster;
use crate::runner::{self, RunnerAssignment};

pub mod sim_host;

const BOUNDARY_ID: &str = "seam.host-frame.v1";
/// Upper bound on carrier-transported spec bytes hashed during delivery and
/// validation acceptance. The carrier is child-produced, so an unbounded field
/// would let a child force an arbitrary parent-side allocation before the
/// receipt comparison can reject it.
const MAX_CARRIER_SPEC_BYTES: usize = 1 << 20;
pub const MAX_TERMINAL_CARRIER_BYTES: usize = 4 << 20;
const MAX_VALIDATION_BOUND_ARTIFACT_BYTES: usize = 2 << 20;
const MAX_TOOL_AUDIT_BYTES: usize = 256 << 10;
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
    if envelope.v != CONTRACT_VERSION as u32 {
        return done(
            id,
            rejection(BOUNDARY_ID, &format!("version-mismatch:{}", envelope.v)),
        );
    }
    match tables::admit_host_to_core(&envelope.kind, envelope.payload) {
        Ok(route) => dispatch(id, route, state),
        Err(error) => done(id, seam_admission_status(error)),
    }
}

fn seam_admission_status(error: SeamAdmissionError) -> String {
    match error {
        SeamAdmissionError::Unknown(kind) => {
            rejection(BOUNDARY_ID, &format!("unknown-kind:{kind}"))
        }
        SeamAdmissionError::Unsupported(row) => rejection(
            BOUNDARY_ID,
            &format!("unsupported-kind:{}:{}", row.kind, row.adapter),
        ),
        SeamAdmissionError::Payload { kind, error } => {
            rejection(BOUNDARY_ID, &format!("payload-mismatch:{kind}:{error}"))
        }
    }
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

fn dispatch(
    id: u64,
    route: HostToCoreRoute,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    match route {
        HostToCoreRoute::Command(payload) => command(id, payload, state),
        HostToCoreRoute::TaskCompleted(payload) => route_task_completed(id, payload, state),
        HostToCoreRoute::SpawnResult(payload) => route_spawn_result(id, payload, state),
        HostToCoreRoute::AgentResult(payload) => route_agent_result(id, payload, state),
        HostToCoreRoute::OperatorAnswer(_) => done(id, "ok:recorded".to_owned()),
        HostToCoreRoute::Shutdown(_) => done(id, "ok:shutdown".to_owned()),
    }
}

fn command(
    id: u64,
    HostToCoreCommandPayload {
        raw,
        background_capabilities,
        background_capability_diagnostic,
    }: HostToCoreCommandPayload,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    if raw == "state" {
        return done(id, state.summary());
    }
    if matches!(raw.as_str(), "append" | "crash-window") {
        return done(id, rejection("malformed-command", &raw));
    }
    if (raw.starts_with("append:") || raw.starts_with("crash-window:") || raw.starts_with("state:"))
        && let Some((verb, rest)) = raw.split_once(':')
    {
        return legacy_command(id, verb, rest, state);
    }
    let parsed = match admit_operator_command(&raw) {
        Ok(value) => value,
        Err(error) => return done(id, boundary_status(&error)),
    };
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
    let assignments =
        planning_assignments(workstream).map_err(|error| context_status("planning", error))?;
    write_planning_manifest(workstream, &input_set, &inventory, &dossier, &assignments)?;
    match next_planning_outcome(workstream, state)
        .map_err(|error| context_status("planning", error))?
    {
        planning::PlanningWaveOutcome::Launch {
            assignments: wave, ..
        } => {
            let actions = planning_wave_actions(workstream, &wave, state, &input_set, None)?;
            controlled_spawn_wave(id, actions, state, "planning")
        }
        planning::PlanningWaveOutcome::WaitingOnInFlight { wave_id, active } => {
            let actions = unacknowledged_planning_actions(state, &active)?;
            if actions.is_empty() {
                return done(id, planning_waiting_status(&wave_id, &active, state));
            }
            validate_spawn_wave_actions(&actions)?;
            spawn_wave(id, actions)
        }
        planning::PlanningWaveOutcome::Complete => {
            if assignments.is_empty() {
                return done(id, rejection("planning-wave", "empty-initial-wave"));
            }
            done(
                id,
                format!(
                    "planning:complete:workstream={workstream};{}",
                    state.summary()
                ),
            )
        }
        planning::PlanningWaveOutcome::Blocked(blocked) => {
            done(id, planning_blocked_status(&blocked, state))
        }
        planning::PlanningWaveOutcome::CapacityUnknown(detail) => done(
            id,
            rejection("planning-wave", &format!("capacity-unknown:{detail}")),
        ),
    }
}

fn route_run(id: u64, workstream: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    if let Some(status) =
        advance_lifecycle_if_ready(workstream, None, ClosureTrigger::RunCommand, state)?
    {
        return done(id, status);
    }
    let outcome = advance_run(id, workstream, state)?;
    advance_run_envelope(id, outcome)
}

#[derive(Debug)]
enum AdvanceRunOutcome {
    Dispatched(SeamEnvelope),
    Waiting(String),
    Stuck(String),
}

fn advance_run_envelope(id: u64, outcome: AdvanceRunOutcome) -> Result<SeamEnvelope, AnyError> {
    match outcome {
        AdvanceRunOutcome::Dispatched(envelope) => Ok(envelope),
        AdvanceRunOutcome::Waiting(status) | AdvanceRunOutcome::Stuck(status) => done(id, status),
    }
}

fn advance_run(
    id: u64,
    workstream: &str,
    state: &mut CoreState,
) -> Result<AdvanceRunOutcome, AnyError> {
    if let Some(envelope) = resume_pending_validation_recovery(id, workstream, state)? {
        return Ok(AdvanceRunOutcome::Dispatched(envelope));
    }
    if let Some(envelope) = resume_pending_delivery_recovery(id, workstream, state)? {
        return Ok(AdvanceRunOutcome::Dispatched(envelope));
    }
    let approved_artifact = read_approved_plan_artifact(workstream)
        .map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
    let repository_authority = approved_artifact
        .repository_authority
        .as_ref()
        .ok_or_else(|| "CONTEXT_GAP:approved-plan:missing repository authority".to_owned())?;
    let cwd = fs::canonicalize(std::env::current_dir()?)?;
    ensure_run_main_at_approved_baseline(
        &cwd,
        workstream,
        repository_authority,
        delivery_execution_started(state),
    )?;
    let approved = approved_artifact.units;
    let submission = allocation_submission_from_plan(workstream, &approved, state)
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
    let mut selected = dispatch::select_ready_lanes(&DispatchInput {
        lanes: allocation.lanes,
        readiness: readiness.clone(),
        active_implementers: active_implementers(state),
        parallel_cap: 8,
        resources,
    });
    selected.retain(|lane_id| !lane_closed(state, lane_id));
    // Independent of the `unit-active:` bookkeeping written at dispatch time: a lane
    // whose implementer binding is already live must never be dispatched twice. This
    // is derived from the runner invocation log itself, so losing the dispatch-time
    // marker cannot silently re-enable double dispatch.
    selected.retain(|lane_id| !lane_has_live_delivery(state, lane_id));
    if let Some(lane_id) = selected.first() {
        let assignment = assignment(workstream, lane_id, &approved, &submission)?;
        let issue = runner::delivery_issue_with_facts(
            &assignment,
            &runner::RunnerTransportFacts::from_env()?,
        )?;
        append_runner_invocation(state, &issue.binding)?;
        let envelope = controlled_spawn(id, issue.action, state, "delivery")?;
        return Ok(AdvanceRunOutcome::Dispatched(envelope));
    }

    let diagnostics = advance_diagnostics(state, &submission, &approved, &readiness, &selected);
    if active_or_unknown_work(state) || queued_candidates(state) > 0 {
        Ok(AdvanceRunOutcome::Waiting(format!(
            "dispatch:waiting:{};{}",
            diagnostics,
            state.summary()
        )))
    } else {
        Ok(AdvanceRunOutcome::Stuck(rejection(
            "dispatch-stuck",
            &format!("{};{}", diagnostics, state.summary()),
        )))
    }
}

fn resume_pending_validation_recovery(
    id: u64,
    workstream: &str,
    state: &mut CoreState,
) -> Result<Option<SeamEnvelope>, AnyError> {
    let mut validation_ids = state
        .state
        .refs
        .keys()
        .filter_map(|reference| reference.0.strip_prefix("recovery-validation-pending:"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    validation_ids.sort();
    validation_ids.dedup();
    for validation_id in validation_ids {
        let validation = issued_binding_for_assignment(state, &idv(&validation_id))
            .ok_or_else(|| format!("recovery resume missing validation binding {validation_id}"))?;
        if validation.workstream.0 != workstream
            || validation.role_id.0 != "validator"
            || !terminal_consumed(state, &validation)
        {
            continue;
        }
        let result = read_validation_result(&validation)?;
        let producer_ids = match &result {
            ReadValidationResult::V2(value) => &value.producer_assignment_ids,
            ReadValidationResult::V3(value) => &value.producer_assignment_ids,
        };
        let producer_id = producer_ids
            .first()
            .ok_or_else(|| "recovery resume validation missing producer".to_owned())?;
        let recovery_id = idv(&format!("recovery-{}-a1", producer_id.0));
        if let Some(recovery) = issued_binding_for_assignment(state, &recovery_id) {
            if terminal_consumed(state, &recovery) || launch_ack_consumed(state, &recovery) {
                continue;
            }
            let action = planning_action_from_binding(&recovery)?;
            state.append(
                EventKind("recovery:resumed".to_owned()),
                vec![
                    Ref(format!("recovery-issued:{}", producer_id.0)),
                    Ref(recovery.assignment_id.0.clone()),
                ],
            )?;
            return controlled_spawn(id, action, state, "validation-recovery-reemit").map(Some);
        }
        return match result {
            ReadValidationResult::V2(result) => {
                let blockers = validation_blockers(&result);
                if result.submission.outcome == kernel::generated::ValidationOutcomeV2::FORWARDREADY
                    || blockers.is_empty()
                {
                    return Err(
                        "recovery resume validation is not a blocked coherent verdict".into(),
                    );
                }
                repair_needed(id, &validation, &result, blockers, state).map(Some)
            }
            ReadValidationResult::V3(result) => {
                let blockers = validation_blockers_v3(&result);
                if result.verdict.outcome == kernel::generated::ValidationOutcomeV2::FORWARDREADY
                    || blockers.is_empty()
                {
                    return Err(
                        "recovery resume v3 validation is not a blocked coherent verdict".into(),
                    );
                }
                repair_needed_v3(id, &validation, &result, blockers, state).map(Some)
            }
        };
    }
    Ok(None)
}

fn resume_pending_delivery_recovery(
    id: u64,
    workstream: &str,
    state: &mut CoreState,
) -> Result<Option<SeamEnvelope>, AnyError> {
    let mut source_ids = state
        .state
        .refs
        .keys()
        .filter_map(|reference| reference.0.strip_prefix("recovery-pending:"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    source_ids.sort();
    source_ids.dedup();
    for source_id in source_ids {
        let source = issued_binding_for_assignment(state, &idv(&source_id))
            .ok_or_else(|| format!("recovery resume missing source binding {source_id}"))?;
        if source.workstream.0 != workstream
            || source.result_contract.0 != "autopilot.delivery_result.v2"
            || !terminal_consumed(state, &source)
        {
            continue;
        }
        let recovery_assignment_id = idv(&format!("recovery-{}-a1", source.assignment_id.0));
        if let Some(recovery) = issued_binding_for_assignment(state, &recovery_assignment_id) {
            if terminal_consumed(state, &recovery) || launch_ack_consumed(state, &recovery) {
                continue;
            }
            let action = planning_action_from_binding(&recovery)?;
            state.append(
                EventKind("recovery:resumed".to_owned()),
                vec![
                    Ref(format!("recovery-issued:{}", source.assignment_id.0)),
                    Ref(recovery.assignment_id.0.clone()),
                ],
            )?;
            return controlled_spawn(id, action, state, "semantic-recovery-reemit").map(Some);
        }
        let carrier_text = read_bounded_utf8(
            Path::new(&source.carrier_path),
            MAX_TERMINAL_CARRIER_BYTES,
            "recovery-resume-carrier",
        )?;
        let result: kernel::generated::DeliveryResultV2 = serde_json::from_str(&carrier_text)
            .map_err(|error| format!("recovery resume carrier json:{error}"))?;
        let facts = validate_delivery_result_v2(&result, &source)
            .map_err(|error| format!("recovery resume carrier binding:{error}"))?;
        if runner::delivery_submission_outcome(&result.submission)
            != runner::DeliverySubmissionOutcome::Blocked
        {
            return Err("recovery resume source is not a blocked delivery".into());
        }
        let DeliveryRecoveryDecision::Admit(assessment) =
            assess_blocked_delivery_recovery(&source, &result, &facts)?
        else {
            return Err("recovery resume source is no longer mechanically admissible".into());
        };
        for reference in recovery_assessment_refs(&source, &assessment) {
            if !state.state.refs.contains_key(&reference) {
                return Err(format!(
                    "recovery resume assessment drift for {}: {}",
                    source.assignment_id.0, reference.0
                )
                .into());
            }
        }
        return issue_delivery_recovery(id, &source, &result, &assessment, state).map(Some);
    }
    Ok(None)
}

fn lane_has_live_delivery(state: &CoreState, lane_id: &Id) -> bool {
    state
        .state
        .refs
        .keys()
        .filter_map(|reference| runner::decode_binding_ref(&reference.0))
        .any(|binding| {
            matches!(
                binding.role_id.0.as_str(),
                "implementer" | "recovery-engineer"
            ) && binding.lane_id.as_ref().is_some_and(|lane| lane == lane_id)
                && !terminal_consumed(state, &binding)
        })
}

/// Forward-criterion gates satisfied by the lane that just closed.
///
/// `predecessor_forward_criteria` is package-owned identity authority derived
/// from exact declared `depends_on` unit ids, never from array position. A
/// closing lane satisfies `unit-complete:<unit-id>` only for units it actually
/// delivered and only when another approved delivery waits on that identity.
fn satisfied_forward_gate_refs(
    workstream: &str,
    lane_id: Option<&Id>,
) -> Result<Vec<Ref>, AnyError> {
    let Some(lane_id) = lane_id else {
        return Ok(Vec::new());
    };
    let approved = read_approved_plan(workstream)
        .map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
    let unit = approved
        .iter()
        .enumerate()
        .find(|(index, _)| approved_lane_id(*index) == *lane_id)
        .map(|(_, unit)| unit)
        .ok_or_else(|| format!("forward-gate:unknown-lane:{}", lane_id.0))?;
    let criterion = Id(format!("unit-complete:{}", unit.id.0));
    Ok(approved
        .iter()
        .any(|other| other.predecessor_forward_criteria.contains(&criterion))
        .then(|| Ref(format!("gate:{}", criterion.0)))
        .into_iter()
        .collect())
}

fn lane_closed(state: &CoreState, lane_id: &Id) -> bool {
    has_exact_ref(state, &format!("unit-closed:{}", lane_id.0))
}

fn advance_diagnostics(
    state: &CoreState,
    submission: &AllocationSubmission,
    approved: &[ApprovedUnit],
    readiness: &[LaneReadiness],
    selected: &[Id],
) -> String {
    let closed = submission
        .lanes
        .iter()
        .filter(|lane| lane_closed(state, &lane.lane_id))
        .map(|lane| lane.lane_id.0.clone())
        .collect::<Vec<_>>();
    let ready_undispatched = selected
        .iter()
        .map(|lane| lane.0.clone())
        .collect::<Vec<_>>();
    let blocked = blocked_lane_details(state, submission, approved, readiness, selected);
    format!(
        "closed=[{}];ready_undispatched=[{}];blocked=[{}];active_implementers={};active_validators={};active_fixers={};active_or_unknown={};queued_candidates={}",
        closed.join(","),
        ready_undispatched.join(","),
        blocked.join(","),
        active_implementers(state),
        active_validators(state),
        active_recovery_engineers(state),
        active_or_unknown_work(state),
        queued_candidates(state)
    )
}

fn blocked_lane_details(
    state: &CoreState,
    submission: &AllocationSubmission,
    approved: &[ApprovedUnit],
    readiness: &[LaneReadiness],
    selected: &[Id],
) -> Vec<String> {
    submission
        .lanes
        .iter()
        .filter(|lane| !lane_closed(state, &lane.lane_id))
        .filter(|lane| !selected.iter().any(|selected| selected == &lane.lane_id))
        .map(|lane| {
            let facts = readiness.iter().find(|item| item.lane_id == lane.lane_id);
            let mut reasons = Vec::new();
            if facts.is_some_and(|facts| !facts.unit_free) {
                reasons.push("active-unit".to_owned());
            }
            if facts.is_some_and(|facts| !facts.predecessor_gates_met) {
                reasons.extend(unmet_predecessor_details(state, submission, approved, lane));
            }
            if facts.is_some_and(|facts| !facts.blockers_clear) {
                reasons.push("blocker".to_owned());
            }
            if facts.is_some_and(|facts| !facts.route_ready) {
                reasons.push("route-not-ready".to_owned());
            }
            if facts.is_some_and(|facts| !facts.preflight_passed) {
                reasons.push("preflight".to_owned());
            }
            if facts.is_some_and(|facts| facts.pressure_delay) {
                reasons.push("pressure".to_owned());
            }
            if facts.is_none() {
                reasons.push("missing-readiness".to_owned());
            }
            if reasons.is_empty() {
                reasons.push("not-selected".to_owned());
            }
            format!("{}:{}", lane.lane_id.0, reasons.join("+"))
        })
        .collect()
}

fn unmet_predecessor_details(
    state: &CoreState,
    submission: &AllocationSubmission,
    approved: &[ApprovedUnit],
    lane: &AllocationLaneProposal,
) -> Vec<String> {
    let mut details = Vec::new();
    for unit_id in &lane.ordered_unit_ids {
        let Some(unit) = approved.iter().find(|unit| unit.id == *unit_id) else {
            details.push(format!("unknown-unit:{}", unit_id.0));
            continue;
        };
        for dependency in &unit.dependencies {
            let dependency_lane = submission
                .lanes
                .iter()
                .find(|candidate| candidate.ordered_unit_ids.contains(dependency));
            match dependency_lane {
                Some(dependency_lane) if !lane_closed(state, &dependency_lane.lane_id) => details
                    .push(format!(
                        "unmet_dependency:{}({})",
                        dependency.0, dependency_lane.lane_id.0
                    )),
                None => details.push(format!("unmet_dependency:{}(unassigned)", dependency.0)),
                Some(_) => {}
            }
        }
        for gate in &unit.predecessor_forward_criteria {
            if !has_exact_ref(state, &format!("gate:{}", gate.0)) {
                details.push(format!("unmet_dependency_gate:{}", gate.0));
            }
        }
    }
    if details.is_empty() {
        details.push("predecessor".to_owned());
    }
    details
}

fn route_agent_result(
    id: u64,
    HostToCoreAgentResultPayload {
        assignment_id,
        carrier,
    }: HostToCoreAgentResultPayload,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let carrier: AgentCarrier = match serde_json::from_value(carrier) {
        Ok(value) => value,
        Err(error) => return done(id, rejection("agent-result-carrier", &error.to_string())),
    };
    accept_planning_carrier(id, &assignment_id, carrier, state, None)
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
    if terminal_consumed(state, &binding) {
        return done(
            id,
            rejection(
                "agent-result-terminal",
                "terminal evidence for this planning binding is already final",
            ),
        );
    }
    if let Err(error) = validate_agent_output(&binding, &carrier.raw_output) {
        return done(id, boundary_status(&error));
    }
    let recovery_admission = match validate_recovery_work_map(&carrier, &binding) {
        Ok(admission) => admission,
        Err(error) => return done(id, rejection("planning-recovery", &error)),
    };
    let review_rejection = (carrier.boundary_id == "planning.plan-review.v1")
        .then(|| review_approves_execution(&carrier.raw_output).err())
        .flatten();
    let first_review_requires_recovery = if review_rejection.is_some() {
        planning_assignment_for(&carrier.workstream, &carrier.assignment_id)
            .is_ok_and(|assignment| assignment.role == "plan-reviewer" && assignment.ordinal == 1)
    } else {
        false
    };
    if let Some(error) = review_rejection.as_ref()
        && !first_review_requires_recovery
    {
        let recovery_exhausted =
            planning_assignment_for(&carrier.workstream, &carrier.assignment_id).is_ok_and(
                |assignment| assignment.role == "plan-reviewer" && assignment.ordinal == 2,
            );
        if let Some(payload) = terminal {
            append_terminal_event(state, payload, &binding)?;
            record_task_completion_control(state, payload)?;
            if recovery_exhausted {
                state.append(
                    EventKind("recovery:exhausted".to_owned()),
                    vec![
                        Ref(carrier.assignment_id.clone()),
                        Ref(carrier.carrier_path.clone()),
                        Ref("planning.plan-review.v1".to_owned()),
                        Ref("semantic-recovery-exhausted".to_owned()),
                    ],
                )?;
            }
            return planning_blocked_or_summary(id, &carrier.workstream, state);
        }
        return done(id, rejection("planning-postprocess", error));
    }
    if let PlanningRecoveryAdmission::FailClosed(disposition) = recovery_admission {
        let Some(payload) = terminal else {
            return done(
                id,
                rejection(
                    "planning-recovery",
                    "fail-closed recovery disposition requires durable terminal evidence",
                ),
            );
        };
        append_terminal_event(state, payload, &binding)?;
        record_task_completion_control(state, payload)?;
        state.append(
            EventKind("recovery:inadmissible".to_owned()),
            vec![
                Ref(carrier.assignment_id.clone()),
                Ref(carrier.carrier_path.clone()),
                Ref(format!("recovery-disposition:{disposition:?}")),
                recovery_disposition_failure_ref(&disposition),
                Ref("semantic-recovery-fail-closed".to_owned()),
            ],
        )?;
        return done(
            id,
            rejection("planning-recovery-fail-closed", &format!("{disposition:?}")),
        );
    }
    if !first_review_requires_recovery
        && let Err(error) = apply_planning_side_effects(&carrier, &binding)
    {
        return done(id, rejection("planning-postprocess", &error));
    }
    if let Some(payload) = terminal {
        append_terminal_event(state, payload, &binding)?;
        record_task_completion_control(state, payload)?;
    } else if first_review_requires_recovery {
        return done(
            id,
            rejection(
                "planning-recovery",
                "blocked first review requires durable terminal evidence",
            ),
        );
    }
    if carrier.boundary_id == "planning.plan-review.v1" && !first_review_requires_recovery {
        let subject_path = binding
            .planning_subject_path
            .as_ref()
            .ok_or_else(|| "approved review missing bound subject path".to_owned())?;
        let subject_digest = binding
            .planning_subject_digest
            .as_ref()
            .ok_or_else(|| "approved review missing bound subject digest".to_owned())?;
        state.append(
            EventKind("planning:ready-to-execute".to_owned()),
            vec![
                Ref(carrier.workstream.clone()),
                Ref(plan_path(&carrier.workstream).display().to_string()),
                Ref(assignment_id.0.clone()),
                Ref(carrier.action_id.clone()),
                Ref(carrier.boundary_id.clone()),
                Ref(carrier.spec_digest.clone()),
                Ref(format!("review-subject-carrier:{subject_path}")),
                Ref(format!("review-subject-sha256:{subject_digest}")),
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
    let mut result_refs = vec![
        Ref(assignment_id.0.clone()),
        Ref(carrier.action_id.clone()),
        Ref(carrier.boundary_id.clone()),
        Ref(carrier.workstream.clone()),
        Ref(carrier.spec_digest.clone()),
        planning_result_consumed_ref(&binding),
    ];
    let event_kind = if first_review_requires_recovery {
        let baseline_path = binding
            .planning_subject_path
            .as_ref()
            .ok_or_else(|| "planning recovery baseline path missing".to_owned())?;
        let baseline_digest = binding
            .planning_subject_digest
            .as_ref()
            .ok_or_else(|| "planning recovery baseline digest missing".to_owned())?;
        result_refs.push(Ref("planning-recovery-required".to_owned()));
        result_refs.push(Ref(format!("recovery-baseline-carrier:{baseline_path}")));
        result_refs.push(Ref(format!("recovery-baseline-sha256:{baseline_digest}")));
        result_refs.push(Ref(format!(
            "rejected-review-carrier:{}",
            carrier.carrier_path
        )));
        result_refs.push(Ref(format!(
            "rejected-review-diagnosis:{}",
            review_rejection.as_deref().unwrap_or("unknown")
        )));
        "planning:recovery-required"
    } else if carrier.role_id == "recovery-engineer"
        && carrier.mode == "planning-repair"
        && carrier.boundary_id == "planning.work-map.v1"
    {
        let baseline_path = binding
            .planning_subject_path
            .as_ref()
            .ok_or_else(|| "planning recovery baseline path missing".to_owned())?;
        let baseline_digest = binding
            .planning_subject_digest
            .as_ref()
            .ok_or_else(|| "planning recovery baseline digest missing".to_owned())?;
        result_refs.push(Ref("planning-rereview-required".to_owned()));
        result_refs.push(Ref(format!("recovery-baseline-carrier:{baseline_path}")));
        result_refs.push(Ref(format!("recovery-baseline-sha256:{baseline_digest}")));
        result_refs.push(Ref(format!(
            "recovery-output-sha256:{}",
            sha256_hex_local(carrier.raw_output.as_bytes())
        )));
        "planning:recovery-completed"
    } else {
        "agent:result"
    };
    state.append(EventKind(event_kind.to_owned()), result_refs)?;
    if let Err(error) = ensure_atom_registry_after_task_atoms(&carrier.workstream, state) {
        return done(id, rejection("planning-postprocess", &error.to_string()));
    }
    match next_planning_outcome(&carrier.workstream, state)
        .map_err(|error| context_status("planning", error))?
    {
        planning::PlanningWaveOutcome::Launch {
            assignments: next, ..
        } => {
            let input_set = read_planning_input_set(&carrier.workstream)
                .map_err(|error| format!("CONTEXT_GAP:planning-manifest:{error}"))?;
            let needs_atom_registry = next.iter().any(|assignment| {
                assignment.boundary_id.as_deref() == Some("planning.work-map.v1")
            });
            let atom_registry = if needs_atom_registry {
                match ensure_atom_registry(&carrier.workstream, state) {
                    Ok(registry) => Some(registry),
                    Err(error) => {
                        return done(id, rejection("planning-postprocess", &error.to_string()));
                    }
                }
            } else {
                None
            };
            let actions = planning_wave_actions(
                &carrier.workstream,
                &next,
                state,
                &input_set,
                atom_registry,
            )?;
            return controlled_spawn_wave(id, actions, state, "planning");
        }
        planning::PlanningWaveOutcome::WaitingOnInFlight { wave_id, active } => {
            let actions = unacknowledged_planning_actions(state, &active)?;
            if actions.is_empty() {
                return done(id, planning_waiting_status(&wave_id, &active, state));
            }
            validate_spawn_wave_actions(&actions)?;
            return spawn_wave(id, actions);
        }
        planning::PlanningWaveOutcome::Complete => {}
        planning::PlanningWaveOutcome::Blocked(blocked) => {
            return done(id, planning_blocked_status(&blocked, state));
        }
        planning::PlanningWaveOutcome::CapacityUnknown(detail) => {
            return done(
                id,
                rejection("planning-wave", &format!("capacity-unknown:{detail}")),
            );
        }
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

fn route_spawn_result(
    id: u64,
    payload: HostToCoreSpawnResultPayload,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let binding = match binding_for(state, &payload.action_id.0, &payload.assignment_id.0) {
        Ok(value) => value,
        Err(error) => return done(id, rejection("spawn-result-binding", &error)),
    };
    match payload.status.as_str() {
        "launched" => {
            let Some(task_id) = payload.task_id.as_ref() else {
                return done(id, rejection("spawn-result", "launched-missing-task-id"));
            };
            if payload.diagnostic.is_some() {
                return done(id, rejection("spawn-result", "launched-with-diagnostic"));
            }
            if launch_ack_consumed(state, &binding) {
                return done(id, rejection("spawn-result", "already-acknowledged"));
            }
            append_launch_ack_event(state, task_id, &binding)?;
            done(id, state.summary())
        }
        "launch-failed" => {
            let Some(diagnostic) = payload.diagnostic.as_ref() else {
                return done(id, rejection("spawn-result", "failed-missing-diagnostic"));
            };
            if payload.task_id.is_some() {
                return done(id, rejection("spawn-result", "failed-with-task-id"));
            }
            if launch_failure_consumed(state, &binding) {
                return done(id, rejection("spawn-result", "already-failed"));
            }
            append_launch_failure_event(state, diagnostic, &binding)?;
            planning_blocked_or_summary(id, &binding.workstream.0, state)
        }
        other => done(id, rejection("spawn-result-status", other)),
    }
}

fn planning_blocked_or_summary(
    id: u64,
    workstream: &str,
    state: &CoreState,
) -> Result<SeamEnvelope, AnyError> {
    match next_planning_outcome(workstream, state) {
        Ok(planning::PlanningWaveOutcome::Blocked(blocked)) => {
            done(id, planning_blocked_status(&blocked, state))
        }
        Ok(planning::PlanningWaveOutcome::WaitingOnInFlight { wave_id, active }) => {
            done(id, planning_waiting_status(&wave_id, &active, state))
        }
        Ok(_) => done(id, state.summary()),
        Err(error) => done(id, rejection("planning-postprocess", &format!("{error:?}"))),
    }
}

fn read_bounded_utf8(path: &Path, max_bytes: usize, label: &str) -> Result<String, String> {
    let bytes =
        runner::read_bounded_file(path, max_bytes).map_err(|error| format!("{label}:{error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("{label}:utf8:{error}"))
}

fn route_task_completed(
    id: u64,
    payload: HostToCoreTaskCompletedPayload,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let binding = match binding_for(state, &payload.action_id.0, &payload.assignment_id.0) {
        Ok(value) => value,
        Err(error) => return done(id, rejection("terminal-binding", &error)),
    };
    if terminal_consumed(state, &binding) {
        return done(id, rejection("terminal-binding", "already-consumed"));
    }
    if !terminal_status_allowed(&payload.status) {
        return done(id, rejection("terminal-status", &payload.status));
    }
    if payload.status != "completed" {
        append_terminal_event(state, &payload, &binding)?;
        if binding.result_contract.0.starts_with("planning.") {
            return planning_blocked_or_summary(id, &binding.workstream.0, state);
        }
        return done(id, state.summary());
    }
    if binding.result_contract.0 == "autopilot.delivery_result.v2" {
        let carrier_path = PathBuf::from(&binding.carrier_path);
        let carrier_text = match read_bounded_utf8(
            &carrier_path,
            MAX_TERMINAL_CARRIER_BYTES,
            "delivery-carrier-read",
        ) {
            Ok(value) => value,
            Err(error) => return done(id, rejection("carrier-read", &error)),
        };
        let result_v2: kernel::generated::DeliveryResultV2 =
            match serde_json::from_str(&carrier_text) {
                Ok(value) => value,
                Err(error) => {
                    return done(
                        id,
                        rejection(
                            "delivery-carrier",
                            &format!("{}:{error}", binding.carrier_path),
                        ),
                    );
                }
            };
        let validated = match validate_delivery_result_v2(&result_v2, &binding) {
            Ok(value) => value,
            Err(error) => return done(id, rejection("delivery-carrier-binding", &error)),
        };
        let result = delivery_v1_projection(&result_v2);
        let expected = match delivery_expectation_from_binding(&binding) {
            Ok(value) => value,
            Err(error) => return done(id, rejection("delivery-binding", &error)),
        };
        if runner::delivery_submission_outcome(&result_v2.submission)
            == runner::DeliverySubmissionOutcome::Blocked
        {
            append_terminal_event(state, &payload, &binding)?;
            let mut blocked_refs = vec![
                Ref(binding.assignment_id.0.clone()),
                Ref(binding.action_id.0.clone()),
                result.execution_audit_ref.clone(),
                Ref(format!(
                    "hard-boundary-violations:{}",
                    result.hard_boundary_violations.len()
                )),
                Ref(format!(
                    "delivery-blocker-class:{:?}",
                    result_v2.submission.blocker_class
                )),
                Ref(format!(
                    "policy-denials:{}",
                    validated.denial_ledger.entries.len()
                )),
            ];
            if binding.role_id.0 == "recovery-engineer" {
                state.append(EventKind("agent:delivery-blocked".to_owned()), blocked_refs)?;
                record_delivery_transcript(&binding, &carrier_text, state)?;
                let Some(disposition) = result_v2.submission.recovery_disposition.as_ref() else {
                    return done(
                        id,
                        rejection(
                            "recovery-disposition",
                            "missing after admitted recovery result",
                        ),
                    );
                };
                state.append(
                    EventKind("recovery:inadmissible".to_owned()),
                    vec![
                        Ref(binding.assignment_id.0.clone()),
                        Ref(format!("recovery-disposition:{disposition:?}")),
                        recovery_disposition_failure_ref(disposition),
                        lane_blocker_ref(&binding)?,
                    ],
                )?;
                return done(
                    id,
                    rejection("recovery-fail-closed", &format!("{disposition:?}")),
                );
            }
            let decision = assess_blocked_delivery_recovery(&binding, &result_v2, &validated)?;
            if let DeliveryRecoveryDecision::Admit(assessment) = &decision {
                blocked_refs.extend(recovery_assessment_refs(&binding, assessment));
                if assessment.admission == DeliveryRecoveryAdmission::PolicyDenialRepairable {
                    blocked_refs.push(Ref("delivery-policy-denial-reconciliation".to_owned()));
                }
                blocked_refs.push(Ref(format!("recovery-pending:{}", binding.assignment_id.0)));
            }
            state.append(EventKind("agent:delivery-blocked".to_owned()), blocked_refs)?;
            record_delivery_transcript(&binding, &carrier_text, state)?;
            match decision {
                DeliveryRecoveryDecision::Admit(assessment) => {
                    return issue_delivery_recovery(id, &binding, &result_v2, &assessment, state);
                }
                DeliveryRecoveryDecision::Unsafe(error) => {
                    state.append(
                        EventKind("recovery:inadmissible".to_owned()),
                        vec![
                            Ref(binding.assignment_id.0.clone()),
                            Ref(format!("delivery-recovery-unsafe:{error:?}")),
                            Ref("semantic-recovery-unsafe".to_owned()),
                            lane_blocker_ref(&binding)?,
                        ],
                    )?;
                    return done(
                        id,
                        rejection("delivery-recovery-unsafe", &format!("{error:?}")),
                    );
                }
                DeliveryRecoveryDecision::Inadmissible(reason) => {
                    state.append(
                        EventKind("recovery:inadmissible".to_owned()),
                        vec![
                            Ref(binding.assignment_id.0.clone()),
                            Ref(format!(
                                "delivery-blocker-class:{:?}",
                                result_v2.submission.blocker_class
                            )),
                            Ref(format!("delivery-recovery-reason:{reason}")),
                            delivery_blocker_failure_ref(
                                result_v2.submission.blocker_class.as_ref(),
                            ),
                            lane_blocker_ref(&binding)?,
                        ],
                    )?;
                    return done(
                        id,
                        rejection(
                            "delivery-recovery-inadmissible",
                            &format!("{:?}", result_v2.submission.blocker_class),
                        ),
                    );
                }
            }
        }
        let package = match runner::establish_delivery_package(&result, &expected) {
            Ok(value) => value,
            Err(error) => {
                return done(id, rejection("delivery-rejected", &format!("{error:?}")));
            }
        };
        let accepted = match runner::accept_delivery_with_package_facts(
            std::slice::from_ref(&result),
            &expected,
            &package,
        ) {
            Ok(value) => value,
            Err(error) => {
                return done(id, rejection("delivery-rejected", &format!("{error:?}")));
            }
        };
        let validation_issue = match validation_issue_for_delivery(
            &binding,
            &accepted,
            &validated.command_executions,
            state.state.revision,
        ) {
            Ok(value) => value,
            Err(error) => return done(id, rejection("delivery-package-check", &error)),
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
        return delivery_accepted(id, &binding, &accepted, validation_issue, state);
    }
    if matches!(
        binding.result_contract.0.as_str(),
        "autopilot.validation_result.v2" | "autopilot.validation_result.v3"
    ) {
        return validation_completed(id, &binding, &payload, state);
    }
    if binding.result_contract.0.starts_with("planning.") {
        let carrier_text = match read_bounded_utf8(
            Path::new(&binding.carrier_path),
            MAX_TERMINAL_CARRIER_BYTES,
            "planning-carrier-read",
        ) {
            Ok(value) => value,
            Err(error) => return done(id, rejection("carrier-read", &error)),
        };
        let carrier: AgentCarrier = match serde_json::from_str(&carrier_text) {
            Ok(value) => value,
            Err(error) => {
                return done(
                    id,
                    rejection(
                        "planning-carrier",
                        &format!("{}:{error}", binding.carrier_path),
                    ),
                );
            }
        };
        return accept_planning_carrier(id, &binding.assignment_id, carrier, state, Some(&payload));
    }
    append_terminal_event(state, &payload, &binding)?;
    record_task_completion_control(state, &payload)?;
    done(id, state.summary())
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
    if binding.result_contract.0 == "autopilot.delivery_result.v2" {
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

fn launch_ack_consumed(state: &CoreState, binding: &runner::IssuedRunnerBinding) -> bool {
    state.state.refs.contains_key(&launch_ack_ref(binding))
}

fn launch_failure_consumed(state: &CoreState, binding: &runner::IssuedRunnerBinding) -> bool {
    state.state.refs.contains_key(&launch_failure_ref(binding))
}

fn append_launch_ack_event(
    state: &mut CoreState,
    task_id: &Id,
    binding: &runner::IssuedRunnerBinding,
) -> Result<(), AnyError> {
    let task_binding = serde_json::json!({"task_id":task_id,"action_id":binding.action_id,"assignment_id":binding.assignment_id,"run_revision":binding.run_revision});
    state.append(
        EventKind("background:launch-ack".to_owned()),
        vec![
            Ref(task_id.0.clone()),
            Ref(binding.action_id.0.clone()),
            Ref(binding.assignment_id.0.clone()),
            Ref(binding.run_revision.to_string()),
            Ref(format!("task-binding:{task_binding}")),
            launch_ack_ref(binding),
        ],
    )
}

fn append_launch_failure_event(
    state: &mut CoreState,
    diagnostic: &str,
    binding: &runner::IssuedRunnerBinding,
) -> Result<(), AnyError> {
    state.append(
        EventKind("background:launch-failed".to_owned()),
        vec![
            Ref(binding.action_id.0.clone()),
            Ref(binding.assignment_id.0.clone()),
            Ref(binding.run_revision.to_string()),
            Ref(format!("diagnostic:{}", bounded_ref_detail(diagnostic))),
            launch_failure_ref(binding),
        ],
    )
}

fn launch_ack_ref(binding: &runner::IssuedRunnerBinding) -> Ref {
    Ref(format!(
        "launch-ack:{}:{}:{}",
        binding.action_id.0, binding.assignment_id.0, binding.run_revision
    ))
}

fn launch_failure_ref(binding: &runner::IssuedRunnerBinding) -> Ref {
    Ref(format!(
        "launch-failed:{}:{}:{}",
        binding.action_id.0, binding.assignment_id.0, binding.run_revision
    ))
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

fn validate_delivery_assignment_binding(
    spec: &kernel::generated::AgentRunSpec,
    binding: &runner::IssuedRunnerBinding,
) -> Result<runner::DeliveryAssignmentArtifact, String> {
    let binding_assignment_path = binding
        .assignment_path
        .as_deref()
        .ok_or_else(|| "delivery binding missing assignment_path".to_owned())?;
    let binding_assignment_digest = binding
        .assignment_digest
        .as_deref()
        .ok_or_else(|| "delivery binding missing assignment_digest".to_owned())?;
    if spec.assignment_path.as_ref().map(|path| path.0.as_str()) != Some(binding_assignment_path)
        || spec
            .assignment_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != Some(binding_assignment_digest)
    {
        return Err("delivery spec assignment binding drift".to_owned());
    }
    let bytes = runner::read_bounded_file(
        Path::new(binding_assignment_path),
        runner::DELIVERY_ASSIGNMENT_MAX_BYTES,
    )
    .map_err(|error| error.to_string())?;
    if sha256_hex_local(&bytes) != binding_assignment_digest {
        return Err("delivery assignment digest drift".to_owned());
    }
    let artifact: runner::DeliveryAssignmentArtifact = serde_json::from_slice(&bytes)
        .map_err(|error| format!("delivery assignment json:{error}"))?;
    if artifact.schema != "autopilot.delivery_assignment.v3"
        || artifact.workstream != binding.workstream
        || artifact.assignment_id != binding.assignment_id
        || Some(&artifact.lane_id) != binding.lane_id.as_ref()
        || Some(artifact.attempt) != binding.attempt
        || Some(&artifact.base_commit) != binding.base_commit.as_ref()
        || Some(artifact.worktree.as_str()) != binding.worktree.as_deref()
        || artifact.ordered_units.is_empty()
    {
        return Err("delivery assignment artifact identity drift".to_owned());
    }
    validate_delivery_artifact_units(&artifact.ordered_units)?;
    runner::validate_approved_command_bindings(&artifact)?;
    Ok(artifact)
}

fn validate_delivery_artifact_units(units: &[ApprovedUnit]) -> Result<(), String> {
    if units.is_empty() {
        return Err("delivery assignment has no ordered units".to_owned());
    }
    let mut lane_ids = BTreeSet::new();
    for unit in units {
        if !lane_ids.insert(unit.id.clone()) {
            return Err(format!("delivery assignment duplicate unit {}", unit.id.0));
        }
    }
    let mut previous = BTreeSet::new();
    for unit in units {
        if unit.kind != kernel::generated::PlanUnitKind::Implementation
            || unit.objective.trim().is_empty()
            || unit.criteria.is_empty()
            || unit.criterion_text.is_empty()
            || unit.files.is_empty()
            || unit.commands.is_empty()
        {
            return Err(format!("delivery assignment unit {} incomplete", unit.id.0));
        }
        let mut file_paths = BTreeSet::new();
        if unit.files.iter().any(|path| {
            !crate::allocation::approved_path_is_safe(path) || !file_paths.insert(path.0.as_str())
        }) {
            return Err(format!(
                "delivery assignment unit {} has unsafe or duplicate files",
                unit.id.0
            ));
        }
        let criterion_ids = unit
            .criterion_text
            .iter()
            .map(|criterion| criterion.id.clone())
            .collect::<Vec<_>>();
        if criterion_ids != unit.criteria {
            return Err(format!(
                "delivery assignment unit {} criteria/criterion_text drift",
                unit.id.0
            ));
        }
        let mut seen_criteria = BTreeSet::new();
        for criterion in &unit.criterion_text {
            if criterion.text.trim().is_empty() || !seen_criteria.insert(criterion.id.clone()) {
                return Err(format!(
                    "delivery assignment unit {} malformed criterion {}",
                    unit.id.0, criterion.id.0
                ));
            }
        }
        for dep in &unit.dependencies {
            if dep == &unit.id {
                return Err(format!(
                    "delivery assignment unit {} self dependency",
                    unit.id.0
                ));
            }
            if lane_ids.contains(dep) && !previous.contains(dep) {
                return Err(format!(
                    "delivery assignment unit {} precedes dependency {}",
                    unit.id.0, dep.0
                ));
            }
        }
        for command in &unit.commands {
            crate::allocation::validate_plan_unit_command_effect_authority(command).map_err(
                |error| {
                    format!(
                        "delivery assignment unit {} malformed command authority: {error}",
                        unit.id.0
                    )
                },
            )?;
        }
        crate::allocation::validate_plan_unit_package_checks(
            &unit.package_checks,
            unit.criteria.len(),
        )
        .map_err(|error| {
            format!(
                "delivery assignment unit {} malformed package-check authority: {error}",
                unit.id.0
            )
        })?;
        previous.insert(unit.id.clone());
    }
    Ok(())
}

struct ValidatedDeliveryFacts {
    assignment: runner::DeliveryAssignmentArtifact,
    denial_ledger: runner::child::DeliveryPolicyDenialLedger,
    command_executions: Vec<runner::VerifiedCommandExecution>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeliveryToolAudit {
    schema: String,
    tool_call_id: String,
    profile_id: String,
    tool_name: String,
    boundary_id: String,
    result_contract: String,
    schema_digest: String,
    binding: String,
    submission_digest: String,
    delivery_policy: DeliveryToolAuditPolicy,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeliveryToolAuditPolicy {
    version: String,
    assignment_path: String,
    assignment_digest: String,
    worktree: String,
    cwd: String,
    policy_digest: String,
    active_overrides: Vec<String>,
    denials: runner::child::DeliveryPolicyDenialLedger,
    command_executions: runner::child::ApprovedCommandExecutionLedger,
}

fn validate_delivery_result_v2(
    result: &kernel::generated::DeliveryResultV2,
    binding: &runner::IssuedRunnerBinding,
) -> Result<ValidatedDeliveryFacts, String> {
    if result.schema.0 != "autopilot.delivery_result.v2"
        || result.action_id != binding.action_id
        || result.assignment_id != binding.assignment_id
        || result.run_revision != binding.run_revision
        || result.workstream != binding.workstream
        || result.role_id != binding.role_id
        || result.mode != binding.mode
        || Some(&result.lane_id) != binding.lane_id.as_ref()
        || Some(result.attempt) != binding.attempt
        || Some(&result.base_commit) != binding.base_commit.as_ref()
        || Some(result.worktree.0.as_str()) != binding.worktree.as_deref()
        || result.prompt_path.0 != binding.prompt_path
        || result.prompt_digest.0 != binding.prompt_digest
        || result.spec_path.0 != binding.spec_path
        || result.spec_digest.0 != binding.spec_digest
        || result.carrier_path.0 != binding.carrier_path
        || result.boundary_id != binding.boundary_id
        || result.boundary_digest.0 != binding.boundary_digest
        || result.result_contract != binding.result_contract
        || result.result_contract_digest.0 != binding.result_contract_digest
        || result.settings_digest.0 != binding.settings_digest
        || result.context_digest.0 != binding.context_digest
        || result.skills_digest.0 != binding.skills_digest
        || result.subscription_digest.0 != binding.subscription_digest
    {
        return Err("package-bound delivery identity drift".to_owned());
    }
    // The runner spec under `binding.spec_path` is transient: it lives inside the
    // child-writable worktree and is gone by acceptance time. `spec_path` is
    // retained for forensics only and MUST NEVER be read during validation --
    // reading it followed symlinks, could block forever on a FIFO, was
    // unbounded, and bound the carrier to whatever attempt last wrote that path
    // rather than to this carrier's own bytes.
    //
    // Integrity comes from the EXPECTED value being parent-held:
    // `binding.spec_digest` is computed by the parent at dispatch. Hashing
    // carrier-transported bytes against it is the same construction as
    // signature verification -- untrusted carrier, trusted expectation.
    // This is a dispatch-binding receipt, NOT proof the child executed the spec.
    let spec_bytes = result.spec_bytes.0.as_bytes();
    if spec_bytes.len() > MAX_CARRIER_SPEC_BYTES {
        return Err(format!(
            "delivery spec receipt oversized: {} bytes exceeds {MAX_CARRIER_SPEC_BYTES}",
            spec_bytes.len()
        ));
    }
    if sha256_hex_local(spec_bytes) != binding.spec_digest {
        return Err("delivery spec receipt mismatch".to_owned());
    }
    let spec: kernel::generated::AgentRunSpec =
        serde_json::from_slice(spec_bytes).map_err(|error| error.to_string())?;
    let assignment = validate_delivery_assignment_binding(&spec, binding)?;
    runner::admit_delivery_submission_with_assignment(
        &result.submission,
        &assignment,
        binding.required_focused_evidence as usize,
    )?;
    let profile = runner::terminal_profile_for(
        &binding.role_id.0,
        &binding.boundary_id.0,
        &binding.result_contract.0,
    )
    .map_err(|error| error.to_string())?;
    if result.terminal_profile_id != profile.0
        || result.tool_name.0 != profile.1
        || result.tool_schema_digest.0 != profile.4
        || result.carrier_binding.0 != runner::child::carrier_binding(&spec)
        || result.runtime_extension_digest.0 != kernel::generated::CHILD_ADDON_DIGEST
    {
        return Err("delivery terminal profile provenance drift".to_owned());
    }
    let expected_audit = PathBuf::from(&binding.carrier_path).with_extension("tool-audit.json");
    if result.tool_audit_ref.0 != expected_audit.display().to_string() {
        return Err("delivery tool audit path drift".to_owned());
    }
    let audit = runner::read_bounded_file(&expected_audit, MAX_TOOL_AUDIT_BYTES)
        .map_err(|error| error.to_string())?;
    if sha256_hex_local(&audit) != result.tool_audit_digest.0 {
        return Err("delivery tool audit digest drift".to_owned());
    }
    let (denial_ledger, command_execution_ledger) =
        validate_delivery_tool_audit_policy(&audit, &spec, result)?;
    let command_executions = validate_delivery_command_executions(
        &assignment,
        &command_execution_ledger,
        &result.submission,
        Path::new(&result.worktree.0),
    )?;
    let submission = serde_json::to_vec(
        &serde_json::to_value(&result.submission).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if sha256_hex_local(&submission) != result.submission_digest.0 {
        return Err("delivery submission digest drift".to_owned());
    }
    Ok(ValidatedDeliveryFacts {
        assignment,
        denial_ledger,
        command_executions,
    })
}

fn validate_delivery_tool_audit_policy(
    audit: &[u8],
    spec: &kernel::generated::AgentRunSpec,
    result: &kernel::generated::DeliveryResultV2,
) -> Result<
    (
        runner::child::DeliveryPolicyDenialLedger,
        runner::child::ApprovedCommandExecutionLedger,
    ),
    String,
> {
    let audit: DeliveryToolAudit = serde_json::from_slice(audit)
        .map_err(|error| format!("delivery tool audit shape:{error}"))?;
    let policy = audit.delivery_policy;
    let assignment_path = spec
        .assignment_path
        .as_ref()
        .ok_or_else(|| "delivery audit spec missing assignment_path".to_owned())?;
    let assignment_digest = spec
        .assignment_digest
        .as_ref()
        .ok_or_else(|| "delivery audit spec missing assignment_digest".to_owned())?;
    let worktree = spec
        .worktree
        .as_ref()
        .ok_or_else(|| "delivery audit spec missing worktree".to_owned())?;
    let expected_policy_digest = runner::delivery_policy_digest(
        &assignment_path.0,
        &assignment_digest.0,
        &worktree.0,
        &spec.cwd.0,
    );
    if audit.schema != "autopilot.tool_audit.v2"
        || audit.tool_call_id != result.tool_call_id
        || audit.profile_id != result.terminal_profile_id
        || audit.tool_name != result.tool_name.0
        || audit.boundary_id != result.boundary_id.0
        || audit.result_contract != result.result_contract.0
        || audit.schema_digest != result.tool_schema_digest.0
        || audit.binding != result.carrier_binding.0
        || audit.submission_digest != result.submission_digest.0
        || policy.version != runner::DELIVERY_POLICY_VERSION
        || policy.assignment_path != assignment_path.0
        || policy.assignment_digest != assignment_digest.0
        || policy.worktree != worktree.0
        || policy.cwd != spec.cwd.0
        || policy.policy_digest != expected_policy_digest
        || policy.active_overrides != [runner::APPROVED_COMMAND_TOOL, "edit", "write"]
    {
        return Err("delivery tool audit policy authority drift".to_owned());
    }
    runner::child::validate_delivery_policy_denial_ledger(&policy.denials)?;
    runner::child::validate_approved_command_execution_ledger(&policy.command_executions)?;
    Ok((policy.denials, policy.command_executions))
}

fn validate_delivery_command_executions(
    assignment: &runner::DeliveryAssignmentArtifact,
    ledger: &runner::child::ApprovedCommandExecutionLedger,
    submission: &kernel::generated::DeliverySubmissionV2,
    worktree: &Path,
) -> Result<Vec<runner::VerifiedCommandExecution>, String> {
    runner::validate_approved_command_bindings(assignment)?;
    let bindings = assignment
        .approved_commands
        .iter()
        .map(|binding| (&binding.command_id, binding))
        .collect::<BTreeMap<_, _>>();
    for execution in &ledger.entries {
        let binding = bindings
            .get(&execution.command_id)
            .ok_or_else(|| "approved command execution names unknown command".to_owned())?;
        if execution.command_digest != binding.command_digest {
            return Err("approved command execution digest drift".to_owned());
        }
    }
    if runner::delivery_submission_outcome(submission) == runner::DeliverySubmissionOutcome::Blocked
    {
        return Ok(Vec::new());
    }
    if ledger.overflowed {
        return Err("approved command execution ledger overflowed".to_owned());
    }
    let final_snapshot =
        runner::delivery_scope_snapshot_digest(worktree, &assignment.ordered_units)
            .map_err(|error| format!("delivery final scope snapshot failed:{error:?}"))?;
    let mut verified = Vec::new();
    for binding in &assignment.approved_commands {
        let execution = ledger
            .entries
            .iter()
            .rev()
            .find(|execution| {
                execution.command_id == binding.command_id
                    && execution.outcome
                        == runner::child::ApprovedCommandExecutionOutcome::Succeeded
                    && execution.scope_snapshot_digest == final_snapshot
            })
            .ok_or_else(|| {
                format!(
                    "approved command {} lacks success on final source snapshot",
                    binding.command_id.0
                )
            })?;
        verified.push(runner::VerifiedCommandExecution {
            execution_id: execution.execution_id.clone(),
            command_id: execution.command_id.clone(),
            command_digest: execution.command_digest.clone(),
            result_digest: execution.result_digest.clone(),
            scope_snapshot_digest: execution.scope_snapshot_digest.clone(),
        });
    }
    Ok(verified)
}

fn delivery_v1_projection(result: &kernel::generated::DeliveryResultV2) -> DeliveryResult {
    DeliveryResult {
        assignment_id: result.assignment_id.clone(),
        role_id: result.role_id.clone(),
        mode: result.mode.clone(),
        run_revision: result.run_revision,
        lane_id: result.lane_id.clone(),
        attempt: result.attempt,
        base_commit: result.base_commit.clone(),
        worktree: result.worktree.clone(),
        action_id: Some(result.action_id.clone()),
        prompt_path: Some(result.prompt_path.clone()),
        prompt_digest: Some(result.prompt_digest.clone()),
        spec_path: Some(result.spec_path.clone()),
        spec_digest: Some(result.spec_digest.clone()),
        carrier_path: Some(result.carrier_path.clone()),
        boundary_digest: Some(result.boundary_digest.clone()),
        result_contract_digest: Some(result.result_contract_digest.clone()),
        settings_digest: Some(result.settings_digest.clone()),
        context_digest: Some(result.context_digest.clone()),
        skills_digest: Some(result.skills_digest.clone()),
        subscription_digest: Some(result.subscription_digest.clone()),
        package_commit: None,
        package_tree: None,
        actual_changed_paths: result.submission.actual_changed_paths.clone(),
        execution_audit_ref: result.submission.execution_audit_ref.clone(),
        focused_evidence_refs: result.submission.focused_evidence_refs.clone(),
        terminal_status: match &result.submission.terminal_status {
            kernel::generated::DeliveryOutcome::Succeeded => {
                kernel::generated::DeliveryTerminalStatus("succeeded".to_owned())
            }
            kernel::generated::DeliveryOutcome::Blocked => {
                kernel::generated::DeliveryTerminalStatus("blocked".to_owned())
            }
        },
        hard_boundary_violations: result.submission.hard_boundary_violations.clone(),
    }
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
    match advance_lifecycle_if_ready(
        &request.workstream,
        Some(&request),
        ClosureTrigger::OperatorClose,
        state,
    )? {
        Some(status) => done(id, status),
        None => done(
            id,
            rejection(
                "lifecycle-close",
                &format!(
                    "CloseNotReady:workstream={};run={};expected_revision={};expected_event_tip={};expected_tip={};expected_tree={};expected_final_digest={}",
                    request.workstream,
                    request.run_id,
                    request.expected_revision,
                    request.expected_event_tip,
                    request.expected_tip,
                    request.expected_tree,
                    request.expected_final_digest
                ),
            ),
        ),
    }
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleState {
    Executing,
    ExecutionComplete,
    Finalizing,
    ReadyToPublish,
    Publishing,
    Closed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClosureMode {
    Automatic,
    OperatorRatified,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClosureTrigger {
    RunCommand,
    IntegrationComplete,
    OperatorClose,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinalSnapshot {
    pub workstream: String,
    pub run_id: String,
    pub tip: String,
    pub tree: String,
    pub revision: u64,
    pub event_tip: String,
    pub required_lanes: Vec<String>,
    pub mode: ClosureMode,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinalEvidence {
    pub run_id: String,
    pub tip: String,
    pub final_commands_pass: bool,
    pub full_suite_pass: bool,
    pub final_validator_pass: bool,
    pub digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QualifiedPublication {
    pub workstream: String,
    pub run_id: String,
    pub tip: String,
    pub tree: String,
    pub result_ref: String,
    pub gate_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PublicationPrepared {
    pub schema: String,
    pub run_id: String,
    pub tip: String,
    pub result_ref: String,
    pub gate_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct PublicationClosed {
    schema: String,
    run_id: String,
    tip: String,
    result_ref: String,
    gate_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResultRef {
    pub name: String,
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
fn spawn_wave(id: u64, actions: Vec<BackgroundAction>) -> Result<SeamEnvelope, AnyError> {
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "spawn-wave".to_owned(),
        payload: serde_json::to_value(CoreToHostSpawnWavePayload { actions })?,
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

fn bounded_ref_detail(detail: &str) -> String {
    let single_line = detail.replace(['\n', '\r'], " ");
    let mut chars = single_line.chars();
    let bounded = chars.by_ref().take(159).collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}…")
    } else {
        bounded
    }
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
            fixers: active_recovery_engineers(state) as u32,
            deterministic_jobs: 0,
            queued_candidates: queued_candidates(state) as u32,
        },
        observations: Vec::new(),
        actions: vec![action.clone()],
        next_watchdog_at: kernel::generated::Nullable(None),
    });
    let mut refs = control_refs(
        state,
        trigger,
        &policy,
        &frame,
        std::slice::from_ref(&action),
    )?;
    refs.extend(record_context_prompt_for_action(state, &action));
    if let Some(watchdog) = arm_watchdog_if_needed(state, action.run_revision)? {
        refs.push(Ref(format!("watchdog:armed:{}", watchdog.action_id.0)));
        refs.push(action_ref(&watchdog)?);
    }
    state.append(EventKind("control:frame".to_owned()), refs)?;
    spawn(id, action)
}

fn controlled_spawn_wave(
    id: u64,
    actions: Vec<BackgroundAction>,
    state: &mut CoreState,
    trigger: &str,
) -> Result<SeamEnvelope, AnyError> {
    validate_spawn_wave_actions(&actions)?;
    for action in &actions {
        crate::control::admit_exact_bg_run((action, &action.bg_run))
            .map_err(|error| format!("control:bg-run:{}", error.actual()))?;
    }
    let policy = crate::control::ControlPolicy::package()
        .map_err(|error| format!("control:policy:{error:?}"))?;
    let ordered_ids = actions
        .iter()
        .map(|action| action.action_id.0.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let frame = crate::control::ControlFrameDocument::build(crate::control::FrameInput {
        frame_id: kernel::generated::Uuidv7(format!(
            "control-frame-{}-planning-wave-{}",
            state.state.revision + 1,
            sha256_hex_local(ordered_ids.as_bytes())
        )),
        run_id: kernel::generated::Uuidv7(format!("run-{}", actions[0].run_revision)),
        run_revision: actions[0].run_revision,
        trigger_kind: kernel::generated::TriggerKind(trigger.to_owned()),
        trigger_refs: actions
            .iter()
            .map(|action| Ref(action.action_id.0.clone()))
            .collect(),
        counts: kernel::generated::ControlFrameCounts {
            implementers: active_implementers(state) as u32,
            validators: active_validators(state) as u32,
            fixers: active_recovery_engineers(state) as u32,
            deterministic_jobs: 0,
            queued_candidates: queued_candidates(state) as u32,
        },
        observations: Vec::new(),
        actions: actions.clone(),
        next_watchdog_at: kernel::generated::Nullable(None),
    });
    let mut refs = control_refs(state, trigger, &policy, &frame, &actions)?;
    for action in &actions {
        refs.extend(record_context_prompt_for_action(state, action));
    }
    state.append(EventKind("control:frame".to_owned()), refs)?;
    spawn_wave(id, actions)
}

fn validate_spawn_wave_actions(actions: &[BackgroundAction]) -> Result<(), AnyError> {
    if actions.is_empty() {
        return Err("control:spawn-wave:empty-actions".into());
    }
    if actions.len() > 64 {
        return Err(format!("control:spawn-wave:too-many-actions:{}", actions.len()).into());
    }
    let mut action_ids = BTreeSet::new();
    let mut assignment_ids = BTreeSet::new();
    let run_revision = actions[0].run_revision;
    for action in actions {
        if !action_ids.insert(action.action_id.0.clone()) {
            return Err(
                format!("control:spawn-wave:duplicate-action:{}", action.action_id.0).into(),
            );
        }
        if !assignment_ids.insert(action.assignment_id.0.clone()) {
            return Err(format!(
                "control:spawn-wave:duplicate-assignment:{}",
                action.assignment_id.0
            )
            .into());
        }
        if action.run_revision != run_revision {
            return Err("control:spawn-wave:mixed-run-revisions".into());
        }
    }
    Ok(())
}

fn control_refs(
    state: &CoreState,
    trigger: &str,
    policy: &crate::control::ControlPolicy,
    frame: &crate::control::ControlFrameDocument,
    actions: &[BackgroundAction],
) -> Result<Vec<Ref>, AnyError> {
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
    ];
    for action in actions {
        refs.push(Ref(action.action_id.0.clone()));
        refs.push(action_ref(action)?);
    }
    refs.push(Ref(format!(
        "control:revision:{}",
        state.state.revision + 1
    )));
    Ok(refs)
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
    issue: runner::IssuedRunnerAction,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
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

fn validate_validation_result_v2(
    result: &kernel::generated::ValidationResultV2,
    binding: &runner::IssuedRunnerBinding,
) -> Result<(), String> {
    if result.schema.0 != "autopilot.validation_result.v2"
        || result.action_id != binding.action_id
        || result.assignment_id != binding.assignment_id
        || result.run_revision != binding.run_revision
        || result.workstream != binding.workstream
        || result.role_id != binding.role_id
        || result.mode != binding.mode
        || result.prompt_path.0 != binding.prompt_path
        || result.prompt_digest.0 != binding.prompt_digest
        || result.spec_path.0 != binding.spec_path
        || result.spec_digest.0 != binding.spec_digest
        || result.carrier_path.0 != binding.carrier_path
        || result.boundary_id != binding.boundary_id
        || result.boundary_digest.0 != binding.boundary_digest
        || result.result_contract != binding.result_contract
        || result.result_contract_digest.0 != binding.result_contract_digest
        || result.settings_digest.0 != binding.settings_digest
        || result.skills_digest.0 != binding.skills_digest
        || result.subscription_digest.0 != binding.subscription_digest
    {
        return Err("package-bound validation identity drift".to_owned());
    }
    // See validate_delivery_result_v2: `spec_path` is forensics-only and must
    // never be read here; the parent-held `binding.spec_digest` is the trusted
    // expectation this receipt is compared against.
    let spec_bytes = result.spec_bytes.0.as_bytes();
    if spec_bytes.len() > MAX_CARRIER_SPEC_BYTES {
        return Err(format!(
            "validation spec receipt oversized: {} bytes exceeds {MAX_CARRIER_SPEC_BYTES}",
            spec_bytes.len()
        ));
    }
    if sha256_hex_local(spec_bytes) != binding.spec_digest {
        return Err("validation spec receipt mismatch".to_owned());
    }
    let spec: kernel::generated::AgentRunSpec =
        serde_json::from_slice(spec_bytes).map_err(|error| error.to_string())?;
    if spec.assignment_path.as_ref() != Some(&result.assignment_path)
        || spec.assignment_digest.as_ref() != Some(&result.assignment_digest)
        || spec.context_manifest_path.as_ref() != Some(&result.context_manifest_path)
        || spec.context_manifest_digest.as_ref() != Some(&result.context_manifest_digest)
        || spec.validation_id.as_ref() != Some(&result.validation_id)
        || spec.validation_attempt != Some(result.validation_attempt)
        || spec.semantic_round != Some(result.semantic_round)
        || spec.producer_assignment_ids.as_ref() != Some(&result.producer_assignment_ids)
    {
        return Err("validation carrier artifact binding drift".to_owned());
    }
    let profile = runner::terminal_profile_for(
        &binding.role_id.0,
        &binding.boundary_id.0,
        &binding.result_contract.0,
    )
    .map_err(|error| error.to_string())?;
    if result.terminal_profile_id != profile.0
        || result.tool_name.0 != profile.1
        || result.tool_schema_digest.0 != profile.4
        || result.carrier_binding.0 != runner::child::carrier_binding(&spec)
        || result.runtime_extension_digest.0 != kernel::generated::CHILD_ADDON_DIGEST
    {
        return Err("validation terminal profile provenance drift".to_owned());
    }
    let assignment_bytes = runner::read_bounded_file(
        Path::new(&result.assignment_path.0),
        MAX_VALIDATION_BOUND_ARTIFACT_BYTES,
    )
    .map_err(|error| error.to_string())?;
    if sha256_hex_local(&assignment_bytes) != result.assignment_digest.0 {
        return Err("validation assignment digest drift".to_owned());
    }
    let assignment: kernel::generated::ValidationAssignmentV2 =
        serde_json::from_slice(&assignment_bytes).map_err(|error| error.to_string())?;
    if assignment.validation_id != result.validation_id
        || assignment.validation_key != result.validation_key
        || assignment.validation_attempt != result.validation_attempt
        || assignment.semantic_round != result.semantic_round
        || assignment.producer_assignment_ids != result.producer_assignment_ids
        || assignment.exact_commit != result.exact_commit
        || assignment.exact_tree != result.exact_tree
        || result.submission.validation_id != result.validation_id
        || result.submission.assignment_id != result.assignment_id
        || result.submission.exact_commit != result.exact_commit
        || result.submission.exact_tree != result.exact_tree
    {
        return Err("validation assignment/submission identity drift".to_owned());
    }
    let context_bytes = runner::read_bounded_file(
        Path::new(&result.context_manifest_path.0),
        MAX_VALIDATION_BOUND_ARTIFACT_BYTES,
    )
    .map_err(|error| error.to_string())?;
    if sha256_hex_local(&context_bytes) != result.context_manifest_digest.0 {
        return Err("validation context digest drift".to_owned());
    }
    let context: kernel::generated::ValidationContextV2 = serde_json::from_slice(&context_bytes)
        .map_err(|error| format!("validation context json:{error}"))?;
    runner::child::admit_validation_submission_with_authority(
        &result.submission,
        &assignment,
        &context,
    )
    .map_err(|error| format!("validation submission authority:{error}"))?;
    let expected_audit = PathBuf::from(&binding.carrier_path).with_extension("tool-audit.json");
    if result.tool_audit_ref.0 != expected_audit.display().to_string() {
        return Err("validation tool audit path drift".to_owned());
    }
    let audit = runner::read_bounded_file(&expected_audit, MAX_TOOL_AUDIT_BYTES)
        .map_err(|error| error.to_string())?;
    if sha256_hex_local(&audit) != result.tool_audit_digest.0 {
        return Err("validation tool audit digest drift".to_owned());
    }
    let submission = serde_json::to_vec(
        &serde_json::to_value(&result.submission).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if sha256_hex_local(&submission) != result.submission_digest.0 {
        return Err("validation submission digest drift".to_owned());
    }
    Ok(())
}

enum ReadValidationResult {
    V2(kernel::generated::ValidationResultV2),
    V3(kernel::generated::ValidationResultV3),
}

fn validate_validation_result_v3(
    result: &kernel::generated::ValidationResultV3,
    binding: &runner::IssuedRunnerBinding,
) -> Result<(), String> {
    let binding_assignment_path = binding
        .assignment_path
        .as_deref()
        .ok_or_else(|| "missing v3 binding assignment path".to_owned())?;
    let binding_assignment_digest = binding
        .assignment_digest
        .as_deref()
        .ok_or_else(|| "missing v3 binding assignment digest".to_owned())?;
    if result.schema.0 != "autopilot.validation_result.v3"
        || result.action_id != binding.action_id
        || result.assignment_id != binding.assignment_id
        || result.run_revision != binding.run_revision
        || result.workstream != binding.workstream
        || result.role_id != binding.role_id
        || result.mode != binding.mode
        || result.prompt_path.0 != binding.prompt_path
        || result.prompt_digest.0 != binding.prompt_digest
        || result.spec_path.0 != binding.spec_path
        || result.spec_digest.0 != binding.spec_digest
        || result.carrier_path.0 != binding.carrier_path
        || result.boundary_id != binding.boundary_id
        || result.boundary_digest.0 != binding.boundary_digest
        || result.result_contract != binding.result_contract
        || result.result_contract_digest.0 != binding.result_contract_digest
        || result.settings_digest.0 != binding.settings_digest
        || result.skills_digest.0 != binding.skills_digest
        || result.subscription_digest.0 != binding.subscription_digest
        || result.assignment_path.0 != binding_assignment_path
        || result.assignment_digest.0 != binding_assignment_digest
    {
        return Err("package-bound v3 validation identity/provenance drift".to_owned());
    }
    let prompt_bytes = runner::read_bounded_file(
        Path::new(&binding.prompt_path),
        runner::child::MAX_RENDERED_PROMPT_BYTES,
    )
    .map_err(|error| format!("v3 validation prompt read: {error}"))?;
    if sha256_hex_local(&prompt_bytes) != binding.prompt_digest {
        return Err("v3 validation prompt bytes/digest drift".to_owned());
    }

    let spec_bytes = result.spec_bytes.0.as_bytes();
    if spec_bytes.len() > MAX_CARRIER_SPEC_BYTES
        || sha256_hex_local(spec_bytes) != binding.spec_digest
    {
        return Err("v3 validation spec receipt drift".to_owned());
    }
    let spec: kernel::generated::AgentRunSpec =
        serde_json::from_slice(spec_bytes).map_err(|error| error.to_string())?;
    if spec.schema.0 != "autopilot.agent_run_spec.v4"
        || spec.assignment_kind != kernel::generated::ValidationAssignmentKind::Validation
        || spec.action_id != binding.action_id
        || spec.assignment_id != binding.assignment_id
        || spec.run_revision != binding.run_revision
        || spec.workstream != binding.workstream
        || spec.role_id != binding.role_id
        || spec.mode != binding.mode
        || spec.prompt_path.0 != binding.prompt_path
        || spec.prompt_digest.0 != binding.prompt_digest
        || spec.spec_path.0 != binding.spec_path
        || spec.carrier_path.0 != binding.carrier_path
        || spec.session_id != binding.session_id
        || spec.boundary_id != binding.boundary_id
        || spec.boundary_digest.0 != binding.boundary_digest
        || spec.result_contract != binding.result_contract
        || spec.result_contract_digest.0 != binding.result_contract_digest
        || spec.settings_digest.0 != binding.settings_digest
        || spec.context_digest.0 != binding.context_digest
        || spec.skills_digest.0 != binding.skills_digest
        || spec.subscription_digest.0 != binding.subscription_digest
        || spec.assignment_path.as_ref() != Some(&result.assignment_path)
        || spec.assignment_path.as_ref().map(|path| path.0.as_str())
            != Some(binding_assignment_path)
        || spec.assignment_digest.as_ref() != Some(&result.assignment_digest)
        || spec
            .assignment_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != Some(binding_assignment_digest)
        || spec.context_manifest_path.as_ref() != Some(&result.context_manifest_path)
        || spec.context_manifest_digest.as_ref() != Some(&result.context_manifest_digest)
        || spec.validation_id.as_ref() != Some(&result.validation_id)
        || spec.validation_attempt != Some(result.validation_attempt)
        || spec.semantic_round != Some(result.semantic_round)
        || spec.producer_assignment_ids.as_ref() != Some(&result.producer_assignment_ids)
        || spec.lane_id != binding.lane_id
        || spec.attempt != binding.attempt
        || spec.base_commit != binding.base_commit
        || spec.worktree.as_ref().map(|path| path.0.as_str()) != binding.worktree.as_deref()
        || spec.required_focused_evidence != Some(binding.required_focused_evidence)
        || spec.model_submission_path.is_none()
        || spec.runtime_extension_path.is_none()
        || spec
            .runtime_extension_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != Some(kernel::generated::CHILD_ADDON_DIGEST)
        || spec.terminal_profile_id.as_deref() != Some(result.terminal_profile_id.as_str())
    {
        return Err("v3 validation spec/binding/result provenance drift".to_owned());
    }
    let context_binding_digest = sha256_hex_local(
        &serde_json::to_vec(&serde_json::json!({
            "assignment_path": spec.assignment_path,
            "assignment_digest": spec.assignment_digest,
            "context_manifest_path": spec.context_manifest_path,
            "context_manifest_digest": spec.context_manifest_digest,
            "producer_assignment_ids": spec.producer_assignment_ids,
            "validation_id": spec.validation_id,
            "validation_attempt": spec.validation_attempt,
            "semantic_round": spec.semantic_round,
        }))
        .map_err(|error| error.to_string())?,
    );
    if context_binding_digest != binding.context_digest {
        return Err("v3 validation context binding digest drift".to_owned());
    }
    let runtime = runner::role_runtime(&binding.role_id.0).map_err(|error| error.to_string())?;
    if spec.provider != runtime.provider
        || spec.model != runtime.model
        || spec.thinking.0 != runtime.thinking
        || spec.route != "subscription"
        || runtime.route != "subscription"
    {
        return Err("v3 validation subscription roster provenance drift".to_owned());
    }
    let profile = runner::terminal_profile_for(
        &binding.role_id.0,
        &binding.boundary_id.0,
        &binding.result_contract.0,
    )
    .map_err(|error| error.to_string())?;
    let resolved = runner::resolve_role_tools(&binding.role_id.0, profile.0)
        .map_err(|error| error.to_string())?;
    let active_tools = spec
        .allowed_tools
        .iter()
        .map(|tool| tool.0.clone())
        .collect::<Vec<_>>();
    let unavailable_tools = spec
        .unavailable_tools
        .as_ref()
        .map_or_else(Vec::new, |tools| {
            tools.iter().map(|tool| tool.0.clone()).collect::<Vec<_>>()
        });
    let runtime_path = spec
        .runtime_extension_path
        .as_ref()
        .ok_or_else(|| "v3 validation missing runtime add-on path".to_owned())?;
    if result.terminal_profile_id != profile.0
        || result.tool_name.0 != profile.1
        || result.tool_schema_digest.0 != profile.4
        || result.carrier_binding.0 != runner::child::carrier_binding(&spec)
        || result.runtime_extension_digest.0 != kernel::generated::CHILD_ADDON_DIGEST
        || runner::child_addon_digest_for_path(Path::new(&runtime_path.0))
            .map_err(|error| error.to_string())?
            != kernel::generated::CHILD_ADDON_DIGEST
        || active_tools != resolved.active
        || unavailable_tools != resolved.unavailable
        || result.tool_call_id.trim().is_empty()
    {
        return Err("v3 validation terminal profile/tool schema/binding drift".to_owned());
    }

    let assignment_bytes = runner::read_bounded_file(
        Path::new(&result.assignment_path.0),
        kernel::generated::VALIDATION_ASSIGNMENT_V3_MAX_BYTES,
    )
    .map_err(|error| error.to_string())?;
    if sha256_hex_local(&assignment_bytes) != result.assignment_digest.0 {
        return Err("v3 validation assignment digest drift".to_owned());
    }
    let assignment: kernel::generated::ValidationAssignmentV3 =
        serde_json::from_slice(&assignment_bytes).map_err(|error| error.to_string())?;
    if serde_json::to_vec_pretty(&assignment).map_err(|error| error.to_string())?
        != assignment_bytes
    {
        return Err("v3 validation assignment canonical-byte drift".to_owned());
    }
    let expected_key = sha256_hex_local(
        format!(
            "validation.v3\0{}\0{}\0{}",
            assignment.validation_id.0, assignment.exact_commit.0, assignment.exact_tree.0
        )
        .as_bytes(),
    );
    if assignment.schema.0 != "autopilot.validation_assignment.v3"
        || assignment.validation_id != result.validation_id
        || assignment.validation_key != result.validation_key
        || assignment.validation_attempt != result.validation_attempt
        || assignment.semantic_round != result.semantic_round
        || assignment.producer_assignment_ids != result.producer_assignment_ids
        || assignment.exact_commit != result.exact_commit
        || assignment.exact_tree != result.exact_tree
        || assignment.action_id != result.action_id
        || assignment.assignment_id != result.assignment_id
        || assignment.workstream != result.workstream
        || assignment.run_revision != result.run_revision
        || assignment.role_id != result.role_id
        || assignment.mode != result.mode
        || assignment.context_path != result.context_manifest_path
        || assignment.context_digest != result.context_manifest_digest
        || assignment.authority_path != result.authority_path
        || assignment.authority_digest != result.authority_digest
        || assignment.candidate_root.0 != spec.cwd.0
        || assignment.base_commit.0 != spec.base_commit.as_ref().map_or("", |sha| &sha.0)
        || assignment.validation_key.0 != expected_key
        || assignment.max_value_attempts != 3
    {
        return Err("v3 validation assignment/result/spec identity drift".to_owned());
    }

    let expectation = runner::validation_authority::ValidationAuthorityExpectation {
        validation_id: &assignment.validation_id,
        assignment_id: &assignment.assignment_id,
        base_commit: &assignment.base_commit,
        exact_commit: &assignment.exact_commit,
        exact_tree: &assignment.exact_tree,
        candidate_root: Path::new(&spec.cwd.0),
    };
    let authority = runner::validation_authority::ValidationAuthorityIndex::load_for(
        Path::new(&result.authority_path.0),
        &result.authority_digest.0,
        &expectation,
    )
    .map_err(validation_authority_failure_text)?;

    let context_bytes = runner::read_bounded_file(
        Path::new(&result.context_manifest_path.0),
        kernel::generated::VALIDATION_CONTEXT_V3_MAX_BYTES,
    )
    .map_err(|error| error.to_string())?;
    if sha256_hex_local(&context_bytes) != result.context_manifest_digest.0 {
        return Err("v3 validation context digest drift".to_owned());
    }
    let context: kernel::generated::ValidationContextV3 =
        serde_json::from_slice(&context_bytes).map_err(|error| error.to_string())?;
    if serde_json::to_vec_pretty(&context).map_err(|error| error.to_string())? != context_bytes
        || authority.context_projection() != context
    {
        return Err("v3 validation context canonical authority projection drift".to_owned());
    }

    let submission_path = spec
        .model_submission_path
        .as_ref()
        .ok_or_else(|| "v3 validation missing model submission path".to_owned())?;
    let expected_submission_path = Path::new(&result.assignment_path.0)
        .parent()
        .ok_or_else(|| "v3 assignment path has no parent".to_owned())?
        .join("model-submission.v3.json");
    if Path::new(&submission_path.0) != expected_submission_path {
        return Err("v3 model submission path drift".to_owned());
    }
    let raw_submission = runner::read_bounded_file(
        Path::new(&submission_path.0),
        kernel::generated::VALIDATION_SUBMISSION_V3_MAX_BYTES,
    )
    .map_err(|error| error.to_string())?;
    if sha256_hex_local(&raw_submission) != result.submission_digest.0 {
        return Err("v3 raw model submission digest drift".to_owned());
    }
    let raw_value: serde_json::Value =
        serde_json::from_slice(&raw_submission).map_err(|error| error.to_string())?;
    let result_submission_value =
        serde_json::to_value(&result.submission).map_err(|error| error.to_string())?;
    let canonical_raw_submission =
        serde_json::to_vec(&raw_value).map_err(|error| error.to_string())?;
    if raw_value != result_submission_value
        || raw_submission != canonical_raw_submission
        || sha256_hex_local(&canonical_raw_submission) != result.submission_digest.0
    {
        return Err("v3 raw/typed submission canonical content drift".to_owned());
    }
    let admitted = authority
        .admit_raw(&raw_value, result.validation_attempt)
        .map_err(validation_authority_failure_text)?;
    if admitted.submission != result.submission {
        return Err("v3 admitted canonical submission/result drift".to_owned());
    }
    let result_verdict_bytes =
        serde_json::to_vec(&result.verdict).map_err(|error| error.to_string())?;
    if admitted.verdict != result.verdict
        || admitted.verdict_bytes != result_verdict_bytes
        || sha256_hex_local(&admitted.verdict_bytes) != result.verdict_digest.0
    {
        return Err("v3 independently normalized verdict bytes/digest drift".to_owned());
    }

    let audit_path = PathBuf::from(&binding.carrier_path).with_extension("tool-audit.json");
    let audit_bytes = runner::read_bounded_file(&audit_path, MAX_TOOL_AUDIT_BYTES)
        .map_err(|error| error.to_string())?;
    if result.tool_audit_ref.0 != audit_path.display().to_string()
        || sha256_hex_local(&audit_bytes) != result.tool_audit_digest.0
    {
        return Err("v3 validation audit path/digest drift".to_owned());
    }
    let audit: ValidationToolAudit =
        serde_json::from_slice(&audit_bytes).map_err(|error| error.to_string())?;
    if audit.schema != "autopilot.tool_audit.v1"
        || audit.tool_call_id != result.tool_call_id
        || audit.profile_id != result.terminal_profile_id
        || audit.tool_name != result.tool_name.0
        || audit.boundary_id != result.boundary_id.0
        || audit.result_contract != result.result_contract.0
        || audit.schema_digest != result.tool_schema_digest.0
        || audit.binding != result.carrier_binding.0
        || audit.submission_digest != result.submission_digest.0
    {
        return Err("v3 validation tool-call audit content drift".to_owned());
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidationToolAudit {
    schema: String,
    tool_call_id: String,
    profile_id: String,
    tool_name: String,
    boundary_id: String,
    result_contract: String,
    schema_digest: String,
    binding: String,
    submission_digest: String,
}

fn validation_authority_failure_text(
    failure: runner::validation_authority::AdmissionFailure,
) -> String {
    match failure.canonical_bytes() {
        Ok(bytes) => String::from_utf8(bytes)
            .unwrap_or_else(|error| format!("non-UTF-8 validation diagnostic: {error}")),
        Err(error) => format!("validation diagnostic invariant failed: {error}"),
    }
}
fn read_validation_result(
    binding: &runner::IssuedRunnerBinding,
) -> Result<ReadValidationResult, AnyError> {
    let text = read_bounded_utf8(
        Path::new(&binding.carrier_path),
        MAX_TERMINAL_CARRIER_BYTES,
        "validation-carrier-read",
    )?;
    if binding.result_contract.0 == "autopilot.validation_result.v2" {
        let result: kernel::generated::ValidationResultV2 = serde_json::from_str(&text)
            .map_err(|error| format!("validation-carrier:{}:{error}", binding.carrier_path))?;
        validate_validation_result_v2(&result, binding)?;
        return Ok(ReadValidationResult::V2(result));
    }
    if binding.result_contract.0 == "autopilot.validation_result.v3" {
        let result: kernel::generated::ValidationResultV3 = serde_json::from_str(&text)
            .map_err(|error| format!("validation-carrier:{}:{error}", binding.carrier_path))?;
        validate_validation_result_v3(&result, binding)?;
        return Ok(ReadValidationResult::V3(result));
    }
    Err("unknown validation result contract".into())
}

fn validation_blockers(result: &kernel::generated::ValidationResultV2) -> Vec<Id> {
    result
        .submission
        .criterion_results
        .iter()
        .filter(|criterion| criterion.verdict != kernel::generated::CriterionVerdict::PASS)
        .map(|criterion| criterion.criterion_id.clone())
        .chain(
            result
                .submission
                .findings
                .iter()
                .filter(|finding| {
                    finding.effect == kernel::generated::FindingEffect::ForwardBlocking
                })
                .flat_map(|finding| finding.criterion_ids.clone()),
        )
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn validation_completed(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    terminal: &HostToCoreTaskCompletedPayload,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let result = read_validation_result(binding)?;
    append_terminal_event(state, terminal, binding)?;
    record_task_completion_control(state, terminal)?;
    match result {
        ReadValidationResult::V2(result) => {
            let blockers = validation_blockers(&result);
            if result.submission.outcome == kernel::generated::ValidationOutcomeV2::FORWARDREADY
                && blockers.is_empty()
            {
                integrate_validated_candidate_v2(id, binding, &result, state)
            } else if result.submission.outcome
                != kernel::generated::ValidationOutcomeV2::FORWARDREADY
                && !blockers.is_empty()
            {
                repair_needed(id, binding, &result, blockers, state)
            } else {
                done(
                    id,
                    rejection("validation-verdict", "outcome/blocker incoherence"),
                )
            }
        }
        ReadValidationResult::V3(result) => validation_completed_v3(id, binding, &result, state),
    }
}

fn validation_blockers_v3(result: &kernel::generated::ValidationResultV3) -> Vec<Id> {
    result
        .verdict
        .criterion_results
        .iter()
        .filter(|criterion| criterion.verdict != kernel::generated::CriterionVerdict::PASS)
        .map(|criterion| criterion.criterion_id.clone())
        .chain(
            result
                .verdict
                .findings
                .iter()
                .filter(|finding| {
                    finding.effect == kernel::generated::FindingEffect::ForwardBlocking
                })
                .flat_map(|finding| finding.criterion_ids.clone()),
        )
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn validation_completed_v3(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    result: &kernel::generated::ValidationResultV3,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let blockers = validation_blockers_v3(result);
    if result.verdict.outcome == kernel::generated::ValidationOutcomeV2::FORWARDREADY
        && blockers.is_empty()
    {
        return integrate_validated_candidate_v3(id, binding, result, state);
    }
    if result.verdict.outcome != kernel::generated::ValidationOutcomeV2::FORWARDREADY
        && !blockers.is_empty()
    {
        return repair_needed_v3(id, binding, result, blockers, state);
    }
    done(
        id,
        rejection("validation-verdict", "v3 outcome/blocker incoherence"),
    )
}

fn integrate_validated_candidate_v3(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    result: &kernel::generated::ValidationResultV3,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let verdict = kernel::generated::ValidationVerdict {
        assignment_id: result.assignment_id.clone(),
        validation_scope: kernel::generated::ValidationScope("forward".to_owned()),
        exact_commit: Sha(result.exact_commit.0.clone()),
        exact_tree: Sha(result.exact_tree.0.clone()),
        forward_verdict: Some(kernel::generated::ForwardVerdict::FORWARDREADY),
        closure_verdict: None,
        criterion_results: result
            .verdict
            .criterion_results
            .iter()
            .map(|criterion| kernel::generated::CriterionResult {
                criterion_id: criterion.criterion_id.clone(),
                verdict: criterion.verdict.clone(),
                evidence_refs: criterion
                    .model_citation_refs
                    .iter()
                    .chain(&criterion.command_receipt_refs)
                    .chain(&criterion.package_check_receipt_refs)
                    .cloned()
                    .collect(),
                finding_refs: criterion
                    .finding_ids
                    .iter()
                    .map(|id| Ref(id.0.clone()))
                    .collect(),
                covered_paths: criterion.covered_paths.clone(),
                semantic_surface_ids: criterion.semantic_surface_ids.clone(),
                forward_edge_ids: criterion.forward_edge_ids.clone(),
            })
            .collect(),
        finding_refs: result
            .verdict
            .findings
            .iter()
            .map(|finding| Ref(finding.finding_id.0.clone()))
            .collect(),
    };
    integrate_validated_candidate(id, binding, &verdict, state)
}

fn repair_needed_v3(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    result: &kernel::generated::ValidationResultV3,
    blocker_ids: Vec<Id>,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let producer_id = result
        .producer_assignment_ids
        .first()
        .ok_or_else(|| "v3 validation recovery missing producer assignment".to_owned())?;
    let producer = issued_binding_for_assignment(state, producer_id)
        .ok_or_else(|| "v3 validation recovery missing producer binding".to_owned())?;
    let policy = crate::repair::SemanticRecoveryPolicy::package()?;
    if producer.role_id.0 == "recovery-engineer" || result.semantic_round > policy.max_attempts {
        state.append(
            EventKind("recovery:exhausted".to_owned()),
            vec![
                Ref(binding.assignment_id.0.clone()),
                Ref(format!("blockers={}", ids(&blocker_ids))),
                Ref("semantic-recovery-exhausted".to_owned()),
                lane_blocker_ref(binding)?,
            ],
        )?;
        return done(
            id,
            rejection(
                "recovery-exhausted",
                &format!("blockers={}", ids(&blocker_ids)),
            ),
        );
    }
    let approved_units = read_delivery_assignment_units(&producer)?;
    let findings = result
        .verdict
        .findings
        .iter()
        .filter(|finding| {
            finding.effect == kernel::generated::FindingEffect::ForwardBlocking
                && blocker_ids
                    .iter()
                    .any(|id| finding.criterion_ids.contains(id))
        })
        .collect::<Vec<_>>();
    let inadmissible_kinds = findings
        .iter()
        .filter(|finding| {
            matches!(
                finding.kind,
                kernel::generated::FindingKindV2::ContextGap
                    | kernel::generated::FindingKindV2::UnsafeBoundary
            )
        })
        .map(|finding| format!("{}:{:?}", finding.finding_id.0, finding.kind))
        .collect::<Vec<_>>();
    if findings.is_empty() || !inadmissible_kinds.is_empty() {
        let detail = if findings.is_empty() {
            "missing typed blocking finding".to_owned()
        } else {
            inadmissible_kinds.join(",")
        };
        let failure_ref = if findings
            .iter()
            .any(|finding| finding.kind == kernel::generated::FindingKindV2::UnsafeBoundary)
        {
            Ref("semantic-recovery-unsafe".to_owned())
        } else if findings
            .iter()
            .any(|finding| finding.kind == kernel::generated::FindingKindV2::ContextGap)
        {
            Ref("semantic-recovery-new-authority".to_owned())
        } else {
            Ref("semantic-recovery-inadmissible".to_owned())
        };
        state.append(
            EventKind("recovery:inadmissible".to_owned()),
            vec![
                Ref(binding.assignment_id.0.clone()),
                Ref(format!("validation-recovery-inadmissible:{detail}")),
                failure_ref,
                lane_blocker_ref(binding)?,
            ],
        )?;
        return done(id, rejection("validation-recovery-inadmissible", &detail));
    }
    let mut diagnosis_refs = vec![Ref(binding.carrier_path.clone())];
    diagnosis_refs.extend(
        findings
            .iter()
            .flat_map(|finding| finding.citation_refs.iter().cloned()),
    );
    let mut diagnosis_details = findings
        .iter()
        .map(|finding| {
            let source_locations = finding
                .source_locations
                .iter()
                .map(|location| {
                    format!(
                        "{}:{}-{}",
                        location.citation_ref.0, location.start_line, location.end_line
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "{}: {} — {}; source_locations=[{}]",
                finding.finding_id.0, finding.summary, finding.detail, source_locations
            )
        })
        .collect::<Vec<_>>();
    if diagnosis_details.is_empty() {
        diagnosis_details.push(format!("blocked criteria: {}", ids(&blocker_ids)));
    }
    let repair_mode = if findings
        .iter()
        .any(|finding| finding.kind == kernel::generated::FindingKindV2::TestDefect)
    {
        "failed-test"
    } else if findings
        .iter()
        .any(|finding| finding.kind == kernel::generated::FindingKindV2::ContractDefect)
    {
        "conflict-resolution"
    } else if findings
        .iter()
        .any(|finding| finding.kind == kernel::generated::FindingKindV2::EvidenceGap)
    {
        "closure-repair"
    } else {
        "forward-critical"
    };
    let directive = runner::RecoveryDirective {
        schema: "autopilot.recovery_directive.v1".to_owned(),
        trigger_phase: "validation".to_owned(),
        repair_mode: ModeId(repair_mode.to_owned()),
        trigger_assignment_id: binding.assignment_id.clone(),
        diagnosis_refs,
        diagnosis_ids: findings
            .iter()
            .map(|finding| finding.finding_id.clone())
            .chain(
                blocker_ids
                    .iter()
                    .map(|id| idv(&format!("criterion:{}", id.0))),
            )
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        diagnosis_details,
        original_gate: format!("validator:{}:semantic-round-1", binding.assignment_id.0),
        attempt_budget: policy.max_attempts,
    };
    let pending_ref = Ref(format!(
        "recovery-validation-pending:{}",
        binding.assignment_id.0
    ));
    if !state.state.refs.contains_key(&pending_ref) {
        state.append(
            EventKind("recovery:pending".to_owned()),
            vec![
                pending_ref,
                Ref(binding.assignment_id.0.clone()),
                Ref(producer.assignment_id.0.clone()),
            ],
        )?;
    }
    let assignment = recovery_runner_assignment(
        &producer,
        Sha(result.exact_commit.0.clone()),
        approved_units,
        directive,
        state.state.revision,
    )?;
    spawn_recovery_assignment(id, assignment, state, "validation:recovery-required")
}

fn integrate_validated_candidate_v2(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    result: &kernel::generated::ValidationResultV2,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let verdict = kernel::generated::ValidationVerdict {
        assignment_id: result.assignment_id.clone(),
        validation_scope: kernel::generated::ValidationScope("forward".to_owned()),
        exact_commit: Sha(result.exact_commit.0.clone()),
        exact_tree: Sha(result.exact_tree.0.clone()),
        forward_verdict: Some(kernel::generated::ForwardVerdict::FORWARDREADY),
        closure_verdict: None,
        criterion_results: result
            .submission
            .criterion_results
            .iter()
            .map(|criterion| kernel::generated::CriterionResult {
                criterion_id: criterion.criterion_id.clone(),
                verdict: criterion.verdict.clone(),
                evidence_refs: criterion.evidence_refs.clone(),
                finding_refs: criterion
                    .finding_ids
                    .iter()
                    .map(|id| Ref(id.0.clone()))
                    .collect(),
                covered_paths: criterion.covered_paths.clone(),
                semantic_surface_ids: criterion.semantic_surface_ids.clone(),
                forward_edge_ids: criterion.forward_edge_ids.clone(),
            })
            .collect(),
        finding_refs: result
            .submission
            .findings
            .iter()
            .map(|finding| Ref(finding.finding_id.0.clone()))
            .collect(),
    };
    integrate_validated_candidate(id, binding, &verdict, state)
}

fn integrate_validated_candidate(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    verdict: &kernel::generated::ValidationVerdict,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let workstream = &binding.workstream.0;
    let cwd = fs::canonicalize(std::env::current_dir()?)?;
    verify_run_main_stable(&cwd, workstream)?;
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
        ]
        .into_iter()
        .chain(satisfied_forward_gate_refs(
            workstream,
            binding.lane_id.as_ref(),
        )?)
        .collect::<Vec<_>>(),
    )?;
    if let Some(status) =
        advance_lifecycle_if_ready(workstream, None, ClosureTrigger::IntegrationComplete, state)?
    {
        return done(id, status);
    }
    let outcome = advance_run(id, workstream, state)?;
    advance_run_envelope(id, outcome)
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

fn issued_binding_for_assignment(
    state: &CoreState,
    assignment_id: &Id,
) -> Option<runner::IssuedRunnerBinding> {
    state
        .state
        .refs
        .keys()
        .filter_map(|reference| runner::decode_binding_ref(&reference.0))
        .filter(|binding| binding.assignment_id == *assignment_id)
        .max_by_key(|binding| binding.run_revision)
}

fn lane_blocker_ref(binding: &runner::IssuedRunnerBinding) -> Result<Ref, String> {
    binding
        .lane_id
        .as_ref()
        .map(|lane| Ref(format!("blocker:{}", lane.0)))
        .ok_or_else(|| format!("recovery binding {} missing lane", binding.assignment_id.0))
}

fn recovery_disposition_failure_ref(disposition: &kernel::generated::RecoveryDisposition) -> Ref {
    use kernel::generated::RecoveryDisposition;
    Ref(match disposition {
        RecoveryDisposition::RequiresNewAuthority => "semantic-recovery-new-authority",
        RecoveryDisposition::InfrastructureBlocked => "semantic-recovery-infrastructure",
        RecoveryDisposition::UnsafeBlocked => "semantic-recovery-unsafe",
        RecoveryDisposition::Repaired | RecoveryDisposition::NoDefect => {
            "semantic-recovery-inadmissible"
        }
    }
    .to_owned())
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum DeliveryRecoveryAdmission {
    SemanticRepairable,
    PolicyDenialRepairable,
}

impl DeliveryRecoveryAdmission {
    fn as_str(self) -> &'static str {
        match self {
            Self::SemanticRepairable => "semantic-repairable",
            Self::PolicyDenialRepairable => "policy-denial-repairable",
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct DeliveryRecoveryAssessment {
    admission: DeliveryRecoveryAdmission,
    snapshot: runner::BlockedDeliverySnapshot,
}

#[derive(Debug, Clone, Eq, PartialEq)]
enum DeliveryRecoveryDecision {
    Admit(DeliveryRecoveryAssessment),
    Inadmissible(&'static str),
    Unsafe(runner::DeliveryRejection),
}

fn assess_blocked_delivery_recovery(
    binding: &runner::IssuedRunnerBinding,
    result: &kernel::generated::DeliveryResultV2,
    facts: &ValidatedDeliveryFacts,
) -> Result<DeliveryRecoveryDecision, String> {
    use kernel::generated::DeliveryBlockerClass;
    if binding.role_id.0 == "recovery-engineer" {
        return Ok(DeliveryRecoveryDecision::Inadmissible("recovery-result"));
    }
    let admission = match result.submission.blocker_class.as_ref() {
        Some(DeliveryBlockerClass::SemanticRepairable) => {
            DeliveryRecoveryAdmission::SemanticRepairable
        }
        Some(DeliveryBlockerClass::RequiresNewAuthority) => {
            let denials = &facts.denial_ledger;
            let bounded_pre_effect_command_denials = !denials.overflowed
                && !denials.entries.is_empty()
                && denials.entries.iter().all(|entry| {
                    entry.kind == runner::child::DeliveryPolicyDenialKind::UnapprovedCommand
                        && entry.tool == runner::APPROVED_COMMAND_TOOL
                        && !entry.effected
                });
            if !bounded_pre_effect_command_denials {
                return Ok(DeliveryRecoveryDecision::Inadmissible(
                    "requires-new-authority",
                ));
            }
            DeliveryRecoveryAdmission::PolicyDenialRepairable
        }
        Some(DeliveryBlockerClass::Infrastructure) => {
            return Ok(DeliveryRecoveryDecision::Inadmissible("infrastructure"));
        }
        Some(DeliveryBlockerClass::Unsafe) => {
            return Ok(DeliveryRecoveryDecision::Inadmissible("unsafe"));
        }
        None => return Ok(DeliveryRecoveryDecision::Inadmissible("missing-class")),
    };
    let base_commit = binding
        .base_commit
        .as_ref()
        .ok_or_else(|| "delivery recovery assessment missing base commit".to_owned())?;
    let worktree = binding
        .worktree
        .as_ref()
        .ok_or_else(|| "delivery recovery assessment missing worktree".to_owned())?;
    let snapshot = match runner::inspect_blocked_delivery_snapshot(
        Path::new(worktree),
        base_commit,
        &facts.assignment.ordered_units,
    ) {
        Ok(snapshot) => snapshot,
        Err(error) => return Ok(DeliveryRecoveryDecision::Unsafe(error)),
    };
    if admission == DeliveryRecoveryAdmission::PolicyDenialRepairable
        && snapshot.in_scope_dirty_paths.is_empty()
    {
        return Ok(DeliveryRecoveryDecision::Inadmissible("no-in-scope-work"));
    }
    Ok(DeliveryRecoveryDecision::Admit(
        DeliveryRecoveryAssessment {
            admission,
            snapshot,
        },
    ))
}

fn recovery_assessment_refs(
    binding: &runner::IssuedRunnerBinding,
    assessment: &DeliveryRecoveryAssessment,
) -> [Ref; 2] {
    [
        Ref(format!(
            "recovery-admission:{}:{}",
            binding.assignment_id.0,
            assessment.admission.as_str()
        )),
        Ref(format!(
            "recovery-assessment:{}:{}",
            binding.assignment_id.0, assessment.snapshot.snapshot_digest
        )),
    ]
}

fn delivery_blocker_failure_ref(blocker: Option<&kernel::generated::DeliveryBlockerClass>) -> Ref {
    use kernel::generated::DeliveryBlockerClass;
    Ref(match blocker {
        Some(DeliveryBlockerClass::RequiresNewAuthority) => "semantic-recovery-new-authority",
        Some(DeliveryBlockerClass::Infrastructure) => "semantic-recovery-infrastructure",
        Some(DeliveryBlockerClass::Unsafe) => "semantic-recovery-unsafe",
        Some(DeliveryBlockerClass::SemanticRepairable) | None => "semantic-recovery-inadmissible",
    }
    .to_owned())
}

fn recovery_runner_assignment(
    source: &runner::IssuedRunnerBinding,
    base_commit: Sha,
    approved_units: Vec<ApprovedUnit>,
    directive: runner::RecoveryDirective,
    run_revision: u64,
) -> Result<RunnerAssignment, String> {
    let policy = crate::repair::SemanticRecoveryPolicy::package()?;
    if directive.attempt_budget != policy.max_attempts {
        return Err("recovery directive attempt budget differs from package policy".to_owned());
    }
    let lane_id = source
        .lane_id
        .clone()
        .ok_or_else(|| "recovery source binding missing lane_id".to_owned())?;
    let worktree = PathBuf::from(
        source
            .worktree
            .clone()
            .ok_or_else(|| "recovery source binding missing worktree".to_owned())?,
    );
    let assignment_id = idv(&format!("recovery-{}-a1", source.assignment_id.0));
    let session_file = PathBuf::from(format!(
        ".pi/autopilot/{}/{}.session.json",
        source.workstream.0, assignment_id.0
    ));
    Ok(RunnerAssignment {
        workstream: source.workstream.clone(),
        action_id: idv(&format!("action-{}", assignment_id.0)),
        assignment_id,
        role_id: idv("recovery-engineer"),
        mode: directive.repair_mode.clone(),
        run_revision,
        lane_id,
        attempt: 1,
        base_commit,
        worktree,
        session_file,
        roster_assignment: "package-roster/reasoning".to_owned(),
        approved_units,
        recovery: Some(directive),
    })
}

fn spawn_recovery_assignment(
    id: u64,
    assignment: RunnerAssignment,
    state: &mut CoreState,
    event_kind: &str,
) -> Result<SeamEnvelope, AnyError> {
    let directive = assignment
        .recovery
        .as_ref()
        .ok_or_else(|| "recovery spawn missing package directive".to_owned())?;
    let trigger_assignment_id = directive.trigger_assignment_id.0.clone();
    let attempt_budget = directive.attempt_budget;
    let issue = runner::delivery_issue_with_facts(
        &assignment,
        &runner::RunnerTransportFacts::from_env().map_err(|error| error.to_string())?,
    )?;
    append_runner_invocation(state, &issue.binding)?;
    state.append(
        EventKind(event_kind.to_owned()),
        vec![
            Ref("module-wired:recovery-engineer".to_owned()),
            Ref(issue.binding.assignment_id.0.clone()),
            Ref(format!("recovery-trigger:{trigger_assignment_id}")),
            Ref(format!("recovery-issued:{trigger_assignment_id}")),
            Ref(format!("recovery-attempt:1-of-{attempt_budget}")),
        ],
    )?;
    controlled_spawn(id, issue.action, state, "semantic-recovery")
}

fn issue_delivery_recovery(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    result: &kernel::generated::DeliveryResultV2,
    assessment: &DeliveryRecoveryAssessment,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let approved_units = read_delivery_assignment_units(binding)?;
    let base_commit = binding
        .base_commit
        .clone()
        .ok_or_else(|| "delivery recovery missing base commit".to_owned())?;
    let mut diagnosis_details = result.submission.hard_boundary_violations.clone();
    diagnosis_details.push(format!(
        "mechanical in-scope dirty paths: [{}]",
        assessment.snapshot.in_scope_dirty_paths.join(",")
    ));
    diagnosis_details.push(format!(
        "package recovery admission: {}; snapshot={}",
        assessment.admission.as_str(),
        assessment.snapshot.snapshot_digest
    ));
    let [admission_ref, assessment_ref] = recovery_assessment_refs(binding, assessment);
    let mut diagnosis_refs = vec![
        Ref(binding.carrier_path.clone()),
        result.submission.execution_audit_ref.clone(),
        admission_ref,
        assessment_ref,
    ];
    if assessment.admission == DeliveryRecoveryAdmission::PolicyDenialRepairable {
        diagnosis_refs.push(Ref("delivery-policy-denial-reconciliation".to_owned()));
    }
    let directive = runner::RecoveryDirective {
        schema: "autopilot.recovery_directive.v1".to_owned(),
        trigger_phase: "execution".to_owned(),
        repair_mode: ModeId("forward-critical".to_owned()),
        trigger_assignment_id: binding.assignment_id.clone(),
        diagnosis_refs,
        diagnosis_ids: vec![idv("delivery-blocked"), idv(assessment.admission.as_str())],
        diagnosis_details,
        original_gate: "autopilot.delivery_submission.v2".to_owned(),
        attempt_budget: crate::repair::SemanticRecoveryPolicy::package()?.max_attempts,
    };
    let assignment = recovery_runner_assignment(
        binding,
        base_commit,
        approved_units,
        directive,
        state.state.revision,
    )?;
    spawn_recovery_assignment(id, assignment, state, "delivery:recovery-required")
}

fn repair_needed(
    id: u64,
    binding: &runner::IssuedRunnerBinding,
    result: &kernel::generated::ValidationResultV2,
    blocker_ids: Vec<Id>,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let producer_id = result
        .producer_assignment_ids
        .first()
        .ok_or_else(|| "validation recovery missing producer assignment".to_owned())?;
    let producer = issued_binding_for_assignment(state, producer_id).ok_or_else(|| {
        format!(
            "validation recovery missing producer binding {}",
            producer_id.0
        )
    })?;
    let policy = crate::repair::SemanticRecoveryPolicy::package()?;
    if producer.role_id.0 == "recovery-engineer" || result.semantic_round > policy.max_attempts {
        state.append(
            EventKind("recovery:exhausted".to_owned()),
            vec![
                Ref(binding.assignment_id.0.clone()),
                Ref(format!("blockers={}", ids(&blocker_ids))),
                Ref("semantic-recovery-exhausted".to_owned()),
                lane_blocker_ref(binding)?,
            ],
        )?;
        return done(
            id,
            rejection(
                "recovery-exhausted",
                &format!("blockers={}", ids(&blocker_ids)),
            ),
        );
    }
    let approved_units = read_delivery_assignment_units(&producer)?;
    let findings = result
        .submission
        .findings
        .iter()
        .filter(|finding| {
            blocker_ids
                .iter()
                .any(|id| finding.criterion_ids.contains(id))
        })
        .collect::<Vec<_>>();
    let inadmissible_kinds = findings
        .iter()
        .filter(|finding| {
            matches!(
                &finding.kind,
                kernel::generated::FindingKindV2::ContextGap
                    | kernel::generated::FindingKindV2::UnsafeBoundary
            )
        })
        .map(|finding| format!("{}:{:?}", finding.finding_id.0, finding.kind))
        .collect::<Vec<_>>();
    if findings.is_empty() || !inadmissible_kinds.is_empty() {
        let detail = if findings.is_empty() {
            "missing typed blocking finding".to_owned()
        } else {
            inadmissible_kinds.join(",")
        };
        let failure_ref = if findings
            .iter()
            .any(|finding| finding.kind == kernel::generated::FindingKindV2::UnsafeBoundary)
        {
            Ref("semantic-recovery-unsafe".to_owned())
        } else if findings
            .iter()
            .any(|finding| finding.kind == kernel::generated::FindingKindV2::ContextGap)
        {
            Ref("semantic-recovery-new-authority".to_owned())
        } else {
            Ref("semantic-recovery-inadmissible".to_owned())
        };
        state.append(
            EventKind("recovery:inadmissible".to_owned()),
            vec![
                Ref(binding.assignment_id.0.clone()),
                Ref(format!("validation-recovery-inadmissible:{detail}")),
                failure_ref,
                lane_blocker_ref(binding)?,
            ],
        )?;
        return done(id, rejection("validation-recovery-inadmissible", &detail));
    }
    let mut diagnosis_refs = vec![Ref(binding.carrier_path.clone())];
    diagnosis_refs.extend(
        findings
            .iter()
            .flat_map(|finding| finding.evidence_refs.iter().cloned()),
    );
    let mut diagnosis_details = findings
        .iter()
        .map(|finding| {
            format!(
                "{}: {} — {}",
                finding.finding_id.0, finding.summary, finding.detail
            )
        })
        .collect::<Vec<_>>();
    if diagnosis_details.is_empty() {
        diagnosis_details.push(format!("blocked criteria: {}", ids(&blocker_ids)));
    }
    let repair_mode = if findings
        .iter()
        .any(|finding| finding.kind == kernel::generated::FindingKindV2::TestDefect)
    {
        "failed-test"
    } else if findings
        .iter()
        .any(|finding| finding.kind == kernel::generated::FindingKindV2::ContractDefect)
    {
        "conflict-resolution"
    } else if findings
        .iter()
        .any(|finding| finding.kind == kernel::generated::FindingKindV2::EvidenceGap)
    {
        "closure-repair"
    } else {
        "forward-critical"
    };
    let directive = runner::RecoveryDirective {
        schema: "autopilot.recovery_directive.v1".to_owned(),
        trigger_phase: "validation".to_owned(),
        repair_mode: ModeId(repair_mode.to_owned()),
        trigger_assignment_id: binding.assignment_id.clone(),
        diagnosis_refs,
        diagnosis_ids: findings
            .iter()
            .map(|finding| finding.finding_id.clone())
            .chain(
                blocker_ids
                    .iter()
                    .map(|id| idv(&format!("criterion:{}", id.0))),
            )
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        diagnosis_details,
        original_gate: format!("validator:{}:semantic-round-1", binding.assignment_id.0),
        attempt_budget: policy.max_attempts,
    };
    let pending_ref = Ref(format!(
        "recovery-validation-pending:{}",
        binding.assignment_id.0
    ));
    if !state.state.refs.contains_key(&pending_ref) {
        state.append(
            EventKind("recovery:pending".to_owned()),
            vec![
                pending_ref,
                Ref(binding.assignment_id.0.clone()),
                Ref(producer.assignment_id.0.clone()),
            ],
        )?;
    }
    let assignment = recovery_runner_assignment(
        &producer,
        Sha(result.exact_commit.0.clone()),
        approved_units,
        directive,
        state.state.revision,
    )?;
    spawn_recovery_assignment(id, assignment, state, "validation:recovery-required")
}

fn validation_issue_for_delivery(
    binding: &runner::IssuedRunnerBinding,
    accepted: &runner::AcceptedDelivery,
    command_executions: &[runner::VerifiedCommandExecution],
    run_revision: u64,
) -> Result<runner::IssuedRunnerAction, String> {
    if binding.role_id.0 == "validator" || binding.assignment_id.0.contains("validator") {
        return Err("validator cannot validate its own assignment".to_owned());
    }
    let lane_id = binding
        .lane_id
        .clone()
        .ok_or_else(|| "delivery binding missing lane_id".to_owned())?;
    let attempt = binding
        .attempt
        .ok_or_else(|| "delivery binding missing attempt".to_owned())?;
    let base_commit = binding
        .base_commit
        .clone()
        .ok_or_else(|| "delivery binding missing base_commit".to_owned())?;
    let worktree = PathBuf::from(
        binding
            .worktree
            .clone()
            .ok_or_else(|| "delivery binding missing worktree".to_owned())?,
    );
    let assignment_id = Id(format!("validator-{}", binding.assignment_id.0));
    let approved_units = read_delivery_assignment_units(binding)?;
    runner::validation_issue_v3(
        &runner::ValidationRunnerRequest {
            workstream: binding.workstream.clone(),
            action_id: Id(format!("action-{}", assignment_id.0)),
            assignment_id,
            run_revision,
            producer_assignment_ids: vec![binding.assignment_id.clone()],
            exact_commit: accepted.package_commit.0.clone(),
            exact_tree: accepted.package_tree.0.clone(),
            candidate_root: worktree.clone(),
            changed_paths: accepted.changed_paths.clone(),
            unchanged_recovery: binding.role_id.0 == "recovery-engineer"
                && accepted.changed_paths.is_empty(),
            execution_audit_ref: accepted.audit_ref.clone(),
            evidence_refs: accepted.focused_evidence_refs.clone(),
            lane_id,
            attempt,
            validation_attempt: if binding.role_id.0 == "recovery-engineer" {
                2
            } else {
                1
            },
            semantic_round: if binding.role_id.0 == "recovery-engineer" {
                2
            } else {
                1
            },
            base_commit,
            worktree,
            approved_units,
            producer_assignment_digest: binding
                .assignment_digest
                .clone()
                .ok_or_else(|| "delivery binding missing assignment_digest".to_owned())?,
            approved_command_executions: command_executions.to_vec(),
        },
        &runner::RunnerTransportFacts::from_env().map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn read_delivery_assignment_units(
    binding: &runner::IssuedRunnerBinding,
) -> Result<Vec<ApprovedUnit>, String> {
    let path = binding
        .assignment_path
        .as_ref()
        .ok_or_else(|| "delivery binding missing assignment_path".to_owned())?;
    let digest = binding
        .assignment_digest
        .as_ref()
        .ok_or_else(|| "delivery binding missing assignment_digest".to_owned())?;
    let bytes = runner::read_bounded_file(
        Path::new(path.as_str()),
        runner::DELIVERY_ASSIGNMENT_MAX_BYTES,
    )
    .map_err(|error| format!("delivery assignment read:{error}"))?;
    if sha256_hex_local(&bytes) != *digest {
        return Err("delivery assignment digest drift".to_owned());
    }
    let artifact: runner::DeliveryAssignmentArtifact = serde_json::from_slice(&bytes)
        .map_err(|error| format!("delivery assignment json:{error}"))?;
    if artifact.schema != "autopilot.delivery_assignment.v3"
        || artifact.assignment_id != binding.assignment_id
        || binding.lane_id.as_ref() != Some(&artifact.lane_id)
        || artifact.ordered_units.is_empty()
    {
        return Err("delivery assignment identity drift".to_owned());
    }
    runner::validate_approved_command_bindings(&artifact)?;
    Ok(artifact.ordered_units)
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

fn advance_lifecycle_if_ready(
    workstream: &str,
    request: Option<&ParsedCloseRequestArgs>,
    trigger: ClosureTrigger,
    state: &mut CoreState,
) -> Result<Option<String>, AnyError> {
    if let Some(prepared) = read_publication_prepared(workstream)? {
        return publish_prepared_result_ref(workstream, &prepared, state)
            .map(|result| Some(exact_close_signal(&result.name)));
    }
    if let Some(closed) = read_publication_closed(workstream)? {
        verify_result_ref(&closed.result_ref, &closed.tip)?;
        return Ok(Some(exact_close_signal(&closed.result_ref)));
    }
    let Some(snapshot) = execution_complete_snapshot(workstream, request, state)? else {
        return Ok(None);
    };
    if let Some(request) = request
        && !close_request_matches_snapshot(request, &snapshot)
    {
        return Ok(None);
    }
    if !has_ref_prefix(state, &format!("lifecycle:ExecutionComplete:{workstream}:")) {
        state.append(
            EventKind("lifecycle:state".to_owned()),
            vec![
                Ref(format!(
                    "lifecycle:ExecutionComplete:{workstream}:{}",
                    snapshot.run_id
                )),
                Ref(snapshot.tip.clone()),
            ],
        )?;
    }
    let evidence = produce_final_evidence(&snapshot, state)?;
    let qualified = match evaluate_final_gate(&snapshot, &evidence, state) {
        Ok(value) => value,
        Err(condition) => {
            return Ok(Some(rejection(
                "lifecycle-close",
                &format!(
                    "FinalGateFailed:{};workstream={};run={};tip={}",
                    condition.id(),
                    snapshot.workstream,
                    snapshot.run_id,
                    snapshot.tip
                ),
            )));
        }
    };
    if snapshot.mode == ClosureMode::OperatorRatified && trigger != ClosureTrigger::OperatorClose {
        if !has_ref_prefix(state, &format!("lifecycle:ReadyToPublish:{workstream}:")) {
            state.append(
                EventKind("lifecycle:state".to_owned()),
                vec![
                    Ref(format!(
                        "lifecycle:ReadyToPublish:{workstream}:{}",
                        snapshot.run_id
                    )),
                    Ref(snapshot.tip.clone()),
                    Ref(qualified.gate_digest),
                ],
            )?;
        }
        return Ok(Some(format!(
            "lifecycle:awaiting-close:workstream={};run_id={};tip={};sequence={}",
            snapshot.workstream, snapshot.run_id, snapshot.tip, state.state.sequence
        )));
    }
    publish_result_ref(&qualified, state).map(|result| Some(exact_close_signal(&result.name)))
}

pub fn produce_final_evidence(
    snapshot: &FinalSnapshot,
    state: &mut CoreState,
) -> Result<FinalEvidence, AnyError> {
    if !has_exact_ref(state, &format!("final-commands-pass:{}", snapshot.tip))
        || !has_exact_ref(state, &format!("full-suite-pass:{}", snapshot.tip))
        || !has_exact_ref(state, &format!("final-validator-pass:{}", snapshot.tip))
    {
        state.append(
            EventKind("lifecycle:state".to_owned()),
            vec![
                Ref(format!(
                    "lifecycle:Finalizing:{}:{}",
                    snapshot.workstream, snapshot.run_id
                )),
                Ref(snapshot.tip.clone()),
            ],
        )?;
        let passed = run_final_verification_at_tip(snapshot)?;
        if passed {
            let digest = final_evidence_digest(snapshot);
            state.append(
                EventKind("final:evidence-produced".to_owned()),
                vec![
                    Ref(format!("final-commands-pass:{}", snapshot.tip)),
                    Ref(format!("full-suite-pass:{}", snapshot.tip)),
                    Ref(format!("final-validator-pass:{}", snapshot.tip)),
                    Ref(format!("final-evidence-run:{}", snapshot.run_id)),
                    Ref(format!("final-evidence-digest:{digest}")),
                ],
            )?;
        }
    }
    Ok(FinalEvidence {
        run_id: snapshot.run_id.clone(),
        tip: snapshot.tip.clone(),
        final_commands_pass: has_exact_ref(state, &format!("final-commands-pass:{}", snapshot.tip)),
        full_suite_pass: has_exact_ref(state, &format!("full-suite-pass:{}", snapshot.tip)),
        final_validator_pass: has_exact_ref(
            state,
            &format!("final-validator-pass:{}", snapshot.tip),
        ),
        digest: final_evidence_digest(snapshot),
    })
}

pub fn evaluate_final_gate(
    snapshot: &FinalSnapshot,
    evidence: &FinalEvidence,
    state: &CoreState,
) -> Result<QualifiedPublication, crate::finalize::FinalCondition> {
    let input = final_gate_input_from_snapshot(snapshot, evidence, state);
    let pass = crate::finalize::verify_final_gate(&input)?;
    let gate_digest = sha256_hex_local(
        format!(
            "{}\n{}\n{}\n{}\n{}",
            snapshot.workstream, snapshot.run_id, pass.tip, snapshot.tree, evidence.digest
        )
        .as_bytes(),
    );
    Ok(QualifiedPublication {
        workstream: snapshot.workstream.clone(),
        run_id: snapshot.run_id.clone(),
        tip: pass.tip,
        tree: snapshot.tree.clone(),
        result_ref: result_ref_name(&snapshot.workstream, &snapshot.run_id),
        gate_digest,
    })
}

pub fn publish_result_ref(
    qualified: &QualifiedPublication,
    state: &mut CoreState,
) -> Result<ResultRef, AnyError> {
    state.append(
        EventKind("lifecycle:state".to_owned()),
        vec![
            Ref(format!(
                "lifecycle:Publishing:{}:{}",
                qualified.workstream, qualified.run_id
            )),
            Ref(qualified.tip.clone()),
            Ref(qualified.gate_digest.clone()),
        ],
    )?;
    let _lock = CloseLock::acquire(&qualified.workstream)?;
    verify_result_ref_absent_or_prepared(qualified)?;
    persist_publication_prepared(qualified)?;
    let prepared = PublicationPrepared {
        schema: "PublicationPrepared".to_owned(),
        run_id: qualified.run_id.clone(),
        tip: qualified.tip.clone(),
        result_ref: qualified.result_ref.clone(),
        gate_digest: qualified.gate_digest.clone(),
    };
    complete_prepared_publication(&qualified.workstream, &prepared, state)
}

fn publish_prepared_result_ref(
    workstream: &str,
    prepared: &PublicationPrepared,
    state: &mut CoreState,
) -> Result<ResultRef, AnyError> {
    let _lock = CloseLock::acquire(workstream)?;
    complete_prepared_publication(workstream, prepared, state)
}

fn complete_prepared_publication(
    workstream: &str,
    prepared: &PublicationPrepared,
    state: &mut CoreState,
) -> Result<ResultRef, AnyError> {
    match git_stdout(
        &std::env::current_dir()?,
        &["rev-parse", "--verify", &prepared.result_ref],
    ) {
        Ok(existing) if existing.trim() == prepared.tip => {}
        Ok(_) => return Err("PublicationConflict:result-ref-at-another-tip".into()),
        Err(_) => {
            git_status(
                &std::env::current_dir()?,
                &[
                    "update-ref",
                    &prepared.result_ref,
                    &prepared.tip,
                    zero_oid(),
                ],
            )
            .map_err(|error| format!("PublicationConflict:update-ref:{error}"))?;
        }
    }
    verify_result_ref(&prepared.result_ref, &prepared.tip)?;
    persist_publication_closed(workstream, prepared)?;
    archive_publication(workstream, prepared)?;
    let closed_ref = format!("lifecycle:Closed:{workstream}:{}", prepared.run_id);
    if !has_exact_ref(state, &closed_ref) {
        state.append(
            EventKind("lifecycle:closed".to_owned()),
            vec![
                Ref(closed_ref),
                Ref(workstream.to_owned()),
                Ref(prepared.run_id.clone()),
                Ref(prepared.result_ref.clone()),
                Ref(prepared.tip.clone()),
                Ref(prepared.gate_digest.clone()),
                Ref("module-wired:finalize".to_owned()),
            ],
        )?;
    }
    Ok(ResultRef {
        name: prepared.result_ref.clone(),
    })
}

fn final_gate_input_from_snapshot(
    snapshot: &FinalSnapshot,
    evidence: &FinalEvidence,
    state: &CoreState,
) -> crate::finalize::FinalGateInput {
    let tip = snapshot.tip.clone();
    crate::finalize::FinalGateInput {
        final_tip: tip.clone(),
        every_unit_closed: snapshot
            .required_lanes
            .iter()
            .all(|lane| has_exact_ref(state, &format!("unit-closed:{lane}"))),
        no_mandatory_findings: !has_ref_prefix(state, "mandatory-finding:"),
        no_stale_required_proof: !has_ref_prefix(state, "stale-required-proof:"),
        no_active_or_unknown_jobs: !active_or_unknown_work(state),
        attributable_integrated_diff: !snapshot.required_lanes.is_empty()
            && has_ref_prefix(state, "unit-closed:"),
        final_commands: crate::finalize::TipEvidence {
            tip: tip.clone(),
            passed: evidence.final_commands_pass,
        },
        full_suite: crate::finalize::TipEvidence {
            tip: tip.clone(),
            passed: evidence.full_suite_pass,
        },
        final_validator: crate::finalize::TipEvidence {
            tip: tip.clone(),
            passed: evidence.final_validator_pass,
        },
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

fn execution_complete_snapshot(
    workstream: &str,
    request: Option<&ParsedCloseRequestArgs>,
    state: &CoreState,
) -> Result<Option<FinalSnapshot>, AnyError> {
    if active_or_unknown_work(state)
        || queued_candidates(state) > 0
        || has_ref_prefix(state, "validation:repair-required")
        || has_ref_prefix(state, "integration:conflict-route")
        || has_ref_prefix(state, "repair-queued:")
        || has_ref_prefix(state, "mandatory-finding:")
        || has_ref_prefix(state, "stale-required-proof:")
    {
        return Ok(None);
    }
    let approved = match read_approved_plan(workstream) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let required_count = approved.len();
    if required_count == 0 {
        return Ok(None);
    }
    let required_lanes = (1..=required_count)
        .map(|index| format!("L{index}"))
        .collect::<Vec<_>>();
    if !required_lanes
        .iter()
        .all(|lane| has_exact_ref(state, &format!("unit-closed:{lane}")))
    {
        return Ok(None);
    }
    let repo = std::env::current_dir()?;
    let run_ref = run_main_ref(workstream);
    let first_tip = match git_stdout(&repo, &["rev-parse", "--verify", &run_ref]) {
        Ok(value) => value.trim().to_owned(),
        Err(_) => return Ok(None),
    };
    let second_tip = git_stdout(&repo, &["rev-parse", "--verify", &run_ref])?
        .trim()
        .to_owned();
    if first_tip != second_tip || !is_git_oid(&first_tip) {
        return Ok(None);
    }
    let tree = git_stdout(
        &repo,
        &["rev-parse", "--verify", &format!("{}^{{tree}}", first_tip)],
    )?
    .trim()
    .to_owned();
    let run_id = match request {
        Some(value) => value.run_id.clone(),
        None => run_id_for_workstream(workstream)?,
    };
    Ok(Some(FinalSnapshot {
        workstream: workstream.to_owned(),
        run_id,
        tip: first_tip,
        tree,
        revision: state.state.revision,
        event_tip: format!("sha256:{}", state.state.state_hash().0),
        required_lanes,
        mode: closure_mode(),
    }))
}

fn close_request_matches_snapshot(
    request: &ParsedCloseRequestArgs,
    snapshot: &FinalSnapshot,
) -> bool {
    request.expected_revision == snapshot.revision
        && request.expected_event_tip == snapshot.event_tip
        && request.expected_tip == snapshot.tip
        && request.expected_tree == snapshot.tree
}

fn run_id_for_workstream(workstream: &str) -> Result<String, AnyError> {
    crate::evidence::EvidenceIdentity::for_workstream(workstream)
        .map(|identity| identity.run_id.0)
        .map_err(|error| format!("run-identity:{error:?}").into())
}

fn closure_mode() -> ClosureMode {
    match std::env::var("AUTOPILOT_CLOSURE_MODE") {
        Ok(value) if value == "operator_ratified" => ClosureMode::OperatorRatified,
        _ => ClosureMode::Automatic,
    }
}

fn run_final_verification_at_tip(snapshot: &FinalSnapshot) -> Result<bool, AnyError> {
    let repo = std::env::current_dir()?;
    git_status(
        &repo,
        &["cat-file", "-e", &format!("{}^{{commit}}", snapshot.tip)],
    )
    .map_err(|error| format!("final-evidence:tip:{error}"))?;
    if !repo.join(".pi/live-test.json").exists() {
        return Ok(true);
    }
    let worktree = final_worktree_path(&snapshot.workstream, &snapshot.tip);
    if worktree.exists() {
        let _ = Command::new("git")
            .current_dir(&repo)
            .args(["worktree", "remove", "--force"])
            .arg(&worktree)
            .status();
        if worktree.exists() {
            fs::remove_dir_all(&worktree)?;
        }
    }
    if let Some(parent) = worktree.parent() {
        fs::create_dir_all(parent)?;
    }
    let output = Command::new("git")
        .current_dir(&repo)
        .args(["worktree", "add", "--detach"])
        .arg(&worktree)
        .arg(&snapshot.tip)
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "final-evidence:worktree-add:{}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    let commands = live_verification_commands(&worktree)?;
    for command in commands {
        let label = command
            .name
            .clone()
            .unwrap_or_else(|| command.argv.join(" "));
        let Some((program, args)) = command.argv.split_first() else {
            return Err(format!("final-evidence:verification-command-empty-argv:{label}").into());
        };
        // `.output()` rather than `.status()`: a failing final command is the last thing
        // standing between a run and its result ref, and with inherited stdio the reason
        // is never recorded anywhere. Capture it so the refusal is diagnosable.
        let output = Command::new(program)
            .current_dir(worktree.join(command.cwd))
            .args(args)
            .output()?;
        if !output.status.success() {
            return Err(FinalVerificationFailure {
                name: label,
                argv: command.argv.clone(),
                code: output.status.code(),
                stdout_tail: bounded_tail(&output.stdout),
                stderr_tail: bounded_tail(&output.stderr),
            }
            .into_error());
        }
    }
    Ok(true)
}

/// A final verification command that failed at the run tip.
///
/// This is a hard refusal, never a downgrade to "unverified": the final gate must still
/// refuse to publish. The only thing added is the evidence needed to diagnose it.
struct FinalVerificationFailure {
    name: String,
    argv: Vec<String>,
    code: Option<i32>,
    stdout_tail: String,
    stderr_tail: String,
}

impl FinalVerificationFailure {
    fn into_error(self) -> AnyError {
        format!(
            "final-evidence:verification-failed:name={};argv={};exit={};stdout_tail={};stderr_tail={}",
            self.name,
            self.argv.join(" "),
            self.code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_owned()),
            self.stdout_tail,
            self.stderr_tail
        )
        .into()
    }
}

/// Bounded, single-line tail of captured child output for event/status embedding.
///
/// Counts CHARACTERS, not bytes. Slicing a `str` at a byte offset panics when the offset
/// lands inside a multi-byte character, and real `cargo test` / `cargo clippy` output is
/// full of multi-byte glyphs. Panicking here would destroy the very diagnostic this
/// function exists to deliver, at the end of a long autonomous run.
fn bounded_tail(bytes: &[u8]) -> String {
    const MAX_CHARS: usize = 600;
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim_end();
    let char_count = trimmed.chars().count();
    let tail: String = if char_count > MAX_CHARS {
        trimmed.chars().skip(char_count - MAX_CHARS).collect()
    } else {
        trimmed.to_owned()
    };
    tail.replace(['\n', '\r'], " | ")
}

#[derive(Deserialize)]
struct LiveVerificationCommand {
    argv: Vec<String>,
    cwd: String,
    #[serde(default)]
    name: Option<String>,
}

fn live_verification_commands(worktree: &Path) -> Result<Vec<LiveVerificationCommand>, AnyError> {
    #[derive(Deserialize)]
    struct LiveTest {
        #[serde(rename = "verificationCommands")]
        verification_commands: Vec<LiveVerificationCommand>,
    }
    let text = fs::read_to_string(worktree.join(".pi/live-test.json"))?;
    let live: LiveTest = serde_json::from_str(&text)?;
    Ok(live.verification_commands)
}

fn final_worktree_path(workstream: &str, tip: &str) -> PathBuf {
    let short = tip.get(..12).unwrap_or(tip);
    workstream_dir(workstream)
        .join("final-worktrees")
        .join(short)
}

fn final_evidence_digest(snapshot: &FinalSnapshot) -> String {
    sha256_hex_local(
        format!(
            "{}\n{}\n{}\n{}\n{}",
            snapshot.workstream, snapshot.run_id, snapshot.tip, snapshot.tree, snapshot.revision
        )
        .as_bytes(),
    )
}

fn result_ref_name(workstream: &str, run_id: &str) -> String {
    format!(
        "refs/autopilot/results/{}/{}",
        safe_ref_component(workstream),
        safe_ref_component(run_id)
    )
}

fn exact_close_signal(result_ref: &str) -> String {
    format!("lifecycle:close:result_ref={result_ref}")
}

fn close_dir(workstream: &str) -> PathBuf {
    workstream_dir(workstream).join("close")
}

fn prepared_path(workstream: &str) -> PathBuf {
    close_dir(workstream).join("publication-prepared.json")
}

fn closed_path(workstream: &str) -> PathBuf {
    close_dir(workstream).join("closed.json")
}

fn read_publication_prepared(workstream: &str) -> Result<Option<PublicationPrepared>, AnyError> {
    read_json_optional(&prepared_path(workstream))
}

fn read_publication_closed(workstream: &str) -> Result<Option<PublicationClosed>, AnyError> {
    read_json_optional(&closed_path(workstream))
}

fn read_json_optional<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, AnyError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(serde_json::from_str(&text)?)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn persist_publication_prepared(qualified: &QualifiedPublication) -> Result<(), AnyError> {
    let prepared = PublicationPrepared {
        schema: "PublicationPrepared".to_owned(),
        run_id: qualified.run_id.clone(),
        tip: qualified.tip.clone(),
        result_ref: qualified.result_ref.clone(),
        gate_digest: qualified.gate_digest.clone(),
    };
    let path = prepared_path(&qualified.workstream);
    write_json_create_or_same(&path, &prepared)
}

fn persist_publication_closed(
    workstream: &str,
    prepared: &PublicationPrepared,
) -> Result<(), AnyError> {
    let closed = PublicationClosed {
        schema: "Closed".to_owned(),
        run_id: prepared.run_id.clone(),
        tip: prepared.tip.clone(),
        result_ref: prepared.result_ref.clone(),
        gate_digest: prepared.gate_digest.clone(),
    };
    write_json_create_or_same(&closed_path(workstream), &closed)
}

fn write_json_create_or_same<T: Serialize>(path: &Path, value: &T) -> Result<(), AnyError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(value)?;
    match fs::read(path) {
        Ok(existing) if existing == bytes => Ok(()),
        Ok(_) => Err("PublicationConflict:durable-intent-mismatch".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn verify_result_ref_absent_or_prepared(qualified: &QualifiedPublication) -> Result<(), AnyError> {
    match git_stdout(
        &std::env::current_dir()?,
        &["rev-parse", "--verify", &qualified.result_ref],
    ) {
        Ok(existing) if existing.trim() == qualified.tip => {
            Err("PublicationConflict:pre-existing-ref-without-matching-prepared-intent".into())
        }
        Ok(_) => Err("PublicationConflict:result-ref-at-another-tip".into()),
        Err(_) => Ok(()),
    }
}

fn verify_result_ref(result_ref: &str, tip: &str) -> Result<(), AnyError> {
    let resolved = git_stdout(
        &std::env::current_dir()?,
        &["rev-parse", "--verify", result_ref],
    )?;
    if resolved.trim() == tip {
        Ok(())
    } else {
        Err("PublicationConflict:result-ref-at-another-tip".into())
    }
}

fn archive_publication(workstream: &str, prepared: &PublicationPrepared) -> Result<(), AnyError> {
    let archive_dir = PathBuf::from(".pi/autopilot/archive")
        .join(workstream)
        .join(&prepared.run_id);
    fs::create_dir_all(&archive_dir)?;
    fs::write(archive_dir.join("outcome.txt"), "closed")?;
    fs::write(
        archive_dir.join("publication.json"),
        serde_json::to_vec_pretty(prepared)?,
    )?;
    Ok(())
}

fn zero_oid() -> &'static str {
    "0000000000000000000000000000000000000000"
}

struct CloseLock {
    path: PathBuf,
}

impl CloseLock {
    fn acquire(workstream: &str) -> Result<Self, AnyError> {
        let path = close_dir(workstream).join("lock");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::create_dir(&path) {
            Ok(()) => Ok(Self { path }),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err("CloseLocked:run-close-lock-held".into())
            }
            Err(error) => Err(error.into()),
        }
    }
}

impl Drop for CloseLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.path);
    }
}

fn active_or_unknown_work(state: &CoreState) -> bool {
    active_work(state)
        || has_ref_prefix(state, "unknown-job:")
        || has_ref_prefix(state, "fixer-active:")
        || has_ref_prefix(state, "validator-unknown:")
}

fn has_exact_ref(state: &CoreState, reference: &str) -> bool {
    state.state.refs.contains_key(&Ref(reference.to_owned()))
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
    active_implementers(state) > 0
        || active_recovery_engineers(state) > 0
        || active_validators(state) > 0
}
fn delivery_execution_started(state: &CoreState) -> bool {
    state
        .state
        .refs
        .keys()
        .filter_map(|reference| runner::decode_binding_ref(&reference.0))
        .any(|binding| {
            matches!(
                binding.role_id.0.as_str(),
                "implementer" | "recovery-engineer" | "validator"
            )
        })
        || has_ref_prefix(state, "unit-closed:")
        || has_ref_prefix(state, "candidate-queued:")
        || has_ref_prefix(state, "integration:forward-integrated")
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

fn ensure_run_main_at_approved_baseline(
    repo: &Path,
    workstream: &str,
    authority: &ApprovedRepositoryAuthority,
    execution_started: bool,
) -> Result<(), String> {
    let run_main = run_main_ref(workstream);
    let manifest_path = PathBuf::from(&authority.manifest_path);
    let binding =
        runner::read_repository_authority_binding(&manifest_path, &authority.manifest_digest)
            .map_err(|error| format!("run-main:repository-authority:{error}"))?;
    if binding.manifest.head_commit != authority.head_commit.0
        || binding.manifest.head_tree != authority.head_tree.0
    {
        return Err(format!(
            "run-main approved baseline drift: manifest head={} tree={} approved head={} tree={}",
            binding.manifest.head_commit,
            binding.manifest.head_tree,
            authority.head_commit.0,
            authority.head_tree.0
        ));
    }
    match git_stdout(
        repo,
        &["rev-parse", "--verify", &format!("{run_main}^{{commit}}")],
    ) {
        Ok(_) => {
            let stable_tip = verify_run_main_stable(repo, workstream)?;
            if execution_started {
                git_status(
                    repo,
                    &["merge-base", "--is-ancestor", &authority.head_commit.0, &stable_tip],
                )
                .map_err(|error| {
                    format!(
                        "run-main approved baseline is not an ancestor of stable tip: baseline={} tip={stable_tip}: {error}",
                        authority.head_commit.0
                    )
                })?;
                Ok(())
            } else if stable_tip == authority.head_commit.0 {
                Ok(())
            } else {
                Err(format!(
                    "run-main preexisting baseline drift: expected approved baseline {}, got {}",
                    authority.head_commit.0, stable_tip
                ))
            }
        }
        Err(error) => {
            if execution_started {
                return Err(format!(
                    "run-main missing after execution began: {run_main}: {error}"
                ));
            }
            git_status(
                repo,
                &["update-ref", &run_main, &authority.head_commit.0, ""],
            )
            .map_err(|error| format!("run-main:create-cas:{error}"))?;
            let actual = verify_run_main_stable(repo, workstream)?;
            if actual != authority.head_commit.0 {
                return Err(format!(
                    "run-main created at wrong commit: expected {}, got {}",
                    authority.head_commit.0, actual
                ));
            }
            Ok(())
        }
    }
}
fn verify_run_main_stable(repo: &Path, workstream: &str) -> Result<String, String> {
    let run_main = run_main_ref(workstream);
    let first = git_stdout(
        repo,
        &["rev-parse", "--verify", &format!("{run_main}^{{commit}}")],
    )
    .map_err(|error| format!("run-main missing or malformed: {run_main}: {error}"))?;
    let second = git_stdout(
        repo,
        &["rev-parse", "--verify", &format!("{run_main}^{{commit}}")],
    )
    .map_err(|error| format!("run-main moved while verifying: {run_main}: {error}"))?;
    if first.trim() != second.trim() {
        return Err(format!(
            "run-main moved while verifying: first={} second={}",
            first.trim(),
            second.trim()
        ));
    }
    Ok(first.trim().to_owned())
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
fn sha256_hex_local(data: &[u8]) -> String {
    use sha2::{Digest as _, Sha256};
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
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
    let prompt_text = match read_bounded_utf8(
        Path::new(&binding.prompt_path),
        MAX_TERMINAL_CARRIER_BYTES,
        "prompt-read",
    ) {
        Ok(value) => value,
        Err(error) => {
            return vec![Ref(format!(
                "module-unreachable:prompt-read:{}:{error}",
                binding.prompt_path
            ))];
        }
    };
    let prompt_digest = sha256_hex_local(prompt_text.as_bytes());
    if prompt_digest != binding.prompt_digest {
        return vec![Ref(format!(
            "module-unreachable:prompt-digest:{}",
            binding.assignment_id.0
        ))];
    }
    let estimate = crate::context::estimate_tokens(prompt_text.as_bytes(), 512);
    let budget = crate::context::route_budget(estimate, 200_000, estimate / 2);
    vec![
        Ref("module-wired:context".to_owned()),
        Ref("module-wired:prompt".to_owned()),
        Ref(format!(
            "context-route:{:?}:{}",
            budget.route, budget.estimated_percent
        )),
        Ref(format!("prompt-bound:{}", binding.prompt_digest)),
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
