use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use kernel::boundary::Rejection;
use kernel::generated::{
    AllocationLaneProposal, AutopilotEventRef, BackgroundAction, BlockedCancellationRecord,
    BlockedLatch, BlockedLatchEventRef, BlockedReceipt, BlockedReconcileRecord,
    BlockedResultObservedAckStatus, CONTRACT_VERSION, ChildControlAcceptReceipt,
    ChildControlBlockedCancellation, ChildControlBlockedGate, ChildControlRequest,
    ChildControlRequestKind, ChildControlResponse, ChildControlRuntimeEvidence,
    CoreToHostBlockedReconcilePayload, CoreToHostBlockedResultObservedPayload,
    CoreToHostChildControlPayload, CoreToHostDonePayload, CoreToHostSpawnPayload,
    CoreToHostSpawnWavePayload, CoreToHostUiPayload, DeferredHostEffectV1, DeliveryBoundary,
    DeliveryResult, Digest, EventKind, EventRow, HostToCoreAgentResultPayload,
    HostToCoreBlockedReconcilePayload, HostToCoreBlockedResultObservedPayload,
    HostToCoreChildControlPayload, HostToCoreCommandPayload, HostToCoreSpawnResultPayload,
    HostToCoreTaskCompletedPayload, Id, ModeId, Nullable, PreparedSubmitArtifactRef,
    PreparedSubmitIssuedAction, PreparedSubmitTransitionV1, Ref, SchemaId, SeamEnvelope, Sha,
    SubmitDiagnostic, SubmitDiagnosticActual, SubmitDiagnosticError, SubmitReceipt,
    SubmitReceiptEventRef, SubmitReceiptValidatorVersion, TestId, UiKind,
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
use crate::runner::{self, RunnerAssignment, VersionedRunnerBinding};

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
const BLOCKED_PROFILE_ID: &str = "autopilot.blocked_report.v1:autopilot_report_blocked";
const BLOCKED_TOOL_NAME: &str = "autopilot_report_blocked";
const BLOCKED_ARTIFACT_MAX_BYTES: usize = 2 << 20;
const BLOCKED_PROJECTION_UNAVAILABLE: &str = "blocked-projection-unavailable";
type AnyError = Box<dyn std::error::Error>;

#[derive(Debug)]
pub struct CoreState {
    event_path: Option<PathBuf>,
    /// Rebuilt only from exact blocked root/event-ref pairs; this is a
    /// projection, never a directory or loose-ref discovery mechanism.
    blocked_latches: BTreeMap<(String, String), BlockedLatchState>,
    /// Current-process broker correlation for a live child tool call. Durable
    /// restart authorization comes from the Host's reconciled pending receipt.
    blocked_reporter_tool_calls: BTreeMap<String, String>,
    /// A rooted blocked artifact must never make the Core unavailable.  This
    /// bounded redacted posture instead closes every launch path until exact
    /// blocked recovery has re-established projection authority.
    blocked_projection_error: Option<&'static str>,
    state: State,
    /// Exact rows are retained alongside the aggregate State because V2
    /// ready authority is one event-scoped root, never a join across refs.
    events: Vec<EventRow>,
    /// Canonical bytes actually appended for the paired event row. Receipt
    /// roots hash this durable representation, never a synthetic projection.
    event_bytes: Vec<Vec<u8>>,
}
#[derive(Clone, Debug)]
struct BlockedLatchState {
    receipt: BlockedReceipt,
    latch: BlockedLatch,
    reporter_observed: bool,
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
        let (state, events, event_bytes) = match event_path.as_deref() {
            Some(path) => replay_path(path)?,
            None => (State::EMPTY, Vec::new(), Vec::new()),
        };
        let mut opened = Self {
            event_path,
            state,
            events,
            event_bytes,
            blocked_latches: BTreeMap::new(),
            blocked_reporter_tool_calls: BTreeMap::new(),
            blocked_projection_error: None,
        };
        // Generic event-log replay remains strict above.  Only the optional
        // blocked projection is isolated: a corrupt rooted artifact closes
        // launches but never takes down the Core protocol process.
        if opened.repair_blocked_latch_event_refs().is_err()
            || opened.rebuild_blocked_latches().is_err()
        {
            opened.degrade_blocked_projection();
        }
        Ok(opened)
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
        let bytes = if matches!(
            event.kind.0.as_str(),
            "submit:accepted" | "blocked:accepted"
        ) {
            crate::evidence::canonical_json(&event)?
        } else {
            serde_json::to_vec(&event)?
        };
        if let Some(path) = &self.event_path {
            append_event(path, &bytes)?;
        }
        self.state = apply(self.state.clone(), &event);
        self.events.push(event);
        self.event_bytes.push(bytes);
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

    fn degrade_blocked_projection(&mut self) {
        self.blocked_latches.clear();
        self.blocked_projection_error = Some(BLOCKED_PROJECTION_UNAVAILABLE);
    }

    fn rebuild_blocked_latches(&mut self) -> Result<(), AnyError> {
        let rebuilt = project_blocked_latches(self).and_then(|latches| {
            ensure_no_pending_blocked_transactions(self)?;
            Ok(latches)
        });
        match rebuilt {
            Ok(latches) => {
                self.blocked_latches = latches;
                self.blocked_projection_error = None;
                Ok(())
            }
            Err(error) => {
                self.degrade_blocked_projection();
                Err(error)
            }
        }
    }

    fn blocked_projection_error(&self) -> Option<&'static str> {
        self.blocked_projection_error
    }

    /// The accepted root is already the durable latch publication boundary.
    /// If a crash follows it but precedes the non-circular event-reference
    /// row, finish only that deterministic row; never remint either artifact.
    fn repair_blocked_latch_event_refs(&mut self) -> Result<(), AnyError> {
        let roots = self
            .events
            .iter()
            .filter(|event| event.kind.0 == "blocked:accepted")
            .map(|event| {
                event
                    .artifact_refs
                    .iter()
                    .map(decode_blocked_latch_root)
                    .collect::<Result<Vec<_>, _>>()
                    .and_then(|roots| {
                        let roots = roots.into_iter().flatten().collect::<Vec<_>>();
                        match roots.as_slice() {
                            [root] => Ok(root.clone()),
                            _ => Err("blocked accepted event lacks exactly one canonical root"
                                .to_owned()),
                        }
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        for root in roots {
            let receipt = read_blocked_receipt_at(Path::new(&root.blocked_receipt_ref.0))?
                .ok_or("blocked root receipt is absent")?;
            let latch = read_blocked_latch_at(Path::new(&root.latch_ref.0))?
                .ok_or("blocked root latch is absent")?;
            let binding = blocked_binding_for_receipt(self, &receipt)?;
            if blocked_root(&receipt, &latch, &binding)? != root {
                return Err("blocked root artifact digest/path drift".into());
            }
            let accepted_index = blocked_accepted_root_index(self, &root)?
                .ok_or("blocked accepted root disappeared during repair")?;
            if blocked_event_ref_for_root(self, &root, accepted_index)?.is_none() {
                append_blocked_latch_event_ref(self, &root, accepted_index)?;
            }
        }
        Ok(())
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
    match tables::admit_host_to_core(&envelope.kind, envelope.payload.clone()) {
        Ok(route) => dispatch(id, route, state),
        Err(SeamAdmissionError::Payload { kind, .. }) if kind == "child-control" => {
            child_control_payload_retry(id, &envelope.payload)
        }
        Err(SeamAdmissionError::Payload { kind, .. })
            if matches!(kind, "blocked-result-observed" | "blocked-reconcile") =>
        {
            blocked_private_rejection(id, kind, "malformed")
        }
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
        HostToCoreRoute::ChildControl(payload) => route_child_control(id, payload, state),
        HostToCoreRoute::BlockedResultObserved(payload) => {
            route_blocked_result_observed(id, payload, state)
        }
        HostToCoreRoute::BlockedReconcile(payload) => route_blocked_reconcile(id, payload, state),
        HostToCoreRoute::OperatorAnswer(_) => done(id, "ok:recorded".to_owned()),
        HostToCoreRoute::Shutdown(_) => done(id, "ok:shutdown".to_owned()),
    }
}

/// The ChildControl route is intentionally closed: even malformed authority,
/// payload, disk, or shared-admission failures become the generated RETRY
/// response and never escape `dispatch` to terminate Core.
fn route_child_control(
    id: u64,
    HostToCoreChildControlPayload {
        broker_capability,
        request,
    }: HostToCoreChildControlPayload,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    let request_id = request.request_id.clone();
    if !host_broker_authorized(&broker_capability) {
        return child_control_redacted_retry(id, request_id);
    }
    match admit_child_control_request(&request, state) {
        Ok(ChildControlAdmission::Blocked { receipt, latch }) => {
            child_control_accept_blocked(id, request_id, receipt, latch)
        }
        Ok(ChildControlAdmission::Replay { receipt, binding }) => {
            match root_or_verify_submit_receipt(state, &receipt, &binding) {
                Ok(()) => child_control_accept(id, request_id, receipt),
                Err(detail) => {
                    let diagnostic = if binding.result_contract.0 == "autopilot.delivery_result.v2"
                    {
                        delivery_staging_retry("submit.receipt_root", "", detail)
                    } else {
                        staging_retry("submit.receipt_root", "", detail)
                    };
                    child_control_retry(id, request_id, diagnostic)
                }
            }
        }
        Ok(ChildControlAdmission::Staged {
            binding,
            facade,
            raw_payload,
            prepared,
        }) => {
            match commit_staged_submit(state, &request, &binding, &facade, &raw_payload, prepared) {
                Ok(receipt) => child_control_accept(id, request_id, receipt),
                Err(diagnostic) => child_control_retry(id, request_id, diagnostic),
            }
        }
        Err(failure) => child_control_retry(id, request_id, failure),
    }
}

enum ChildControlAdmission {
    Blocked {
        receipt: BlockedReceipt,
        latch: BlockedLatch,
    },
    Replay {
        receipt: SubmitReceipt,
        binding: runner::ReceiptV1RunnerBinding,
    },
    /// Child admission completed in memory. The Core-only planning transition
    /// is staged and committed by the serialized seam turn below.
    Staged {
        binding: runner::ReceiptV1RunnerBinding,
        facade: kernel::generated::AgentRunSpec,
        raw_payload: Vec<u8>,
        prepared: runner::child::PreparedCarrier,
    },
}

fn admit_child_control_request(
    request: &ChildControlRequest,
    state: &mut CoreState,
) -> Result<ChildControlAdmission, SubmitDiagnostic> {
    if request.schema.0 != "autopilot.child_control_request.v1" {
        return Err(child_control_diagnostic(
            "submit.request_schema",
            "/schema",
            "autopilot.child_control_request.v1",
            &serde_json::json!(request.schema.0),
            "Send the exact generated child-control request schema.",
        ));
    }
    if request.tool_call_id.trim().is_empty() {
        return Err(child_control_diagnostic(
            "submit.tool_call_id",
            "/tool_call_id",
            "a nonempty opaque Pi tool-call id",
            &serde_json::json!(request.tool_call_id),
            "Resubmit through the generated terminal tool wrapper.",
        ));
    }
    let binding = receipt_binding_for(state, request).map_err(|detail| {
        child_control_diagnostic(
            "submit.binding",
            "/assignment_id",
            "one authenticated receipt_v1 runner binding",
            &serde_json::json!(detail),
            "Retry with the issued child-control capability.",
        )
    })?;
    // A rooted blocked receipt has all immutable admission authority already.
    // Authenticate it from the durable binding/capability and canonical raw
    // report before touching a mutable V5 spec, carrier, worktree, or runtime
    // evidence.  This is intentionally the same source-free replay boundary
    // as submit receipt replay.
    if matches!(request.kind, ChildControlRequestKind::Blocked) {
        let raw = crate::evidence::canonical_json(&request.raw_payload).map_err(|error| {
            child_control_diagnostic(
                "submit.canonical_json",
                "/raw_payload",
                "canonical JSON payload bytes",
                &serde_json::json!(error.to_string()),
                "Resubmit a JSON-compatible terminal payload.",
            )
        })?;
        authenticate_blocked_request_identity(request, &binding)?;
        if let Some((receipt, latch)) = rooted_blocked_alias(state, &binding, &raw)? {
            state
                .blocked_reporter_tool_calls
                .insert(receipt.receipt_id.0.clone(), request.tool_call_id.clone());
            return Ok(ChildControlAdmission::Blocked { receipt, latch });
        }
        if let Some((receipt, latch)) = recover_pending_blocked_transaction(state, &binding, &raw)?
        {
            state
                .blocked_reporter_tool_calls
                .insert(receipt.receipt_id.0.clone(), request.tool_call_id.clone());
            return Ok(ChildControlAdmission::Blocked { receipt, latch });
        }
        if state.blocked_projection_error().is_some() {
            return Err(blocked_admission_retry(
                "submit.blocked_projection",
                BLOCKED_PROJECTION_UNAVAILABLE,
            ));
        }
    }
    // An already accepted receipt aliases strictly by binding plus canonical
    // raw bytes. It deliberately does not reread a later request/tool-call or
    // mutable V5 spec before replaying the immutable receipt transaction.
    if matches!(&request.kind, ChildControlRequestKind::Submit) {
        if !runner::constant_time_hex_digest_matches(&request.token, &binding.run_capability_digest)
        {
            return Err(child_control_diagnostic(
                "submit.capability",
                "/token",
                "the issued per-run capability",
                &serde_json::json!(request.token),
                "Retry through the issued child runner without changing its capability.",
            ));
        }
        if request.run_id != binding.run_id
            || request.assignment_id != binding.assignment_id
            || request.attempt != binding.attempt
            || request.profile_id != binding.profile_id
            || request.tool_name != binding.tool_name
        {
            return Err(child_control_diagnostic(
                "submit.request_identity",
                "",
                "issued run, assignment, attempt, profile, and tool identity",
                &serde_json::json!({
                    "run_id": request.run_id,
                    "assignment_id": request.assignment_id,
                    "attempt": request.attempt,
                    "profile_id": request.profile_id,
                    "tool_name": request.tool_name,
                }),
                "Resubmit through the exact issued terminal profile.",
            ));
        }
        let raw = crate::evidence::canonical_json(&request.raw_payload).map_err(|error| {
            child_control_diagnostic(
                "submit.canonical_json",
                "/raw_payload",
                "canonical JSON payload bytes",
                &serde_json::json!(error.to_string()),
                "Resubmit a JSON-compatible terminal payload.",
            )
        })?;
        let receipt_path = submit_receipt_path(&binding).map_err(|detail| {
            child_control_diagnostic(
                "submit.receipt_path",
                "",
                "the deterministic submit receipt path",
                &serde_json::json!(detail),
                "Retry with the issued child-control capability.",
            )
        })?;
        if let Some(receipt) = read_submit_receipt_at(&receipt_path).map_err(|detail| {
            child_control_diagnostic(
                "submit.receipt_read",
                "",
                "a bounded canonical submit receipt",
                &serde_json::json!(detail),
                "Retry with the issued child-control capability.",
            )
        })? {
            if receipt_matches_request(&receipt, &binding, &raw) {
                return Ok(ChildControlAdmission::Replay { receipt, binding });
            }
            return Err(child_control_diagnostic(
                "submit.receipt_conflict",
                "/raw_payload",
                "the canonical payload already accepted for this action/assignment/revision",
                &request.raw_payload,
                "Do not change a payload after this assignment has an accepted receipt.",
            ));
        }
    }
    let (spec_v5, facade, spec_bytes) =
        runner::read_receipt_v1_spec(&binding).map_err(|error| {
            child_control_diagnostic(
                "submit.spec_authority",
                "",
                "the exact digest-bound receipt_v1 runner spec",
                &serde_json::json!(error.to_string()),
                "Retry with the current issued runner capability.",
            )
        })?;
    if !runner::constant_time_hex_digest_matches(&request.token, &binding.run_capability_digest)
        || !runner::constant_time_hex_digest_matches(
            &request.token,
            &spec_v5.child_control_token_digest.0,
        )
    {
        return Err(child_control_diagnostic(
            "submit.capability",
            "/token",
            "the issued per-run capability",
            &serde_json::json!(request.token),
            "Retry through the issued child runner without changing its capability.",
        ));
    }
    let expected_authority = receipt_authority_digest(&binding, &spec_v5).map_err(|error| {
        child_control_diagnostic(
            "submit.authority_digest",
            "",
            "a canonical V5 binding/spec authority digest",
            &serde_json::json!(error),
            "Retry with the current issued runner binding.",
        )
    })?;
    if expected_authority != binding.authority_digest {
        return Err(child_control_diagnostic(
            "submit.authority_digest",
            "",
            "the binding's exact V5 authority identity",
            &serde_json::json!(binding.authority_digest),
            "Retry with the current issued runner binding.",
        ));
    }
    let request_identity_matches = request.run_id == binding.run_id
        && request.assignment_id == binding.assignment_id
        && request.attempt == binding.attempt
        && match request.kind {
            ChildControlRequestKind::Submit => {
                request.profile_id == binding.profile_id && request.tool_name == binding.tool_name
            }
            ChildControlRequestKind::Blocked => {
                request.profile_id == BLOCKED_PROFILE_ID && request.tool_name.0 == BLOCKED_TOOL_NAME
            }
        };
    if !request_identity_matches {
        return Err(child_control_diagnostic(
            "submit.request_identity",
            "",
            "issued run, assignment, attempt, and exact terminal tool identity",
            &serde_json::json!({
                "run_id": request.run_id,
                "assignment_id": request.assignment_id,
                "attempt": request.attempt,
                "profile_id": request.profile_id,
                "tool_name": request.tool_name,
            }),
            "Resubmit through the exact issued terminal profile.",
        ));
    }
    validate_child_control_runtime_evidence(request, &facade)?;
    match request.kind {
        ChildControlRequestKind::Blocked => {
            let raw = crate::evidence::canonical_json(&request.raw_payload).map_err(|error| {
                child_control_diagnostic(
                    "submit.canonical_json",
                    "/raw_payload",
                    "canonical JSON payload bytes",
                    &serde_json::json!(error.to_string()),
                    "Resubmit a JSON-compatible terminal payload.",
                )
            })?;
            let report: kernel::generated::BlockedReport =
                serde_json::from_value(request.raw_payload.clone()).map_err(|error| {
                    child_control_diagnostic(
                        "submit.blocked_schema",
                        "/raw_payload",
                        "closed autopilot.blocked_report.v1 payload",
                        &serde_json::json!(error.to_string()),
                        "Correct the blocked report payload and resubmit.",
                    )
                })?;
            validate_blocked_report(&report)?;
            let (receipt, latch) =
                admit_or_replay_blocked_latch(state, request, &binding, &raw, &report)?;
            Ok(ChildControlAdmission::Blocked { receipt, latch })
        }
        ChildControlRequestKind::Submit => {
            let raw = crate::evidence::canonical_json(&request.raw_payload).map_err(|error| {
                child_control_diagnostic(
                    "submit.canonical_json",
                    "/raw_payload",
                    "canonical JSON payload bytes",
                    &serde_json::json!(error.to_string()),
                    "Resubmit a JSON-compatible terminal payload.",
                )
            })?;
            let spec_text = std::str::from_utf8(&spec_bytes).map_err(|error| {
                child_control_diagnostic(
                    "submit.spec_utf8",
                    "",
                    "UTF-8 V5 spec bytes",
                    &serde_json::json!(error.to_string()),
                    "Retry with the current issued runner spec.",
                )
            })?;
            let receipt_path = submit_receipt_path(&binding).map_err(|detail| {
                child_control_diagnostic(
                    "submit.receipt_path",
                    "",
                    "the deterministic submit receipt path",
                    &serde_json::json!(detail),
                    "Retry with the issued child-control capability.",
                )
            })?;
            if let Some(receipt) = read_submit_receipt_at(&receipt_path).map_err(|detail| {
                child_control_diagnostic(
                    "submit.receipt_read",
                    "",
                    "a bounded canonical submit receipt",
                    &serde_json::json!(detail),
                    "Retry with the issued child-control capability.",
                )
            })? {
                if receipt_matches_request(&receipt, &binding, &raw) {
                    return Ok(ChildControlAdmission::Replay { receipt, binding });
                }
                return Err(child_control_diagnostic(
                    "submit.receipt_conflict",
                    "/raw_payload",
                    "the canonical payload already accepted for this action/assignment/revision",
                    &request.raw_payload,
                    "Do not change a payload after this assignment has an accepted receipt.",
                ));
            }
            let prepared = runner::child::admit_receipt_v1_submission(
                Path::new(&binding.spec_path),
                spec_text,
                &binding.spec_digest,
                &facade,
                &spec_v5.required_pi_version,
                request.raw_payload.clone(),
                request.runtime_evidence.clone(),
                request.tool_call_id.clone(),
            )
            .map_err(|failure| match failure {
                runner::child::AdmissionFailure::PlaceholderLeaked => child_control_diagnostic(
                    "submit.placeholder_leaked",
                    "/raw_payload",
                    "a real terminal payload, not a generated placeholder",
                    &request.raw_payload,
                    "Call the terminal tool through the generated bridge and resubmit.",
                ),
                runner::child::AdmissionFailure::Authority(detail) => child_control_diagnostic(
                    "submit.authority",
                    "",
                    "issued child/profile/package authority",
                    &serde_json::json!(detail),
                    "Retry with the issued authority and correct the payload if needed.",
                ),
                runner::child::AdmissionFailure::Value {
                    field,
                    expected,
                    actual,
                } => child_control_diagnostic(
                    "submit.value",
                    &diagnostic_pointer(&field),
                    &expected,
                    &serde_json::json!(actual),
                    "Correct the reported value and resubmit.",
                ),
            })?;
            Ok(ChildControlAdmission::Staged {
                binding,
                facade,
                raw_payload: raw,
                prepared,
            })
        }
    }
}

fn validate_child_control_runtime_evidence(
    request: &ChildControlRequest,
    facade: &kernel::generated::AgentRunSpec,
) -> Result<(), SubmitDiagnostic> {
    if request.runtime_evidence.schema.0 != "autopilot.child_control_runtime_evidence.v1" {
        return Err(child_control_diagnostic(
            "submit.runtime_evidence_schema",
            "/runtime_evidence/schema",
            "autopilot.child_control_runtime_evidence.v1",
            &serde_json::json!(request.runtime_evidence.schema.0),
            "Send the generated runtime evidence carrier unchanged.",
        ));
    }
    let delivery_submit = matches!(request.kind, ChildControlRequestKind::Submit)
        && matches!(
            facade.assignment_kind,
            kernel::generated::ValidationAssignmentKind::Delivery
        );
    let has_denials = request.runtime_evidence.delivery_policy_denials.0.is_some();
    let has_executions = request
        .runtime_evidence
        .approved_command_executions
        .0
        .is_some();
    if (delivery_submit && (!has_denials || !has_executions))
        || (!delivery_submit && (has_denials || has_executions))
    {
        return Err(child_control_diagnostic(
            "submit.runtime_evidence_profile",
            "/runtime_evidence",
            if delivery_submit {
                "both delivery runtime ledgers"
            } else {
                "explicit null delivery runtime ledgers"
            },
            &serde_json::json!({
                "delivery_policy_denials_present": has_denials,
                "approved_command_executions_present": has_executions,
            }),
            "Send the generated profile-specific runtime evidence without merging it into raw_payload.",
        ));
    }
    Ok(())
}

fn strict_versioned_runner_bindings(
    state: &CoreState,
) -> Result<Vec<VersionedRunnerBinding>, String> {
    state
        .state
        .refs
        .keys()
        .filter(|reference| reference.0.starts_with(runner::ISSUED_BINDING_REF_PREFIX))
        .map(|reference| {
            runner::decode_versioned_binding_ref(&reference.0)
                .map_err(|error| format!("durable runner binding corruption: {error}"))
        })
        .collect()
}

fn receipt_binding_for(
    state: &CoreState,
    request: &ChildControlRequest,
) -> Result<runner::ReceiptV1RunnerBinding, String> {
    let mut bindings = strict_versioned_runner_bindings(state)?
        .into_iter()
        .filter_map(|versioned| match versioned {
            VersionedRunnerBinding::ReceiptV1(binding)
                if binding.run_id == request.run_id
                    && binding.assignment_id == request.assignment_id =>
            {
                Some(binding)
            }
            VersionedRunnerBinding::ReplayV0(_) | VersionedRunnerBinding::ReceiptV1(_) => None,
        })
        .collect::<Vec<_>>();
    match bindings.len() {
        1 => Ok(bindings.remove(0)),
        0 => Err("missing exact receipt_v1 binding".to_owned()),
        count => Err(format!("ambiguous receipt_v1 binding:{count}")),
    }
}

fn receipt_authority_digest(
    binding: &runner::ReceiptV1RunnerBinding,
    spec: &kernel::generated::AgentRunSpecV5,
) -> Result<String, String> {
    runner::receipt_authority_digest_for_binding(binding, spec).map_err(|error| error.to_string())
}

const BLOCKED_RECEIPT_ROOT_PREFIX: &str = "blocked-latch-root:";
const BLOCKED_LATCH_EVENT_REF_PREFIX: &str = "blocked-latch-event:";
const BLOCKED_OBSERVED_REF_PREFIX: &str = "blocked-observed:";
const BLOCKED_PREPARED_TRANSACTION_SCHEMA: &str = "autopilot.blocked_prepared_transaction.v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct BlockedLatchRootV1 {
    schema: String,
    blocked_receipt_ref: Ref,
    blocked_receipt_sha256: Digest,
    latch_ref: Ref,
    latch_sha256: Digest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct BlockedObservedRefV1 {
    schema: String,
    receipt_id: kernel::generated::Uuidv7,
    latch_id: kernel::generated::Uuidv7,
    reporter_task_id: Id,
}

/// Private create-once authority for the receipt-before-latch crash window.
/// It is addressed only by the deterministic binding path, never discovered
/// by directory enumeration, and it freezes the complete cancellation set
/// before either public blocked artifact can be written.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct BlockedPreparedTransactionV1 {
    schema: String,
    receipt: BlockedReceipt,
    latch: BlockedLatch,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct LaunchAckTaskBindingV1 {
    task_id: Id,
    action_id: Id,
    assignment_id: Id,
    run_revision: u64,
}

fn validate_blocked_report(
    report: &kernel::generated::BlockedReport,
) -> Result<(), SubmitDiagnostic> {
    if report.schema.0 != "autopilot.blocked_report.v1" {
        return Err(child_control_diagnostic(
            "submit.blocked_schema",
            "/raw_payload/schema",
            "autopilot.blocked_report.v1",
            &serde_json::json!(report.schema.0),
            "Set the blocked report schema to autopilot.blocked_report.v1.",
        ));
    }
    let bounded = |value: &str, max: usize| !value.is_empty() && value.len() <= max;
    if !bounded(&report.summary, 2000) {
        return Err(child_control_diagnostic(
            "submit.blocked_summary",
            "/raw_payload/summary",
            "a nonempty summary of at most 2000 UTF-8 bytes",
            &serde_json::json!(report.summary),
            "Provide the bounded blocked-report summary.",
        ));
    }
    if !bounded(&report.last_attempted_action, 2000) {
        return Err(child_control_diagnostic(
            "submit.blocked_last_attempted_action",
            "/raw_payload/last_attempted_action",
            "a nonempty last attempted action of at most 2000 UTF-8 bytes",
            &serde_json::json!(report.last_attempted_action),
            "Provide the bounded last attempted action.",
        ));
    }
    if report.evidence.is_empty() {
        return Err(child_control_diagnostic(
            "submit.blocked_evidence",
            "/raw_payload/evidence",
            "at least one blocked evidence record",
            &serde_json::json!(report.evidence),
            "Provide at least one bounded blocked evidence record.",
        ));
    }
    for (index, evidence) in report.evidence.iter().enumerate() {
        if !bounded(&evidence.value, 4096) {
            return Err(child_control_diagnostic(
                "submit.blocked_evidence_value",
                &format!("/raw_payload/evidence/{index}/value"),
                "a nonempty evidence value of at most 4096 UTF-8 bytes",
                &serde_json::json!(evidence.value),
                "Provide the bounded evidence value.",
            ));
        }
    }
    Ok(())
}

fn blocked_admission_retry(code: &str, detail: impl Into<String>) -> SubmitDiagnostic {
    child_control_diagnostic(
        code,
        "",
        "one exact durable blocked-latch transaction",
        &serde_json::json!(detail.into()),
        "Retry through the exact issued blocked-report capability without changing an accepted report.",
    )
}

fn blocked_receipt_path(binding: &runner::ReceiptV1RunnerBinding) -> Result<PathBuf, String> {
    let root = submit_root_for_carrier(Path::new(&binding.carrier_path))?;
    let key = sha256_hex_local(
        format!(
            "blocked-receipt.v1\\0{}\\0{}\\0{}\\0{}",
            binding.run_id.0, binding.action_id.0, binding.assignment_id.0, binding.run_revision
        )
        .as_bytes(),
    );
    Ok(root.join("blocked-receipts").join(format!("{key}.json")))
}

fn blocked_latch_path(binding: &runner::ReceiptV1RunnerBinding) -> Result<PathBuf, String> {
    let root = submit_root_for_carrier(Path::new(&binding.carrier_path))?;
    let key = sha256_hex_local(
        format!(
            "blocked-latch.v1\\0{}\\0{}\\0{}\\0{}",
            binding.run_id.0, binding.action_id.0, binding.assignment_id.0, binding.run_revision
        )
        .as_bytes(),
    );
    Ok(root.join("blocked-latches").join(format!("{key}.json")))
}

fn blocked_prepared_transaction_path(
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<PathBuf, String> {
    let root = submit_root_for_carrier(Path::new(&binding.carrier_path))?;
    let key = sha256_hex_local(
        format!(
            "blocked-prepared-transaction.v1\\0{}\\0{}\\0{}\\0{}",
            binding.run_id.0, binding.action_id.0, binding.assignment_id.0, binding.run_revision
        )
        .as_bytes(),
    );
    Ok(root
        .join("blocked-prepared-transactions")
        .join(format!("{key}.json")))
}

fn read_blocked_prepared_transaction_at(
    path: &Path,
) -> Result<Option<BlockedPreparedTransactionV1>, String> {
    let Some(bytes) = runner::read_bounded_file_optional(path, BLOCKED_ARTIFACT_MAX_BYTES)
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let transaction: BlockedPreparedTransactionV1 = serde_json::from_slice(&bytes)
        .map_err(|error| format!("blocked prepared transaction JSON: {error}"))?;
    let canonical = crate::evidence::canonical_json(&transaction)
        .map_err(|error| format!("blocked prepared transaction canonical JSON: {error}"))?;
    if canonical != bytes || transaction.schema != BLOCKED_PREPARED_TRANSACTION_SCHEMA {
        return Err("blocked prepared transaction bytes/schema are not canonical".to_owned());
    }
    Ok(Some(transaction))
}

fn write_blocked_prepared_transaction(
    path: &Path,
    transaction: &BlockedPreparedTransactionV1,
) -> Result<(), String> {
    let bytes = crate::evidence::canonical_json(transaction)
        .map_err(|error| format!("blocked prepared transaction canonical JSON: {error}"))?;
    runner::write_bounded_file_create_once(path, &bytes, BLOCKED_ARTIFACT_MAX_BYTES)
        .map_err(|error| error.to_string())
}

fn read_blocked_receipt_at(path: &Path) -> Result<Option<BlockedReceipt>, String> {
    let Some(bytes) = runner::read_bounded_file_optional(path, BLOCKED_ARTIFACT_MAX_BYTES)
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let receipt: BlockedReceipt =
        serde_json::from_slice(&bytes).map_err(|error| format!("blocked receipt JSON: {error}"))?;
    let canonical = crate::evidence::canonical_json(&receipt)
        .map_err(|error| format!("blocked receipt canonical JSON: {error}"))?;
    if canonical != bytes || receipt.schema.0 != "autopilot.blocked_receipt.v1" {
        return Err("blocked receipt bytes/schema are not canonical".to_owned());
    }
    Ok(Some(receipt))
}

fn read_blocked_latch_at(path: &Path) -> Result<Option<BlockedLatch>, String> {
    let Some(bytes) = runner::read_bounded_file_optional(path, BLOCKED_ARTIFACT_MAX_BYTES)
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let latch: BlockedLatch =
        serde_json::from_slice(&bytes).map_err(|error| format!("blocked latch JSON: {error}"))?;
    let canonical = crate::evidence::canonical_json(&latch)
        .map_err(|error| format!("blocked latch canonical JSON: {error}"))?;
    if canonical != bytes || latch.schema.0 != "autopilot.blocked_latch.v1" {
        return Err("blocked latch bytes/schema are not canonical".to_owned());
    }
    Ok(Some(latch))
}

fn blocked_receipt_matches_binding(
    receipt: &BlockedReceipt,
    binding: &runner::ReceiptV1RunnerBinding,
    raw: &[u8],
) -> bool {
    receipt.schema.0 == "autopilot.blocked_receipt.v1"
        && receipt.run_id == binding.run_id
        && receipt.run_revision == binding.run_revision
        && receipt.workstream == binding.workstream
        && receipt.action_id == binding.action_id
        && receipt.assignment_id == binding.assignment_id
        && receipt.attempt == binding.attempt
        && receipt.profile_id == BLOCKED_PROFILE_ID
        && receipt.tool_name.0 == BLOCKED_TOOL_NAME
        && receipt.report_digest.0 == sha256_hex_local(raw)
        && is_lower_hex_sha256(&receipt.cancellation_set_digest.0)
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn cancellation_digest(records: &[BlockedCancellationRecord]) -> Result<Digest, String> {
    let records = records.to_vec();
    Ok(Digest(sha256_hex_local(
        &crate::evidence::canonical_json(&records)
            .map_err(|error| format!("blocked cancellations canonical JSON: {error}"))?,
    )))
}

fn validate_blocked_latch(receipt: &BlockedReceipt, latch: &BlockedLatch) -> Result<(), String> {
    if receipt.schema.0 != "autopilot.blocked_receipt.v1"
        || latch.schema.0 != "autopilot.blocked_latch.v1"
        || receipt.receipt_id.0.trim().is_empty()
        || receipt.request_id.0.trim().is_empty()
        || receipt.tool_call_id.trim().is_empty()
        || receipt.profile_id != BLOCKED_PROFILE_ID
        || receipt.tool_name.0 != BLOCKED_TOOL_NAME
        || latch.latch_id.0.trim().is_empty()
        || latch.blocked_receipt_id != receipt.receipt_id
        || latch.run_id != receipt.run_id
        || latch.run_revision != receipt.run_revision
        || latch.workstream != receipt.workstream
        || latch.cancellation_set_digest != receipt.cancellation_set_digest
        || !is_lower_hex_sha256(&receipt.report_digest.0)
        || !is_lower_hex_sha256(&receipt.cancellation_set_digest.0)
        || latch.cancellations.is_empty()
    {
        return Err("blocked receipt/latch identity drift".to_owned());
    }
    let mut task_ids = BTreeSet::new();
    let mut action_ids = BTreeSet::new();
    let mut assignment_ids = BTreeSet::new();
    let mut reporter_count = 0usize;
    for (index, cancellation) in latch.cancellations.iter().enumerate() {
        if cancellation.cancellation_index != index as u32
            || cancellation.task_id.0.trim().is_empty()
            || cancellation.action_id.0.trim().is_empty()
            || cancellation.assignment_id.0.trim().is_empty()
            || !task_ids.insert(cancellation.task_id.0.clone())
            || !action_ids.insert(cancellation.action_id.0.clone())
            || !assignment_ids.insert(cancellation.assignment_id.0.clone())
        {
            return Err("blocked cancellation identity/index drift".to_owned());
        }
        if cancellation.reporter {
            reporter_count += 1;
            if index + 1 != latch.cancellations.len()
                || cancellation.assignment_id != latch.reporter_assignment_id
                || cancellation.assignment_id != receipt.assignment_id
                || cancellation.action_id != receipt.action_id
            {
                return Err("blocked reporter ordering/identity drift".to_owned());
            }
        }
    }
    if reporter_count != 1
        || cancellation_digest(&latch.cancellations)? != latch.cancellation_set_digest
    {
        return Err("blocked cancellation reporter/digest drift".to_owned());
    }
    Ok(())
}

fn validate_blocked_prepared_transaction(
    transaction: &BlockedPreparedTransactionV1,
    binding: &runner::ReceiptV1RunnerBinding,
    raw: &[u8],
) -> Result<(), String> {
    if transaction.schema != BLOCKED_PREPARED_TRANSACTION_SCHEMA
        || !blocked_receipt_matches_binding(&transaction.receipt, binding, raw)
    {
        return Err("blocked prepared transaction receipt identity drift".to_owned());
    }
    validate_blocked_latch(&transaction.receipt, &transaction.latch)
        .map_err(|error| format!("blocked prepared transaction latch: {error}"))
}

fn exact_launch_ack_task_binding(
    event: &EventRow,
) -> Result<Option<LaunchAckTaskBindingV1>, String> {
    if event.kind.0 != "background:launch-ack" {
        return Ok(None);
    }
    if event.artifact_refs.len() != 6 {
        return Err("background launch acknowledgement ref count drift".to_owned());
    }
    let task_binding = event.artifact_refs[4]
        .0
        .strip_prefix("task-binding:")
        .ok_or_else(|| "background launch acknowledgement lacks task binding".to_owned())?;
    let parsed: LaunchAckTaskBindingV1 = serde_json::from_str(task_binding)
        .map_err(|error| format!("background launch task binding JSON: {error}"))?;
    let expected = serde_json::json!({
        "task_id": parsed.task_id,
        "action_id": parsed.action_id,
        "assignment_id": parsed.assignment_id,
        "run_revision": parsed.run_revision,
    });
    if event.artifact_refs
        != vec![
            Ref(parsed.task_id.0.clone()),
            Ref(parsed.action_id.0.clone()),
            Ref(parsed.assignment_id.0.clone()),
            Ref(parsed.run_revision.to_string()),
            Ref(format!("task-binding:{expected}")),
            Ref(format!(
                "launch-ack:{}:{}:{}",
                parsed.action_id.0, parsed.assignment_id.0, parsed.run_revision
            )),
        ]
    {
        return Err("background launch acknowledgement identity drift".to_owned());
    }
    Ok(Some(parsed))
}

fn derive_blocked_cancellations(
    state: &CoreState,
    reporter: &runner::ReceiptV1RunnerBinding,
) -> Result<Vec<BlockedCancellationRecord>, String> {
    let mut bindings = BTreeMap::new();
    for versioned in strict_versioned_runner_bindings(state)? {
        let VersionedRunnerBinding::ReceiptV1(binding) = versioned else {
            continue;
        };
        if binding.run_id != reporter.run_id || binding.workstream != reporter.workstream {
            continue;
        }
        let key = (
            binding.action_id.0.clone(),
            binding.assignment_id.0.clone(),
            binding.run_revision,
        );
        if bindings.insert(key, binding).is_some() {
            return Err("ambiguous receipt_v1 binding in blocked workstream".to_owned());
        }
    }
    let reporter_key = (
        reporter.action_id.0.clone(),
        reporter.assignment_id.0.clone(),
        reporter.run_revision,
    );
    if !bindings.contains_key(&reporter_key) {
        return Err("blocked reporter binding is absent from its durable workstream".to_owned());
    }
    let mut found = BTreeMap::<String, (runner::ReceiptV1RunnerBinding, Id)>::new();
    for event in &state.events {
        let Some(task) = exact_launch_ack_task_binding(event)? else {
            continue;
        };
        let key = (
            task.action_id.0.clone(),
            task.assignment_id.0.clone(),
            task.run_revision,
        );
        let Some(binding) = bindings.get(&key) else {
            continue;
        };
        if terminal_consumed(state, &runner::receipt_v1_validator_facade(binding)) {
            continue;
        }
        if found
            .insert(task.task_id.0.clone(), (binding.clone(), task.task_id))
            .is_some()
        {
            return Err("duplicate durable task id in blocked cancellation scope".to_owned());
        }
    }
    let mut candidates = found.into_values().collect::<Vec<_>>();
    let reporter_count = candidates
        .iter()
        .filter(|(binding, _)| {
            binding.action_id == reporter.action_id
                && binding.assignment_id == reporter.assignment_id
                && binding.run_revision == reporter.run_revision
        })
        .count();
    if reporter_count != 1 {
        return Err(
            "blocked reporter requires exactly one durable launch acknowledgement".to_owned(),
        );
    }
    candidates.sort_by(|(left_binding, left_task), (right_binding, right_task)| {
        (
            left_task.0.as_bytes(),
            left_binding.action_id.0.as_bytes(),
            left_binding.assignment_id.0.as_bytes(),
        )
            .cmp(&(
                right_task.0.as_bytes(),
                right_binding.action_id.0.as_bytes(),
                right_binding.assignment_id.0.as_bytes(),
            ))
    });
    let mut nonreporters = Vec::new();
    let mut reporter_record = None;
    for (binding, task_id) in candidates {
        let record = BlockedCancellationRecord {
            task_id,
            action_id: binding.action_id.clone(),
            assignment_id: binding.assignment_id.clone(),
            cancellation_index: 0,
            reporter: binding.action_id == reporter.action_id
                && binding.assignment_id == reporter.assignment_id
                && binding.run_revision == reporter.run_revision,
        };
        if record.reporter {
            reporter_record = Some(record);
        } else {
            nonreporters.push(record);
        }
    }
    let reporter_record = reporter_record
        .ok_or_else(|| "blocked reporter launch acknowledgement disappeared".to_owned())?;
    nonreporters.push(reporter_record);
    for (index, record) in nonreporters.iter_mut().enumerate() {
        record.cancellation_index = index as u32;
    }
    Ok(nonreporters)
}

fn validate_blocked_latch_launch_scope(
    state: &CoreState,
    receipt: &BlockedReceipt,
    latch: &BlockedLatch,
) -> Result<(), String> {
    let mut bindings = BTreeMap::new();
    for versioned in strict_versioned_runner_bindings(state)? {
        let VersionedRunnerBinding::ReceiptV1(binding) = versioned else {
            continue;
        };
        if binding.run_id == receipt.run_id && binding.workstream == receipt.workstream {
            let key = (
                binding.action_id.0.clone(),
                binding.assignment_id.0.clone(),
                binding.run_revision,
            );
            if bindings.insert(key, binding).is_some() {
                return Err("ambiguous blocked launch binding".to_owned());
            }
        }
    }
    let mut acknowledgements = BTreeMap::new();
    for event in &state.events {
        let Some(task) = exact_launch_ack_task_binding(event)? else {
            continue;
        };
        let key = (
            task.action_id.0.clone(),
            task.assignment_id.0.clone(),
            task.run_revision,
        );
        if !bindings.contains_key(&key) {
            continue;
        }
        if acknowledgements
            .insert(task.task_id.0.clone(), key)
            .is_some()
        {
            return Err("duplicate task id in durable blocked launch scope".to_owned());
        }
    }
    for cancellation in &latch.cancellations {
        let key = acknowledgements
            .get(&cancellation.task_id.0)
            .ok_or_else(|| "blocked cancellation task lacks launch acknowledgement".to_owned())?;
        if key.0 != cancellation.action_id.0 || key.1 != cancellation.assignment_id.0 {
            return Err("blocked cancellation task/binding drift".to_owned());
        }
    }
    Ok(())
}

fn authenticate_blocked_request_identity(
    request: &ChildControlRequest,
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<(), SubmitDiagnostic> {
    if !runner::constant_time_hex_digest_matches(&request.token, &binding.run_capability_digest) {
        return Err(child_control_diagnostic(
            "submit.capability",
            "/token",
            "the issued per-run capability",
            &serde_json::json!(request.token),
            "Retry through the issued child runner without changing its capability.",
        ));
    }
    if request.run_id != binding.run_id
        || request.assignment_id != binding.assignment_id
        || request.attempt != binding.attempt
        || request.profile_id != BLOCKED_PROFILE_ID
        || request.tool_name.0 != BLOCKED_TOOL_NAME
    {
        return Err(child_control_diagnostic(
            "submit.request_identity",
            "",
            "issued run, assignment, attempt, and exact blocked tool identity",
            &serde_json::json!({
                "run_id": request.run_id,
                "assignment_id": request.assignment_id,
                "attempt": request.attempt,
                "profile_id": request.profile_id,
                "tool_name": request.tool_name,
            }),
            "Resubmit through the exact generated blocked-report tool.",
        ));
    }
    Ok(())
}

fn blocked_root_for_binding(
    state: &CoreState,
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<Option<BlockedLatchRootV1>, String> {
    let receipt_path = blocked_receipt_path(binding)?.display().to_string();
    let latch_path = blocked_latch_path(binding)?.display().to_string();
    let mut roots = Vec::new();
    for event in state
        .events
        .iter()
        .filter(|event| event.kind.0 == "blocked:accepted")
    {
        let decoded = event
            .artifact_refs
            .iter()
            .map(decode_blocked_latch_root)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if decoded.len() != 1 {
            return Err("blocked accepted event lacks exactly one canonical root".to_owned());
        }
        let root = decoded.into_iter().next().expect("one checked root");
        if root.blocked_receipt_ref.0 == receipt_path || root.latch_ref.0 == latch_path {
            if root.blocked_receipt_ref.0 != receipt_path || root.latch_ref.0 != latch_path {
                return Err("blocked root deterministic path drift".to_owned());
            }
            roots.push(root);
        }
    }
    match roots.len() {
        0 => Ok(None),
        1 => Ok(roots.pop()),
        _ => Err("duplicate blocked root for deterministic binding".to_owned()),
    }
}

fn rooted_blocked_alias(
    state: &CoreState,
    binding: &runner::ReceiptV1RunnerBinding,
    raw: &[u8],
) -> Result<Option<(BlockedReceipt, BlockedLatch)>, SubmitDiagnostic> {
    let Some(root) = blocked_root_for_binding(state, binding)
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_root", error))?
    else {
        return Ok(None);
    };
    let receipt = read_blocked_receipt_at(Path::new(&root.blocked_receipt_ref.0))
        .map_err(|error| blocked_admission_retry("submit.blocked_receipt_read", error))?
        .ok_or_else(|| {
            blocked_admission_retry("submit.blocked_receipt_read", "rooted receipt is absent")
        })?;
    let latch = read_blocked_latch_at(Path::new(&root.latch_ref.0))
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_read", error))?
        .ok_or_else(|| {
            blocked_admission_retry("submit.blocked_latch_read", "rooted latch is absent")
        })?;
    if !blocked_receipt_matches_binding(&receipt, binding, raw) {
        return Err(blocked_admission_retry(
            "submit.blocked_receipt_conflict",
            "the canonical blocked report differs from the rooted receipt",
        ));
    }
    let expected_root = blocked_root(&receipt, &latch, binding)
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_root", error))?;
    if expected_root != root {
        return Err(blocked_admission_retry(
            "submit.blocked_latch_root",
            "rooted receipt/latch bytes or deterministic paths drift",
        ));
    }
    let index = blocked_accepted_root_index(state, &root)
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_root", error))?
        .ok_or_else(|| blocked_admission_retry("submit.blocked_latch_root", "root disappeared"))?;
    if blocked_event_ref_for_root(state, &root, index)
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_event_ref", error))?
        .is_none()
    {
        return Err(blocked_admission_retry(
            "submit.blocked_latch_event_ref",
            "rooted blocked transaction lacks its event reference",
        ));
    }
    validate_blocked_latch_launch_scope(state, &receipt, &latch)
        .map_err(|error| blocked_admission_retry("submit.blocked_cancellation_scope", error))?;
    validate_blocked_gate(&latch, &blocked_gate(&latch))
        .map_err(|error| blocked_admission_retry("submit.blocked_gate", error))?;
    Ok(Some((receipt, latch)))
}

fn recover_pending_blocked_transaction(
    state: &mut CoreState,
    binding: &runner::ReceiptV1RunnerBinding,
    raw: &[u8],
) -> Result<Option<(BlockedReceipt, BlockedLatch)>, SubmitDiagnostic> {
    let prepared_path = blocked_prepared_transaction_path(binding)
        .map_err(|error| blocked_admission_retry("submit.blocked_prepared_path", error))?;
    let receipt_path = blocked_receipt_path(binding)
        .map_err(|error| blocked_admission_retry("submit.blocked_receipt_path", error))?;
    let latch_path = blocked_latch_path(binding)
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_path", error))?;
    let prepared = read_blocked_prepared_transaction_at(&prepared_path)
        .map_err(|error| blocked_admission_retry("submit.blocked_prepared_read", error))?;
    let existing_receipt = read_blocked_receipt_at(&receipt_path)
        .map_err(|error| blocked_admission_retry("submit.blocked_receipt_read", error))?;
    let existing_latch = read_blocked_latch_at(&latch_path)
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_read", error))?;
    let rooted = blocked_root_for_binding(state, binding)
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_root", error))?;
    let Some(transaction) = prepared else {
        if existing_receipt.is_some() || existing_latch.is_some() || rooted.is_some() {
            return Err(blocked_admission_retry(
                "submit.blocked_recovery_required",
                "blocked artifacts lack immutable prepared cancellation authority",
            ));
        }
        return Ok(None);
    };
    validate_blocked_prepared_transaction(&transaction, binding, raw)
        .map_err(|error| blocked_admission_retry("submit.blocked_prepared", error))?;
    if let Some(existing) = existing_receipt.as_ref()
        && existing != &transaction.receipt
    {
        return Err(blocked_admission_retry(
            "submit.blocked_receipt_conflict",
            "prepared receipt drift",
        ));
    }
    if let Some(existing) = existing_latch.as_ref()
        && existing != &transaction.latch
    {
        return Err(blocked_admission_retry(
            "submit.blocked_latch_conflict",
            "prepared latch drift",
        ));
    }
    if let Some(root) = rooted.as_ref() {
        let expected = blocked_root(&transaction.receipt, &transaction.latch, binding)
            .map_err(|error| blocked_admission_retry("submit.blocked_latch_root", error))?;
        if root != &expected || existing_receipt.is_none() || existing_latch.is_none() {
            return Err(blocked_admission_retry(
                "submit.blocked_latch_root",
                "rooted transaction artifact drift",
            ));
        }
    }
    let receipt_bytes = crate::evidence::canonical_json(&transaction.receipt).map_err(|error| {
        blocked_admission_retry("submit.blocked_receipt_canonical", error.to_string())
    })?;
    runner::write_bounded_file_create_once(
        &receipt_path,
        &receipt_bytes,
        BLOCKED_ARTIFACT_MAX_BYTES,
    )
    .map_err(|error| blocked_admission_retry("submit.blocked_receipt_write", error.to_string()))?;
    let latch_bytes = crate::evidence::canonical_json(&transaction.latch).map_err(|error| {
        blocked_admission_retry("submit.blocked_latch_canonical", error.to_string())
    })?;
    runner::write_bounded_file_create_once(&latch_path, &latch_bytes, BLOCKED_ARTIFACT_MAX_BYTES)
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_write", error.to_string()))?;
    root_or_verify_blocked_latch(state, &transaction.receipt, &transaction.latch, binding)
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_root", error))?;
    state.rebuild_blocked_latches().map_err(|error| {
        blocked_admission_retry("submit.blocked_latch_replay", error.to_string())
    })?;
    Ok(Some((transaction.receipt, transaction.latch)))
}

/// Host restart can lose the original child socket after Core has fsynced the
/// prepared transaction but before publication. The prepared record is already
/// Core-owned, canonical, and semantically admitted; reconciliation may finish
/// only that immutable transaction without rereading a child payload, spec, or
/// directory. It never derives a new cancellation snapshot.
fn recover_prepared_blocked_transactions_for_reconcile(
    state: &mut CoreState,
) -> Result<(), String> {
    for versioned in strict_versioned_runner_bindings(state)? {
        let VersionedRunnerBinding::ReceiptV1(binding) = versioned else {
            continue;
        };
        let prepared_path = blocked_prepared_transaction_path(&binding)?;
        let receipt_path = blocked_receipt_path(&binding)?;
        let latch_path = blocked_latch_path(&binding)?;
        let prepared = read_blocked_prepared_transaction_at(&prepared_path)?;
        let existing_receipt = read_blocked_receipt_at(&receipt_path)?;
        let existing_latch = read_blocked_latch_at(&latch_path)?;
        let rooted = blocked_root_for_binding(state, &binding)?;
        let Some(transaction) = prepared else {
            if rooted.is_none() && (existing_receipt.is_some() || existing_latch.is_some()) {
                return Err(
                    "blocked artifacts lack immutable prepared cancellation authority".to_owned(),
                );
            }
            continue;
        };
        if transaction.schema != BLOCKED_PREPARED_TRANSACTION_SCHEMA
            || transaction.receipt.schema.0 != "autopilot.blocked_receipt.v1"
            || transaction.receipt.run_id != binding.run_id
            || transaction.receipt.run_revision != binding.run_revision
            || transaction.receipt.workstream != binding.workstream
            || transaction.receipt.action_id != binding.action_id
            || transaction.receipt.assignment_id != binding.assignment_id
            || transaction.receipt.attempt != binding.attempt
            || transaction.receipt.profile_id != BLOCKED_PROFILE_ID
            || transaction.receipt.tool_name.0 != BLOCKED_TOOL_NAME
            || !is_lower_hex_sha256(&transaction.receipt.report_digest.0)
            || !is_lower_hex_sha256(&transaction.receipt.cancellation_set_digest.0)
        {
            return Err("blocked prepared transaction receipt identity drift".to_owned());
        }
        validate_blocked_latch(&transaction.receipt, &transaction.latch)?;
        validate_blocked_latch_launch_scope(state, &transaction.receipt, &transaction.latch)?;
        if let Some(receipt) = existing_receipt.as_ref()
            && receipt != &transaction.receipt
        {
            return Err("blocked prepared receipt drift".to_owned());
        }
        if let Some(latch) = existing_latch.as_ref()
            && latch != &transaction.latch
        {
            return Err("blocked prepared latch drift".to_owned());
        }
        if let Some(root) = rooted.as_ref() {
            let expected = blocked_root(&transaction.receipt, &transaction.latch, &binding)?;
            if root != &expected || existing_receipt.is_none() || existing_latch.is_none() {
                return Err("rooted blocked prepared transaction artifact drift".to_owned());
            }
        }
        let receipt_bytes = crate::evidence::canonical_json(&transaction.receipt)
            .map_err(|error| format!("blocked prepared receipt canonical JSON: {error}"))?;
        runner::write_bounded_file_create_once(
            &receipt_path,
            &receipt_bytes,
            BLOCKED_ARTIFACT_MAX_BYTES,
        )
        .map_err(|error| error.to_string())?;
        let latch_bytes = crate::evidence::canonical_json(&transaction.latch)
            .map_err(|error| format!("blocked prepared latch canonical JSON: {error}"))?;
        runner::write_bounded_file_create_once(
            &latch_path,
            &latch_bytes,
            BLOCKED_ARTIFACT_MAX_BYTES,
        )
        .map_err(|error| error.to_string())?;
        root_or_verify_blocked_latch(state, &transaction.receipt, &transaction.latch, &binding)?;
    }
    Ok(())
}

fn admit_or_replay_blocked_latch(
    state: &mut CoreState,
    request: &ChildControlRequest,
    binding: &runner::ReceiptV1RunnerBinding,
    raw: &[u8],
    report: &kernel::generated::BlockedReport,
) -> Result<(BlockedReceipt, BlockedLatch), SubmitDiagnostic> {
    if state.blocked_projection_error().is_some() {
        return Err(blocked_admission_retry(
            "submit.blocked_projection",
            BLOCKED_PROJECTION_UNAVAILABLE,
        ));
    }
    if let Some(existing) = blocked_latch_for_workstream(state, &binding.workstream.0)
        && (existing.receipt.run_id != binding.run_id
            || existing.receipt.action_id != binding.action_id
            || existing.receipt.assignment_id != binding.assignment_id
            || existing.receipt.run_revision != binding.run_revision)
    {
        return Err(blocked_admission_retry(
            "submit.blocked_workstream_conflict",
            "this durable workstream is already latched by a different reporting binding",
        ));
    }
    let receipt_path = blocked_receipt_path(binding)
        .map_err(|error| blocked_admission_retry("submit.blocked_receipt_path", error))?;
    let latch_path = blocked_latch_path(binding)
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_path", error))?;
    let prepared_path = blocked_prepared_transaction_path(binding)
        .map_err(|error| blocked_admission_retry("submit.blocked_prepared_path", error))?;
    if read_blocked_prepared_transaction_at(&prepared_path)
        .map_err(|error| blocked_admission_retry("submit.blocked_prepared_read", error))?
        .is_some()
        || read_blocked_receipt_at(&receipt_path)
            .map_err(|error| blocked_admission_retry("submit.blocked_receipt_read", error))?
            .is_some()
        || read_blocked_latch_at(&latch_path)
            .map_err(|error| blocked_admission_retry("submit.blocked_latch_read", error))?
            .is_some()
    {
        return Err(blocked_admission_retry(
            "submit.blocked_recovery_required",
            "an existing blocked transaction must be recovered only through its immutable prepared authority",
        ));
    }

    // Freeze every cancellation identity before the receipt is visible.  A
    // restart therefore never derives a second mutable launch snapshot.
    let cancellations = derive_blocked_cancellations(state, binding)
        .map_err(|error| blocked_admission_retry("submit.blocked_cancellation_scope", error))?;
    let cancellation_set_digest = cancellation_digest(&cancellations)
        .map_err(|error| blocked_admission_retry("submit.blocked_cancellation_digest", error))?;
    let receipt = BlockedReceipt {
        schema: SchemaId("autopilot.blocked_receipt.v1".to_owned()),
        receipt_id: crate::state_root::fresh_uuid_v7().map_err(|error| {
            blocked_admission_retry("submit.blocked_receipt_id", error.to_string())
        })?,
        run_id: binding.run_id.clone(),
        run_revision: binding.run_revision,
        workstream: binding.workstream.clone(),
        action_id: binding.action_id.clone(),
        assignment_id: binding.assignment_id.clone(),
        attempt: binding.attempt,
        profile_id: BLOCKED_PROFILE_ID.to_owned(),
        tool_name: kernel::generated::ToolName(BLOCKED_TOOL_NAME.to_owned()),
        request_id: request.request_id.clone(),
        tool_call_id: request.tool_call_id.clone(),
        report_digest: Digest(sha256_hex_local(raw)),
        reason_code: report.reason_code.clone(),
        cancellation_set_digest: cancellation_set_digest.clone(),
    };
    let latch = BlockedLatch {
        schema: SchemaId("autopilot.blocked_latch.v1".to_owned()),
        latch_id: crate::state_root::fresh_uuid_v7().map_err(|error| {
            blocked_admission_retry("submit.blocked_latch_id", error.to_string())
        })?,
        blocked_receipt_id: receipt.receipt_id.clone(),
        run_id: binding.run_id.clone(),
        run_revision: binding.run_revision,
        workstream: binding.workstream.clone(),
        reporter_assignment_id: binding.assignment_id.clone(),
        cancellation_set_digest,
        cancellations,
    };
    let transaction = BlockedPreparedTransactionV1 {
        schema: BLOCKED_PREPARED_TRANSACTION_SCHEMA.to_owned(),
        receipt: receipt.clone(),
        latch: latch.clone(),
    };
    validate_blocked_prepared_transaction(&transaction, binding, raw)
        .map_err(|error| blocked_admission_retry("submit.blocked_prepared", error))?;
    write_blocked_prepared_transaction(&prepared_path, &transaction)
        .map_err(|error| blocked_admission_retry("submit.blocked_prepared_write", error))?;
    let receipt_bytes = crate::evidence::canonical_json(&receipt).map_err(|error| {
        blocked_admission_retry("submit.blocked_receipt_canonical", error.to_string())
    })?;
    runner::write_bounded_file_create_once(
        &receipt_path,
        &receipt_bytes,
        BLOCKED_ARTIFACT_MAX_BYTES,
    )
    .map_err(|error| blocked_admission_retry("submit.blocked_receipt_write", error.to_string()))?;
    let latch_bytes = crate::evidence::canonical_json(&latch).map_err(|error| {
        blocked_admission_retry("submit.blocked_latch_canonical", error.to_string())
    })?;
    runner::write_bounded_file_create_once(&latch_path, &latch_bytes, BLOCKED_ARTIFACT_MAX_BYTES)
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_write", error.to_string()))?;
    root_or_verify_blocked_latch(state, &receipt, &latch, binding)
        .map_err(|error| blocked_admission_retry("submit.blocked_latch_root", error))?;
    state.rebuild_blocked_latches().map_err(|error| {
        blocked_admission_retry("submit.blocked_latch_replay", error.to_string())
    })?;
    state
        .blocked_reporter_tool_calls
        .insert(receipt.receipt_id.0.clone(), request.tool_call_id.clone());
    Ok((receipt, latch))
}

const SUBMIT_RECEIPT_ROOT_PREFIX: &str = "submit-receipt-root:";
const SUBMIT_RECEIPT_EVENT_REF_PREFIX: &str = "submit-receipt-event:";
const SUBMIT_RECEIPT_CONSUMED_PREFIX: &str = "submit-receipt-consumed:";
const SUBMIT_RECEIPT_MAX_BYTES: usize = 2 << 20;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct SubmitReceiptRootV1 {
    schema: String,
    receipt_ref: Ref,
    receipt_sha256: Digest,
    transition_ref: Ref,
    transition_sha256: Digest,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct IssuedActionReceiptRefV1 {
    schema: String,
    action_id: Id,
    assignment_id: Id,
    run_revision: u64,
    byte_count: u64,
    sha256: Digest,
    binding_byte_count: u64,
    binding_sha256: Digest,
}

/// The receipt transition carries the exact planning event projection as a
/// separately hashed immutable artifact.  `PreparedSubmitTransitionV1` is a
/// frozen generated contract, so this closed sidecar keeps the legacy event
/// facts explicit without smuggling them through loose refs or recreating an
/// event at completion.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PreparedPlanningTransitionV1 {
    schema: String,
    event_kind: String,
    refs: Vec<Ref>,
}

const PREPARED_PLANNING_TRANSITION_SCHEMA: &str = "autopilot.prepared_planning_transition.v1";
const PLANNING_TRANSITION_KIND_REF_PREFIX: &str = "planning-transition-kind:";
/// Direct legacy rows remain readable by their exact event kind. Receipt V1
/// projects only one of these closed logical kinds through its explicit marker;
/// no consumer infers planning semantics from a ref shape.
const CLOSED_PLANNING_EVENT_KINDS: &[&str] = &[
    "agent:result",
    "planning:recovery-completed",
    "planning:recovery-required",
    "recovery:exhausted",
    "recovery:inadmissible",
    "planning:ready-to-execute",
];

fn closed_planning_event_kind(value: &str) -> Result<&'static str, String> {
    CLOSED_PLANNING_EVENT_KINDS
        .iter()
        .copied()
        .find(|known| *known == value)
        .ok_or_else(|| format!("unknown planning transition kind: {value}"))
}

fn validate_planning_transition_semantics(event_kind: &str, refs: &[Ref]) -> Result<(), String> {
    closed_planning_event_kind(event_kind)?;
    if refs.is_empty() {
        return Err("prepared planning transition has no semantic refs".to_owned());
    }
    let mut unique = BTreeSet::new();
    for reference in refs {
        if reference.0.trim().is_empty() {
            return Err("prepared planning transition has an empty semantic ref".to_owned());
        }
        if reference.0.starts_with(PLANNING_TRANSITION_KIND_REF_PREFIX) {
            return Err("prepared planning transition smuggles a marker ref".to_owned());
        }
        if !unique.insert(reference.0.as_str()) {
            return Err("prepared planning transition has duplicate semantic refs".to_owned());
        }
    }
    Ok(())
}

fn planning_transition_kind_ref(event_kind: &str) -> Result<Ref, String> {
    Ok(Ref(format!(
        "{PLANNING_TRANSITION_KIND_REF_PREFIX}{}",
        closed_planning_event_kind(event_kind)?
    )))
}

/// Decode only the structural receipt projection marker. A marker is valid
/// only on one receipt-consumed row with exactly one receipt-consumed ref.
fn receipt_projected_planning_kind(event: &EventRow) -> Result<Option<&'static str>, String> {
    let markers = event
        .artifact_refs
        .iter()
        .filter(|reference| reference.0.starts_with(PLANNING_TRANSITION_KIND_REF_PREFIX))
        .collect::<Vec<_>>();
    if markers.is_empty() {
        if event.kind.0 == "submit:receipt-consumed"
            && event
                .artifact_refs
                .iter()
                .any(|reference| reference.0.starts_with("planning-result-consumed:"))
        {
            return Err("receipt planning consumption lacks its transition marker".to_owned());
        }
        return Ok(None);
    }
    if event.kind.0 != "submit:receipt-consumed" {
        return Err("planning transition marker appears outside receipt consumption".to_owned());
    }
    let [marker] = markers.as_slice() else {
        return Err("receipt consumption has duplicate planning transition markers".to_owned());
    };
    let kind = marker
        .0
        .strip_prefix(PLANNING_TRANSITION_KIND_REF_PREFIX)
        .ok_or_else(|| "planning transition marker prefix drift".to_owned())?;
    if event
        .artifact_refs
        .iter()
        .filter(|reference| reference.0.starts_with(SUBMIT_RECEIPT_CONSUMED_PREFIX))
        .count()
        != 1
    {
        return Err("receipt planning transition lacks one receipt-consumed ref".to_owned());
    }
    if event
        .artifact_refs
        .iter()
        .filter(|reference| reference.0.starts_with("planning-result-consumed:"))
        .count()
        != 1
    {
        return Err(
            "receipt planning transition lacks one planning-result-consumed ref".to_owned(),
        );
    }
    closed_planning_event_kind(kind).map(Some)
}

fn logical_planning_event_kind(event: &EventRow) -> Result<Option<&'static str>, String> {
    if let Some(kind) = receipt_projected_planning_kind(event)? {
        return Ok(Some(kind));
    }
    if event.kind.0 == "submit:receipt-consumed" {
        return Ok(None);
    }
    Ok(CLOSED_PLANNING_EVENT_KINDS
        .iter()
        .copied()
        .find(|known| *known == event.kind.0))
}

fn submit_root_for_carrier(carrier_path: &Path) -> Result<PathBuf, String> {
    let carriers = carrier_path
        .parent()
        .ok_or_else(|| "submit carrier path has no carriers parent".to_owned())?;
    carriers
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "submit carrier path has no planning root".to_owned())
}

fn submit_receipt_path(binding: &runner::ReceiptV1RunnerBinding) -> Result<PathBuf, String> {
    let root = submit_root_for_carrier(Path::new(&binding.carrier_path))?;
    let key = sha256_hex_local(
        format!(
            "submit-receipt.v1\\0{}\\0{}\\0{}\\0{}",
            binding.run_id.0, binding.action_id.0, binding.assignment_id.0, binding.run_revision
        )
        .as_bytes(),
    );
    Ok(root.join("submit-receipts").join(format!("{key}.json")))
}

fn submit_transition_path(binding: &runner::ReceiptV1RunnerBinding) -> Result<PathBuf, String> {
    let mut path = submit_receipt_path(binding)?;
    path.set_extension("transition.json");
    Ok(path)
}

fn prepared_planning_transition_path(
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<PathBuf, String> {
    let mut path = submit_receipt_path(binding)?;
    path.set_extension("planning-transition.json");
    Ok(path)
}

fn planning_transition_artifact(
    binding: &runner::ReceiptV1RunnerBinding,
    transition: &PreparedPlanningTransitionV1,
) -> Result<(PathBuf, Vec<u8>), String> {
    if transition.schema != PREPARED_PLANNING_TRANSITION_SCHEMA {
        return Err("prepared planning transition schema drift".to_owned());
    }
    validate_planning_transition_semantics(&transition.event_kind, &transition.refs)?;
    let bytes = crate::evidence::canonical_json(transition).map_err(|error| error.to_string())?;
    Ok((prepared_planning_transition_path(binding)?, bytes))
}

fn prepared_planning_transition_from_receipt(
    receipt: &SubmitReceipt,
) -> Result<PreparedPlanningTransitionV1, String> {
    let matches = receipt
        .prepared_transition
        .artifact_refs
        .iter()
        .filter(|artifact| artifact.artifact_schema.0 == PREPARED_PLANNING_TRANSITION_SCHEMA)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err("receipt lacks exactly one prepared planning transition artifact".to_owned());
    }
    let [artifact] = matches.as_slice() else {
        return Err("receipt lacks exactly one prepared planning transition artifact".to_owned());
    };
    verify_prepared_artifact(artifact, SUBMIT_RECEIPT_MAX_BYTES)?;
    let bytes = runner::read_bounded_authority_file(
        Path::new(&artifact.artifact_ref.0),
        SUBMIT_RECEIPT_MAX_BYTES,
    )
    .map_err(|error| format!("prepared planning transition read: {error}"))?;
    let transition: PreparedPlanningTransitionV1 = serde_json::from_slice(&bytes)
        .map_err(|error| format!("prepared planning transition JSON: {error}"))?;
    let canonical = crate::evidence::canonical_json(&transition)
        .map_err(|error| format!("prepared planning transition canonical JSON: {error}"))?;
    if canonical != bytes || transition.schema != PREPARED_PLANNING_TRANSITION_SCHEMA {
        return Err("prepared planning transition semantic authority drift".to_owned());
    }
    validate_planning_transition_semantics(&transition.event_kind, &transition.refs).map_err(
        |error| format!("prepared planning transition semantic authority drift: {error}"),
    )?;
    Ok(transition)
}

fn read_submit_receipt_at(path: &Path) -> Result<Option<SubmitReceipt>, String> {
    let Some(bytes) = runner::read_bounded_file_optional(path, SUBMIT_RECEIPT_MAX_BYTES)
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let receipt: SubmitReceipt =
        serde_json::from_slice(&bytes).map_err(|error| format!("receipt JSON: {error}"))?;
    let canonical = crate::evidence::canonical_json(&receipt)
        .map_err(|error| format!("receipt canonical JSON: {error}"))?;
    if canonical != bytes {
        return Err("receipt bytes are not canonical".to_owned());
    }
    Ok(Some(receipt))
}

fn receipt_matches_binding(
    receipt: &SubmitReceipt,
    binding: &runner::ReceiptV1RunnerBinding,
) -> bool {
    receipt.schema.0 == "autopilot.submit_receipt.v1"
        && receipt.run_id == binding.run_id
        && receipt.run_revision == binding.run_revision
        && receipt.workstream == binding.workstream
        && receipt.action_id == binding.action_id
        && receipt.assignment_id == binding.assignment_id
        && receipt.attempt == binding.attempt
        && receipt.profile_id == binding.profile_id
        && receipt.tool_name == binding.tool_name
        && receipt.boundary_id == binding.boundary_id
        && receipt.result_contract == binding.result_contract
        && receipt.schema_digest.0 == binding.schema_digest
        && receipt.spec_digest.0 == binding.spec_digest
        && receipt.carrier_binding_digest.0 == binding.carrier_binding_digest
        && receipt.authority_digest.0 == binding.authority_digest
}

fn receipt_matches_request(
    receipt: &SubmitReceipt,
    binding: &runner::ReceiptV1RunnerBinding,
    raw: &[u8],
) -> bool {
    receipt_matches_binding(receipt, binding)
        && receipt.raw_payload_digest.0 == sha256_hex_local(raw)
        && receipt.raw_payload_byte_count == raw.len() as u64
}

/// One receipt V1 parent generation selects one and only one continuation
/// generation.  This is immutable binding identity, not an event/state slot.
fn receipt_v1_continuation_run_revision(
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<u64, String> {
    binding
        .run_revision
        .checked_add(1)
        .ok_or_else(|| "receipt_v1 continuation run revision overflow".to_owned())
}

fn artifact_ref(path: &Path, schema: &str, bytes: &[u8]) -> PreparedSubmitArtifactRef {
    PreparedSubmitArtifactRef {
        artifact_ref: Ref(path.display().to_string()),
        artifact_schema: SchemaId(schema.to_owned()),
        sha256: Digest(sha256_hex_local(bytes)),
        byte_count: bytes.len() as u64,
    }
}

fn staging_retry(code: &str, pointer: &str, detail: impl Into<String>) -> SubmitDiagnostic {
    child_control_diagnostic(
        code,
        pointer,
        "a complete receipt-backed planning transition",
        &serde_json::json!(detail.into()),
        "Correct the payload or retry after the issued planning authority is available.",
    )
}

fn delivery_staging_retry(
    code: &str,
    pointer: &str,
    detail: impl Into<String>,
) -> SubmitDiagnostic {
    child_control_diagnostic(
        code,
        pointer,
        "a complete receipt-backed delivery/submit transition",
        &serde_json::json!(detail.into()),
        "Correct the delivery payload or retry with the issued delivery authority.",
    )
}

fn commit_staged_submit(
    state: &mut CoreState,
    request: &ChildControlRequest,
    binding: &runner::ReceiptV1RunnerBinding,
    facade: &kernel::generated::AgentRunSpec,
    raw: &[u8],
    prepared: runner::child::PreparedCarrier,
) -> Result<SubmitReceipt, SubmitDiagnostic> {
    if binding.result_contract.0.starts_with("planning.") {
        return commit_staged_planning_submit(state, request, binding, facade, raw, prepared);
    }
    if binding.result_contract.0 == "autopilot.delivery_result.v2" {
        return commit_staged_delivery_submit(state, request, binding, facade, raw, prepared);
    }
    if matches!(
        binding.result_contract.0.as_str(),
        "autopilot.validation_result.v2" | "autopilot.validation_result.v3"
    ) {
        return commit_staged_validation_submit(state, request, binding, facade, raw, prepared);
    }
    Err(staging_retry(
        "submit.transition_staging_unavailable",
        "",
        "unsupported receipt-backed parent transition",
    ))
}

fn commit_staged_planning_submit(
    state: &mut CoreState,
    request: &ChildControlRequest,
    binding: &runner::ReceiptV1RunnerBinding,
    facade: &kernel::generated::AgentRunSpec,
    raw: &[u8],
    prepared: runner::child::PreparedCarrier,
) -> Result<SubmitReceipt, SubmitDiagnostic> {
    // Delivery and Validator parent transitions still require their separate
    // package/Git/recovery staging wave. Their child values remain unsealed
    // and therefore cannot create a carrier, receipt, event, or effect here.
    if !binding.result_contract.0.starts_with("planning.") {
        return Err(staging_retry(
            "submit.transition_staging_unavailable",
            "",
            "delivery/Validator parent transition staging is owned by Wave 2C",
        ));
    }
    let legacy = runner::receipt_v1_validator_facade(binding);
    let carrier: AgentCarrier =
        serde_json::from_value(prepared.carrier.clone()).map_err(|error| {
            staging_retry(
                "submit.carrier",
                "/raw_payload",
                format!("staged planning carrier: {error}"),
            )
        })?;
    if let Err(error) = validate_planning_binding(&carrier, &legacy) {
        return Err(staging_retry("submit.planning_binding", "", error));
    }
    if carrier.pi_version.as_deref() != Some(runner::REQUIRED_PI_VERSION) {
        return Err(staging_retry(
            "submit.pi_version_authority",
            "/pi_version",
            "the V5 package-bound Pi version is absent or drifted",
        ));
    }
    if planning_result_consumed(state, &legacy) || terminal_consumed(state, &legacy) {
        return Err(staging_retry(
            "submit.already_consumed",
            "",
            "the planning binding is already terminal or consumed",
        ));
    }
    // This guard is deliberately independent of V1/V2 shape.  Ordinary
    // compiler/synthesizer work never gains recovery authority merely because
    // a payload happens to parse as one version of a work map.
    if binding.role_id.0 != "recovery-engineer"
        && matches!(
            binding.boundary_id.0.as_str(),
            "planning.work-map.v1" | "planning.work-map.v2"
        )
    {
        // This is an authority guard, not a best-effort feature probe. A
        // malformed canonical payload must fail admission rather than being
        // mistaken for a work map with no recovery property.
        let value: serde_json::Value = serde_json::from_slice(raw).map_err(|error| {
            staging_retry(
                "submit.ordinary_recovery_guard",
                "/raw_payload",
                format!("ordinary planning recovery guard JSON: {error}"),
            )
        })?;
        let object = value.as_object().ok_or_else(|| {
            staging_retry(
                "submit.ordinary_recovery_guard",
                "/raw_payload",
                "ordinary planning recovery guard requires an object payload",
            )
        })?;
        if object.contains_key("recovery") {
            return Err(staging_retry(
                "submit.ordinary_recovery_forbidden",
                "/recovery",
                "ordinary planning work-map has recovery evidence",
            ));
        }
    }

    let carrier_bytes = crate::evidence::canonical_json(&prepared.carrier).map_err(|error| {
        staging_retry("submit.canonical_json", "/raw_payload", error.to_string())
    })?;
    let v2_admission = if binding.boundary_id.0 == "planning.work-map.v2" {
        Some(
            stage_v2_work_map_admission(state, binding, facade, &carrier_bytes)
                .map_err(|error| staging_retry("submit.v2_admission", "/raw_payload", error))?,
        )
    } else {
        validate_agent_output(&legacy, &carrier.raw_output).map_err(|error| {
            staging_retry(
                "submit.planning_boundary",
                "/raw_payload",
                boundary_status(&error),
            )
        })?;
        None
    };
    let recovery = match v2_admission.as_ref() {
        Some(admitted) => match admitted.recovery_disposition() {
            Some(
                disposition @ (kernel::generated::RecoveryDisposition::RequiresNewAuthority
                | kernel::generated::RecoveryDisposition::InfrastructureBlocked
                | kernel::generated::RecoveryDisposition::UnsafeBlocked),
            ) => PlanningRecoveryAdmission::FailClosed(disposition.clone()),
            _ => PlanningRecoveryAdmission::Continue,
        },
        None => validate_recovery_work_map(&carrier, &legacy)
            .map_err(|error| staging_retry("submit.planning_recovery", "/recovery", error))?,
    };
    let semantic =
        stage_planning_semantics(state, &legacy, &carrier, v2_admission.as_ref(), recovery)
            .map_err(|(pointer, error)| {
                staging_retry("submit.planning_transition", &pointer, error)
            })?;
    let carrier_path = PathBuf::from(&binding.carrier_path);
    let mut staged_artifacts = Vec::<(PathBuf, String, Vec<u8>)>::new();
    for artifact in prepared.artifacts {
        match artifact {
            runner::child::PreparedArtifact::JsonNew { path, value } => {
                let bytes = crate::evidence::canonical_json(&value).map_err(|error| {
                    staging_retry("submit.canonical_json", "", error.to_string())
                })?;
                staged_artifacts.push((
                    PathBuf::from(path),
                    "autopilot.staged_submit_artifact.v1".to_owned(),
                    bytes,
                ));
            }
            runner::child::PreparedArtifact::ExactBytes { path, bytes } => {
                staged_artifacts.push((
                    path,
                    "autopilot.staged_submit_artifact.v1".to_owned(),
                    bytes,
                ));
            }
        }
    }

    staged_artifacts.extend(semantic.artifacts.clone());
    let planning_sidecar = PreparedPlanningTransitionV1 {
        schema: PREPARED_PLANNING_TRANSITION_SCHEMA.to_owned(),
        event_kind: semantic.event_kind.clone(),
        refs: semantic.refs.clone(),
    };
    let (planning_sidecar_path, planning_sidecar_bytes) =
        planning_transition_artifact(binding, &planning_sidecar)
            .map_err(|detail| staging_retry("submit.planning_transition", "", detail))?;
    staged_artifacts.push((
        planning_sidecar_path,
        PREPARED_PLANNING_TRANSITION_SCHEMA.to_owned(),
        planning_sidecar_bytes,
    ));
    let continuation_run_revision = receipt_v1_continuation_run_revision(binding)
        .map_err(|detail| staging_retry("submit.planning_transition", "", detail))?;
    let staged_effect = staged_planning_effect(
        state,
        &legacy,
        &carrier,
        &carrier_bytes,
        &semantic.event_kind,
        &semantic.refs,
        continuation_run_revision,
    )
    .map_err(|detail| staging_retry("submit.planning_transition", "", detail))?;
    staged_artifacts.extend(staged_effect.artifacts.clone());
    let effect = staged_effect.effect;
    let issues = staged_effect.issues;
    let issued_actions = issues
        .iter()
        .map(|issue| {
            let binding_ref = runner::receipt_binding_ref(&issue.receipt_binding)
                .map_err(|error| staging_retry("submit.issued_binding", "", error.to_string()))?;
            let binding_bytes = crate::evidence::canonical_json(&issue.receipt_binding)
                .map_err(|error| staging_retry("submit.canonical_json", "", error.to_string()))?;
            Ok(PreparedSubmitIssuedAction {
                action_ref: issued_action_ref(&issue.action, &issue.receipt_binding)
                    .map_err(|error| staging_retry("submit.issued_action", "", error))?,
                action: issue.action.clone(),
                binding_ref,
                binding_digest: Digest(sha256_hex_local(&binding_bytes)),
            })
        })
        .collect::<Result<Vec<_>, SubmitDiagnostic>>()?;
    let carrier_schema = prepared.carrier["schema"].as_str().ok_or_else(|| {
        staging_retry(
            "submit.carrier",
            "/schema",
            "staged carrier schema is missing",
        )
    })?;
    let carrier_artifact = artifact_ref(&carrier_path, carrier_schema, &carrier_bytes);
    let artifact_refs = staged_artifacts
        .iter()
        .map(|(path, schema, bytes)| artifact_ref(path, schema, bytes))
        .collect::<Vec<_>>();
    let transition_path = submit_transition_path(binding)
        .map_err(|error| staging_retry("submit.transition_path", "", error))?;
    let transition_ref = Ref(transition_path.display().to_string());
    let transition_body = serde_json::json!({
        "schema": "autopilot.prepared_submit_transition_body.v1",
        "carrier": carrier_artifact,
        "artifact_refs": artifact_refs,
        "issued_actions": issued_actions,
        "deferred_host_effect": effect,
    });
    let transition_bytes = crate::evidence::canonical_json(&transition_body)
        .map_err(|error| staging_retry("submit.canonical_json", "", error.to_string()))?;
    let transition = PreparedSubmitTransitionV1 {
        schema: SchemaId("autopilot.prepared_submit_transition.v1".to_owned()),
        transition_ref,
        transition_digest: Digest(sha256_hex_local(&transition_bytes)),
        carrier: carrier_artifact,
        artifact_refs,
        issued_actions,
        deferred_host_effect: effect,
    };
    let receipt = SubmitReceipt {
        schema: SchemaId("autopilot.submit_receipt.v1".to_owned()),
        receipt_id: crate::state_root::fresh_uuid_v7()
            .map_err(|error| staging_retry("submit.receipt_id", "", error.to_string()))?,
        run_id: binding.run_id.clone(),
        run_revision: binding.run_revision,
        workstream: binding.workstream.clone(),
        action_id: binding.action_id.clone(),
        assignment_id: binding.assignment_id.clone(),
        attempt: binding.attempt,
        profile_id: binding.profile_id.clone(),
        tool_name: binding.tool_name.clone(),
        boundary_id: binding.boundary_id.clone(),
        result_contract: binding.result_contract.clone(),
        schema_digest: Digest(binding.schema_digest.clone()),
        spec_digest: Digest(binding.spec_digest.clone()),
        carrier_binding_digest: Digest(binding.carrier_binding_digest.clone()),
        authority_digest: Digest(binding.authority_digest.clone()),
        frozen_validator_versions: vec![SubmitReceiptValidatorVersion {
            validator_id: Id("planning-parent-stage".to_owned()),
            version: "v1".to_owned(),
            digest: Digest(sha256_hex_local(b"planning-parent-stage:v1")),
        }],
        raw_payload_digest: Digest(sha256_hex_local(raw)),
        raw_payload_byte_count: raw.len() as u64,
        request_id: request.request_id.clone(),
        tool_call_id: request.tool_call_id.clone(),
        prepared_transition: transition,
    };
    let receipt_bytes = crate::evidence::canonical_json(&receipt)
        .map_err(|error| staging_retry("submit.canonical_json", "", error.to_string()))?;

    // All predicates above succeeded. Publish immutable artifacts, then the
    // receipt, then the sole event root. A crash before the event leaves only
    // exact create-once orphans, which an exact replay roots idempotently.
    runner::write_bounded_file_create_once(
        &carrier_path,
        &carrier_bytes,
        MAX_TERMINAL_CARRIER_BYTES,
    )
    .map_err(|error| staging_retry("submit.carrier_write", "", error.to_string()))?;
    for (path, _, bytes) in &staged_artifacts {
        runner::write_bounded_file_create_once(path, bytes, SUBMIT_RECEIPT_MAX_BYTES)
            .map_err(|error| staging_retry("submit.artifact_write", "", error.to_string()))?;
    }
    runner::write_bounded_file_create_once(
        &transition_path,
        &transition_bytes,
        SUBMIT_RECEIPT_MAX_BYTES,
    )
    .map_err(|error| staging_retry("submit.transition_write", "", error.to_string()))?;
    runner::write_bounded_file_create_once(
        &submit_receipt_path(binding)
            .map_err(|error| staging_retry("submit.receipt_path", "", error))?,
        &receipt_bytes,
        SUBMIT_RECEIPT_MAX_BYTES,
    )
    .map_err(|error| staging_retry("submit.receipt_write", "", error.to_string()))?;
    root_or_verify_submit_receipt(state, &receipt, binding)
        .map_err(|detail| staging_retry("submit.receipt_root", "", detail))?;
    Ok(receipt)
}

const PREPARED_DELIVERY_TRANSITION_SCHEMA: &str = "autopilot.prepared_delivery_transition.v1";
const PREPARED_VALIDATION_TRANSITION_SCHEMA: &str = "autopilot.prepared_validation_transition.v1";
const PREPARED_VALIDATION_INTEGRATION_SCHEMA: &str = "autopilot.prepared_validation_integration.v1";
const VALIDATION_TRANSITION_KIND_REF_PREFIX: &str = "validation-transition-kind:";
const CLOSED_VALIDATION_TRANSITION_KINDS: &[&str] = &[
    "integration:forward-integrated",
    "validation:recovery-required",
    "recovery:exhausted",
    "recovery:inadmissible",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PreparedValidationTransitionV1 {
    schema: String,
    event_kind: String,
    refs: Vec<Ref>,
    #[serde(skip_serializing_if = "Option::is_none")]
    finalization: Option<PreparedValidationFinalizationV1>,
}

/// Exact final-close facts sealed with the validation receipt. This is not a
/// presentation status: it is the immutable publication/result-ref authority
/// that makes a crash after publication and before the receipt replay-safe.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PreparedValidationFinalizationV1 {
    schema: String,
    workstream: String,
    run_id: String,
    tip: String,
    tree: String,
    revision: u64,
    final_evidence_digest: String,
    gate_digest: String,
    result_ref: String,
    close_signal: String,
}
const PREPARED_VALIDATION_FINALIZATION_SCHEMA: &str =
    "autopilot.prepared_validation_finalization.v1";

/// The candidate plan is persisted before its single CAS. It gives a retry
/// after a crash-between-CAS-and-receipt one exact old/new ref pair to prove,
/// rather than asking Git to create a second integration.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PreparedValidationIntegrationV1 {
    schema: String,
    run_main_ref: String,
    candidate_id: String,
    candidate_tip: String,
    old_tip: String,
    new_tip: String,
    tree: String,
    changed_paths: Vec<String>,
}
const DELIVERY_TRANSITION_KIND_REF_PREFIX: &str = "delivery-transition-kind:";
const CLOSED_DELIVERY_TRANSITION_KINDS: &[&str] = &[
    "agent:delivery-accepted",
    "delivery:recovery-required",
    "recovery:inadmissible",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PreparedDeliveryTransitionV1 {
    schema: String,
    event_kind: String,
    refs: Vec<Ref>,
}

#[derive(Clone)]
struct StagedDeliverySemantics {
    event_kind: String,
    refs: Vec<Ref>,
    effect: DeferredHostEffectV1,
    issues: Vec<runner::IssuedRunnerAction>,
    artifacts: Vec<(PathBuf, String, Vec<u8>)>,
}

fn delivery_transition_kind_ref(event_kind: &str) -> Result<Ref, String> {
    if !CLOSED_DELIVERY_TRANSITION_KINDS.contains(&event_kind) {
        return Err(format!("unknown delivery transition kind: {event_kind}"));
    }
    Ok(Ref(format!(
        "{DELIVERY_TRANSITION_KIND_REF_PREFIX}{event_kind}"
    )))
}

fn validate_delivery_transition(transition: &PreparedDeliveryTransitionV1) -> Result<(), String> {
    if transition.schema != PREPARED_DELIVERY_TRANSITION_SCHEMA
        || !CLOSED_DELIVERY_TRANSITION_KINDS.contains(&transition.event_kind.as_str())
        || transition.refs.is_empty()
        || transition.refs.iter().any(|reference| {
            reference.0.trim().is_empty()
                || reference.0.starts_with(DELIVERY_TRANSITION_KIND_REF_PREFIX)
        })
    {
        return Err("prepared delivery transition semantic authority drift".to_owned());
    }
    let unique = transition
        .refs
        .iter()
        .map(|reference| reference.0.as_str())
        .collect::<BTreeSet<_>>();
    if unique.len() != transition.refs.len() {
        return Err("prepared delivery transition has duplicate semantic refs".to_owned());
    }
    Ok(())
}

fn prepared_delivery_transition_path(
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<PathBuf, String> {
    let mut path = submit_receipt_path(binding)?;
    path.set_extension("delivery-transition.json");
    Ok(path)
}

fn prepared_delivery_transition_from_receipt(
    receipt: &SubmitReceipt,
) -> Result<PreparedDeliveryTransitionV1, String> {
    let artifacts = receipt
        .prepared_transition
        .artifact_refs
        .iter()
        .filter(|artifact| artifact.artifact_schema.0 == PREPARED_DELIVERY_TRANSITION_SCHEMA)
        .collect::<Vec<_>>();
    let [artifact] = artifacts.as_slice() else {
        return Err("receipt lacks exactly one prepared delivery transition artifact".to_owned());
    };
    let bytes = runner::read_bounded_authority_file(
        Path::new(&artifact.artifact_ref.0),
        SUBMIT_RECEIPT_MAX_BYTES,
    )
    .map_err(|error| format!("prepared delivery transition read: {error}"))?;
    if bytes.len() != artifact.byte_count as usize || sha256_hex_local(&bytes) != artifact.sha256.0
    {
        return Err("prepared delivery transition byte authority drift".to_owned());
    }
    let transition: PreparedDeliveryTransitionV1 = serde_json::from_slice(&bytes)
        .map_err(|error| format!("prepared delivery transition JSON: {error}"))?;
    if crate::evidence::canonical_json(&transition).map_err(|error| error.to_string())? != bytes {
        return Err("prepared delivery transition bytes are not canonical".to_owned());
    }
    validate_delivery_transition(&transition)?;
    Ok(transition)
}

fn validation_transition_kind_ref(event_kind: &str) -> Result<Ref, String> {
    if !CLOSED_VALIDATION_TRANSITION_KINDS.contains(&event_kind) {
        return Err(format!("unknown validation transition kind: {event_kind}"));
    }
    Ok(Ref(format!(
        "{VALIDATION_TRANSITION_KIND_REF_PREFIX}{event_kind}"
    )))
}

fn validate_validation_transition(
    transition: &PreparedValidationTransitionV1,
) -> Result<(), String> {
    if transition.schema != PREPARED_VALIDATION_TRANSITION_SCHEMA
        || !CLOSED_VALIDATION_TRANSITION_KINDS.contains(&transition.event_kind.as_str())
        || transition.refs.is_empty()
        || transition.refs.iter().any(|reference| {
            reference.0.trim().is_empty()
                || reference
                    .0
                    .starts_with(VALIDATION_TRANSITION_KIND_REF_PREFIX)
        })
    {
        return Err("prepared validation transition semantic authority drift".to_owned());
    }
    let unique = transition
        .refs
        .iter()
        .map(|reference| reference.0.as_str())
        .collect::<BTreeSet<_>>();
    if unique.len() != transition.refs.len() {
        return Err("prepared validation transition has duplicate semantic refs".to_owned());
    }
    if let Some(finalization) = &transition.finalization {
        validate_validation_finalization(finalization)?;
        if transition.event_kind != "integration:forward-integrated"
            || !validation_finalization_refs(finalization)
                .iter()
                .all(|reference| transition.refs.contains(reference))
        {
            return Err("prepared validation final-close refs drift".to_owned());
        }
    }
    Ok(())
}

fn prepared_validation_transition_path(
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<PathBuf, String> {
    let mut path = submit_receipt_path(binding)?;
    path.set_extension("validation-transition.json");
    Ok(path)
}

fn prepared_validation_integration_path(
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<PathBuf, String> {
    let mut path = submit_receipt_path(binding)?;
    path.set_extension("validation-integration.json");
    Ok(path)
}

fn prepared_validation_finalization_path(
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<PathBuf, String> {
    let mut path = submit_receipt_path(binding)?;
    path.set_extension("validation-finalization.json");
    Ok(path)
}

fn validation_finalization_refs(finalization: &PreparedValidationFinalizationV1) -> Vec<Ref> {
    vec![
        Ref(format!(
            "lifecycle:ExecutionComplete:{}:{}",
            finalization.workstream, finalization.run_id
        )),
        Ref(format!(
            "lifecycle:Finalizing:{}:{}",
            finalization.workstream, finalization.run_id
        )),
        Ref(format!("final-commands-pass:{}", finalization.tip)),
        Ref(format!("full-suite-pass:{}", finalization.tip)),
        Ref(format!("final-validator-pass:{}", finalization.tip)),
        Ref(format!("final-evidence-run:{}", finalization.run_id)),
        Ref(format!(
            "final-evidence-digest:{}",
            finalization.final_evidence_digest
        )),
        Ref(format!(
            "lifecycle:Publishing:{}:{}",
            finalization.workstream, finalization.run_id
        )),
        Ref(finalization.gate_digest.clone()),
        Ref(format!(
            "lifecycle:Closed:{}:{}",
            finalization.workstream, finalization.run_id
        )),
        Ref(finalization.workstream.clone()),
        Ref(finalization.run_id.clone()),
        Ref(finalization.result_ref.clone()),
        Ref(finalization.tip.clone()),
        Ref("module-wired:finalize".to_owned()),
    ]
}

fn validate_validation_finalization(
    finalization: &PreparedValidationFinalizationV1,
) -> Result<(), String> {
    if finalization.schema != PREPARED_VALIDATION_FINALIZATION_SCHEMA
        || finalization.workstream.trim().is_empty()
        || finalization.run_id.trim().is_empty()
        || !is_git_oid(&finalization.tip)
        || !is_git_oid(&finalization.tree)
        || finalization.result_ref.trim().is_empty()
        || finalization.close_signal != exact_close_signal(&finalization.result_ref)
    {
        return Err("prepared validation finalization identity drift".to_owned());
    }
    let expected_evidence = sha256_hex_local(
        format!(
            "{}\n{}\n{}\n{}\n{}",
            finalization.workstream,
            finalization.run_id,
            finalization.tip,
            finalization.tree,
            finalization.revision
        )
        .as_bytes(),
    );
    let expected_gate = sha256_hex_local(
        format!(
            "{}\n{}\n{}\n{}\n{}",
            finalization.workstream,
            finalization.run_id,
            finalization.tip,
            finalization.tree,
            expected_evidence
        )
        .as_bytes(),
    );
    if finalization.final_evidence_digest != expected_evidence
        || finalization.gate_digest != expected_gate
    {
        return Err("prepared validation finalization digest authority drift".to_owned());
    }
    Ok(())
}

fn read_prepared_validation_finalization(
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<Option<(PreparedValidationFinalizationV1, PathBuf, Vec<u8>)>, String> {
    let path = prepared_validation_finalization_path(binding)?;
    let Some(bytes) = runner::read_bounded_file_optional(&path, SUBMIT_RECEIPT_MAX_BYTES)
        .map_err(|error| format!("prepared validation finalization read: {error}"))?
    else {
        return Ok(None);
    };
    let finalization: PreparedValidationFinalizationV1 = serde_json::from_slice(&bytes)
        .map_err(|error| format!("prepared validation finalization JSON: {error}"))?;
    if crate::evidence::canonical_json(&finalization).map_err(|error| error.to_string())? != bytes {
        return Err("prepared validation finalization canonical bytes drift".to_owned());
    }
    validate_validation_finalization(&finalization)?;
    Ok(Some((finalization, path, bytes)))
}

fn persist_prepared_validation_finalization(
    binding: &runner::ReceiptV1RunnerBinding,
    finalization: &PreparedValidationFinalizationV1,
) -> Result<(PathBuf, String, Vec<u8>), String> {
    validate_validation_finalization(finalization)?;
    let path = prepared_validation_finalization_path(binding)?;
    let bytes = crate::evidence::canonical_json(finalization).map_err(|error| error.to_string())?;
    runner::write_bounded_file_create_once(&path, &bytes, SUBMIT_RECEIPT_MAX_BYTES)
        .map_err(|error| format!("prepared validation finalization write: {error}"))?;
    Ok((
        path,
        PREPARED_VALIDATION_FINALIZATION_SCHEMA.to_owned(),
        bytes,
    ))
}

fn prepared_validation_transition_from_receipt(
    receipt: &SubmitReceipt,
) -> Result<PreparedValidationTransitionV1, String> {
    let artifacts = receipt
        .prepared_transition
        .artifact_refs
        .iter()
        .filter(|artifact| artifact.artifact_schema.0 == PREPARED_VALIDATION_TRANSITION_SCHEMA)
        .collect::<Vec<_>>();
    let [artifact] = artifacts.as_slice() else {
        return Err("receipt lacks exactly one prepared validation transition artifact".to_owned());
    };
    verify_prepared_artifact(artifact, SUBMIT_RECEIPT_MAX_BYTES)?;
    let bytes = runner::read_bounded_authority_file(
        Path::new(&artifact.artifact_ref.0),
        SUBMIT_RECEIPT_MAX_BYTES,
    )
    .map_err(|error| format!("prepared validation transition read: {error}"))?;
    let transition: PreparedValidationTransitionV1 = serde_json::from_slice(&bytes)
        .map_err(|error| format!("prepared validation transition JSON: {error}"))?;
    if crate::evidence::canonical_json(&transition).map_err(|error| error.to_string())? != bytes {
        return Err("prepared validation transition canonical bytes drift".to_owned());
    }
    validate_validation_transition(&transition)?;
    Ok(transition)
}

fn prepared_artifact_bytes(
    artifact: &runner::child::PreparedArtifact,
) -> Result<(PathBuf, Vec<u8>), String> {
    match artifact {
        runner::child::PreparedArtifact::JsonNew { path, value } => Ok((
            PathBuf::from(path),
            serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?,
        )),
        runner::child::PreparedArtifact::ExactBytes { path, bytes } => {
            Ok((path.clone(), bytes.clone()))
        }
    }
}

fn staged_delivery_runtime_evidence(
    runtime_evidence: &ChildControlRuntimeEvidence,
    facts: &ValidatedDeliveryFacts,
) -> Result<(), String> {
    let denials = runtime_evidence
        .delivery_policy_denials
        .0
        .as_ref()
        .ok_or_else(|| "fresh delivery runtime denial ledger is absent".to_owned())?;
    let executions = runtime_evidence
        .approved_command_executions
        .0
        .as_ref()
        .ok_or_else(|| "fresh delivery runtime execution ledger is absent".to_owned())?;
    let denials: runner::child::DeliveryPolicyDenialLedger =
        serde_json::from_value(serde_json::to_value(denials).map_err(|error| error.to_string())?)
            .map_err(|error| format!("fresh delivery runtime denial ledger shape: {error}"))?;
    let executions: runner::child::ApprovedCommandExecutionLedger = serde_json::from_value(
        serde_json::to_value(executions).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("fresh delivery runtime execution ledger shape: {error}"))?;
    if denials != facts.denial_ledger || executions != facts.command_execution_ledger {
        return Err("fresh delivery runtime ledgers do not exactly bind staged audit".to_owned());
    }
    Ok(())
}

fn staged_delivery_transcript(
    binding: &runner::IssuedRunnerBinding,
    carrier_bytes: &[u8],
) -> Result<(PathBuf, String, Vec<u8>), String> {
    let runtime = runner::role_runtime(&binding.role_id.0).map_err(|error| error.to_string())?;
    let raw_output = String::from_utf8(carrier_bytes.to_vec())
        .map_err(|error| format!("delivery transcript UTF-8: {error}"))?;
    let record = crate::transcript::TranscriptRecord::real(
        binding.result_contract.0.clone(),
        raw_output,
        crate::transcript::TranscriptProvenance {
            provider: runtime.provider,
            model: runtime.model,
            thinking: runtime.thinking,
            session_id: safe_ref_component(&binding.action_id.0),
        },
    );
    record
        .validate_real()
        .map_err(|error| format!("delivery transcript: {error:?}"))?;
    let key = sha256_hex_local(
        format!(
            "delivery-transcript.v1\\0{}\\0{}\\0{}",
            binding.action_id.0, binding.assignment_id.0, binding.run_revision
        )
        .as_bytes(),
    );
    let path = std::env::current_dir()
        .map_err(|error| error.to_string())?
        .join(workstream_dir(&binding.workstream.0))
        .join("transcripts")
        .join(format!("receipt-delivery-{key}.json"));
    let bytes = crate::evidence::canonical_json(&record).map_err(|error| error.to_string())?;
    Ok((path, "autopilot.transcript.v1".to_owned(), bytes))
}

fn staged_validation_transcript(
    binding: &runner::IssuedRunnerBinding,
    carrier_bytes: &[u8],
) -> Result<(PathBuf, String, Vec<u8>), String> {
    let runtime = runner::role_runtime(&binding.role_id.0).map_err(|error| error.to_string())?;
    let raw_output = String::from_utf8(carrier_bytes.to_vec())
        .map_err(|error| format!("validation transcript UTF-8: {error}"))?;
    let record = crate::transcript::TranscriptRecord::real(
        binding.result_contract.0.clone(),
        raw_output,
        crate::transcript::TranscriptProvenance {
            provider: runtime.provider,
            model: runtime.model,
            thinking: runtime.thinking,
            session_id: safe_ref_component(&binding.action_id.0),
        },
    );
    record
        .validate_real()
        .map_err(|error| format!("validation transcript: {error:?}"))?;
    let key = sha256_hex_local(
        format!(
            "validation-transcript.v1\0{}\0{}\0{}",
            binding.action_id.0, binding.assignment_id.0, binding.run_revision
        )
        .as_bytes(),
    );
    let path = std::env::current_dir()
        .map_err(|error| error.to_string())?
        .join(workstream_dir(&binding.workstream.0))
        .join("transcripts")
        .join(format!("receipt-validation-{key}.json"));
    let bytes = crate::evidence::canonical_json(&record).map_err(|error| error.to_string())?;
    Ok((path, "autopilot.transcript.v1".to_owned(), bytes))
}

/// Read the exact immutable common issuance artifacts before a parent receipt
/// can name them.  This is deliberately role-agnostic only for the shared
/// V5 transport; package assignment interpretation remains the explicit
/// role/profile branch below.
fn staged_issue_common_artifacts(
    issue: &runner::IssuedRunnerAction,
) -> Result<
    (
        kernel::generated::AgentRunSpecV5,
        Vec<(PathBuf, String, Vec<u8>)>,
    ),
    String,
> {
    let binding = &issue.receipt_binding;
    runner::receipt_binding_ref(binding)
        .map_err(|error| format!("fresh issued receipt binding shape: {error}"))?;
    if issue.action.action_id != binding.action_id
        || issue.action.assignment_id != binding.assignment_id
        || issue.action.run_revision != binding.run_revision
        || issue.binding != runner::receipt_v1_validator_facade(binding)
    {
        return Err("fresh issued action/receipt binding identity drift".to_owned());
    }

    let prompt_bytes = runner::read_bounded_authority_file(
        Path::new(&binding.prompt_path),
        runner::child::MAX_RENDERED_PROMPT_BYTES,
    )
    .map_err(|error| format!("fresh issued prompt read: {error}"))?;
    if sha256_hex_local(&prompt_bytes) != binding.prompt_digest {
        return Err("fresh issued prompt digest drift".to_owned());
    }
    let spec_bytes = runner::read_bounded_authority_file(
        Path::new(&binding.spec_path),
        runner::child::MAX_AGENT_RUN_SPEC_BYTES,
    )
    .map_err(|error| format!("fresh issued spec read: {error}"))?;
    if sha256_hex_local(&spec_bytes) != binding.spec_digest {
        return Err("fresh issued spec digest drift".to_owned());
    }
    let spec: kernel::generated::AgentRunSpecV5 = serde_json::from_slice(&spec_bytes)
        .map_err(|error| format!("fresh issued V5 spec JSON: {error}"))?;
    if serde_json::to_vec_pretty(&spec).map_err(|error| error.to_string())? != spec_bytes {
        return Err("fresh issued V5 spec bytes are not canonical".to_owned());
    }
    runner::validate_receipt_v1_spec(binding, &spec)
        .map_err(|error| format!("fresh issued V5 spec/binding authority: {error}"))?;
    Ok((
        spec,
        vec![
            (
                PathBuf::from(&binding.prompt_path),
                "autopilot.rendered_prompt.v1".to_owned(),
                prompt_bytes,
            ),
            (
                PathBuf::from(&binding.spec_path),
                "autopilot.agent_run_spec.v5".to_owned(),
                spec_bytes,
            ),
        ],
    ))
}

fn staged_validator_issue_artifacts(
    issue: &runner::IssuedRunnerAction,
) -> Result<Vec<(PathBuf, String, Vec<u8>)>, String> {
    let binding = &issue.receipt_binding;
    if binding.role_id.0 != "validator"
        || binding.profile_id != "validation-status.v3"
        || binding.tool_name.0 != "autopilot_emit_status"
        || binding.boundary_id.0 != "autopilot.validation_submission.v3"
        || binding.result_contract.0 != "autopilot.validation_result.v3"
    {
        return Err("fresh Validator issue role/profile authority drift".to_owned());
    }
    let (spec, mut rows) = staged_issue_common_artifacts(issue)?;
    if !matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Validation
    ) || spec.assignment_path.as_ref().map(|path| path.0.as_str())
        != binding.assignment_path.as_deref()
        || spec
            .assignment_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != binding.assignment_digest.as_deref()
    {
        return Err("fresh Validator V5 package binding drift".to_owned());
    }
    let assignment_path = binding
        .assignment_path
        .as_ref()
        .ok_or_else(|| "fresh Validator issue lacks assignment path".to_owned())?;
    let assignment_digest = binding
        .assignment_digest
        .as_ref()
        .ok_or_else(|| "fresh Validator issue lacks assignment digest".to_owned())?;
    let assignment_bytes = runner::read_bounded_authority_file(
        Path::new(assignment_path),
        kernel::generated::VALIDATION_ASSIGNMENT_V4_MAX_BYTES,
    )
    .map_err(|error| format!("fresh Validator V4 assignment read: {error}"))?;
    if sha256_hex_local(&assignment_bytes) != *assignment_digest {
        return Err("fresh Validator V4 assignment digest drift".to_owned());
    }
    let assignment: kernel::generated::ValidationAssignmentV4 =
        serde_json::from_slice(&assignment_bytes)
            .map_err(|error| format!("fresh Validator V4 assignment JSON: {error}"))?;
    if serde_json::to_vec_pretty(&assignment).map_err(|error| error.to_string())?
        != assignment_bytes
        || assignment.schema.0 != "autopilot.validation_assignment.v4"
        || assignment.admission_mode != kernel::generated::AdmissionMode::ReceiptV1
        || assignment.validation_id.0.trim().is_empty()
        || assignment.workstream != binding.workstream
        || assignment.role_id != binding.role_id
        || assignment.mode != binding.mode
        || assignment.assignment_id != binding.assignment_id
        || assignment.action_id != binding.action_id
        || assignment.run_revision != binding.run_revision
        || assignment.candidate_root != spec.cwd
    {
        return Err("fresh Validator V4 assignment/binding identity drift".to_owned());
    }
    rows.push((
        PathBuf::from(assignment_path),
        "autopilot.validation_assignment.v4".to_owned(),
        assignment_bytes,
    ));

    let context_bytes = runner::read_bounded_authority_file(
        Path::new(&assignment.context_path.0),
        MAX_VALIDATION_BOUND_ARTIFACT_BYTES,
    )
    .map_err(|error| format!("fresh Validator context read: {error}"))?;
    if sha256_hex_local(&context_bytes) != assignment.context_digest.0 {
        return Err("fresh Validator context digest drift".to_owned());
    }
    let context: kernel::generated::ValidationContextV3 = serde_json::from_slice(&context_bytes)
        .map_err(|error| format!("fresh Validator V3 context JSON: {error}"))?;
    if serde_json::to_vec_pretty(&context).map_err(|error| error.to_string())? != context_bytes
        || context.schema.0 != "autopilot.validation_context.v3"
        || context.validation_id != assignment.validation_id
        || context.assignment_id != assignment.assignment_id
        || context.authority_digest != assignment.authority_digest
    {
        return Err("fresh Validator V3 context identity/digest drift".to_owned());
    }
    rows.push((
        PathBuf::from(&assignment.context_path.0),
        "autopilot.validation_context.v3".to_owned(),
        context_bytes,
    ));

    let authority_bytes = runner::read_bounded_authority_file(
        Path::new(&assignment.authority_path.0),
        MAX_VALIDATION_BOUND_ARTIFACT_BYTES,
    )
    .map_err(|error| format!("fresh Validator authority read: {error}"))?;
    let authority_value: serde_json::Value = serde_json::from_slice(&authority_bytes)
        .map_err(|error| format!("fresh Validator authority JSON: {error}"))?;
    let authority: kernel::generated::ValidationEvidenceAuthority =
        serde_json::from_value(authority_value.clone())
            .map_err(|error| format!("fresh Validator authority shape: {error}"))?;
    if serde_json::to_vec_pretty(&authority_value).map_err(|error| error.to_string())?
        != authority_bytes
        || authority.schema.0 != "autopilot.validation_evidence_authority.v1"
        || authority.validation_id != assignment.validation_id
        || authority.assignment_id != assignment.assignment_id
        || authority.base_commit != assignment.base_commit
        || authority.exact_commit != assignment.exact_commit
        || authority.exact_tree != assignment.exact_tree
        || authority.candidate_root != assignment.candidate_root
        || authority.authority_digest != assignment.authority_digest
        || runner::validation_authority::authority_digest(&authority_value)
            .map_err(|error| format!("fresh Validator authority digest: {error}"))?
            != assignment.authority_digest.0
    {
        return Err("fresh Validator authority identity/digest drift".to_owned());
    }
    rows.push((
        PathBuf::from(&assignment.authority_path.0),
        "autopilot.validation_evidence_authority.v1".to_owned(),
        authority_bytes,
    ));
    Ok(rows)
}

fn staged_recovery_issue_artifacts(
    issue: &runner::IssuedRunnerAction,
) -> Result<Vec<(PathBuf, String, Vec<u8>)>, String> {
    let binding = &issue.receipt_binding;
    if binding.role_id.0 != "recovery-engineer"
        || binding.profile_id != "delivery-status.v2"
        || binding.tool_name.0 != "autopilot_emit_status"
        || binding.boundary_id.0 != "autopilot.delivery_submission.v2"
        || binding.result_contract.0 != "autopilot.delivery_result.v2"
    {
        return Err("fresh Recovery Engineer issue role/profile authority drift".to_owned());
    }
    let (spec, mut rows) = staged_issue_common_artifacts(issue)?;
    if !matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Delivery
    ) || spec.assignment_path.as_ref().map(|path| path.0.as_str())
        != binding.assignment_path.as_deref()
        || spec
            .assignment_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != binding.assignment_digest.as_deref()
    {
        return Err("fresh Recovery Engineer V5 package binding drift".to_owned());
    }
    let assignment_path = binding
        .assignment_path
        .as_ref()
        .ok_or_else(|| "fresh Recovery Engineer issue lacks assignment path".to_owned())?;
    let assignment_digest = binding
        .assignment_digest
        .as_ref()
        .ok_or_else(|| "fresh Recovery Engineer issue lacks assignment digest".to_owned())?;
    let assignment_bytes = runner::read_bounded_authority_file(
        Path::new(assignment_path),
        runner::DELIVERY_ASSIGNMENT_MAX_BYTES,
    )
    .map_err(|error| format!("fresh Recovery Engineer delivery assignment read: {error}"))?;
    if sha256_hex_local(&assignment_bytes) != *assignment_digest {
        return Err("fresh Recovery Engineer delivery assignment digest drift".to_owned());
    }
    let lane_id = binding
        .lane_id
        .as_ref()
        .ok_or_else(|| "fresh Recovery Engineer binding lacks lane_id".to_owned())?;
    let base_commit = binding
        .base_commit
        .as_ref()
        .ok_or_else(|| "fresh Recovery Engineer binding lacks base_commit".to_owned())?;
    let worktree = binding
        .worktree
        .as_deref()
        .ok_or_else(|| "fresh Recovery Engineer binding lacks worktree".to_owned())?;
    let schema = match runner::read_delivery_assignment_artifact(&assignment_bytes)? {
        runner::DeliveryAssignmentArtifactReader::V3(assignment) => {
            if assignment.schema != "autopilot.delivery_assignment.v3"
                || assignment.workstream != binding.workstream
                || assignment.assignment_id != binding.assignment_id
                || assignment.lane_id != *lane_id
                || assignment.attempt != binding.attempt
                || assignment.base_commit != *base_commit
                || assignment.worktree != worktree
                || assignment.ordered_units.is_empty()
            {
                return Err(
                    "fresh Recovery Engineer V3 delivery assignment identity drift".to_owned(),
                );
            }
            runner::validate_approved_command_bindings(&assignment)
                .map_err(|error| format!("fresh Recovery Engineer V3 command binding: {error}"))?;
            runner::validate_delivery_recovery_binding(
                &binding.role_id,
                &binding.mode,
                binding.attempt,
                assignment.recovery.as_ref(),
            )
            .map_err(|error| format!("fresh Recovery Engineer V3 directive: {error}"))?;
            "autopilot.delivery_assignment.v3"
        }
        runner::DeliveryAssignmentArtifactReader::V4(assignment) => {
            runner::materializer_v4::replay_v4_materialization(&assignment)
                .map_err(|error| format!("fresh Recovery Engineer V4 materialization: {error}"))?;
            if assignment.schema != runner::materializer_v4::DELIVERY_ASSIGNMENT_V4_SCHEMA
                || assignment.workstream != binding.workstream
                || assignment.assignment_id != binding.assignment_id
                || assignment.lane_id != *lane_id
                || assignment.attempt != binding.attempt
                || assignment.base_commit != *base_commit
                || assignment.worktree != worktree
                || assignment.ordered_units.is_empty()
            {
                return Err(
                    "fresh Recovery Engineer V4 delivery assignment identity drift".to_owned(),
                );
            }
            runner::validate_approved_command_bindings_v4(
                &assignment.ordered_units,
                &assignment.approved_commands,
            )
            .map_err(|error| format!("fresh Recovery Engineer V4 command binding: {error}"))?;
            runner::validate_delivery_recovery_binding(
                &binding.role_id,
                &binding.mode,
                binding.attempt,
                assignment.recovery.as_ref(),
            )
            .map_err(|error| format!("fresh Recovery Engineer V4 directive: {error}"))?;
            "autopilot.delivery_assignment.v4"
        }
    };
    rows.push((
        PathBuf::from(assignment_path),
        schema.to_owned(),
        assignment_bytes,
    ));
    Ok(rows)
}

fn staged_implementer_issue_artifacts(
    issue: &runner::IssuedRunnerAction,
) -> Result<Vec<(PathBuf, String, Vec<u8>)>, String> {
    let binding = &issue.receipt_binding;
    if binding.role_id.0 != "implementer"
        || binding.profile_id != "delivery-status.v2"
        || binding.tool_name.0 != "autopilot_emit_status"
        || binding.boundary_id.0 != "autopilot.delivery_submission.v2"
        || binding.result_contract.0 != "autopilot.delivery_result.v2"
    {
        return Err("fresh Implementer issue role/profile authority drift".to_owned());
    }
    let (spec, mut rows) = staged_issue_common_artifacts(issue)?;
    if !matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Delivery
    ) || spec.assignment_path.as_ref().map(|path| path.0.as_str())
        != binding.assignment_path.as_deref()
        || spec
            .assignment_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != binding.assignment_digest.as_deref()
    {
        return Err("fresh Implementer V5 package binding drift".to_owned());
    }
    let path = binding
        .assignment_path
        .as_ref()
        .ok_or_else(|| "fresh Implementer issue lacks assignment path".to_owned())?;
    let digest = binding
        .assignment_digest
        .as_ref()
        .ok_or_else(|| "fresh Implementer issue lacks assignment digest".to_owned())?;
    let bytes =
        runner::read_bounded_authority_file(Path::new(path), runner::DELIVERY_ASSIGNMENT_MAX_BYTES)
            .map_err(|error| format!("fresh Implementer assignment read: {error}"))?;
    if sha256_hex_local(&bytes) != *digest {
        return Err("fresh Implementer assignment digest drift".to_owned());
    }
    let lane = binding
        .lane_id
        .as_ref()
        .ok_or_else(|| "fresh Implementer lane missing".to_owned())?;
    let base = binding
        .base_commit
        .as_ref()
        .ok_or_else(|| "fresh Implementer base missing".to_owned())?;
    let worktree = binding
        .worktree
        .as_deref()
        .ok_or_else(|| "fresh Implementer worktree missing".to_owned())?;
    let schema = match runner::read_delivery_assignment_artifact(&bytes)? {
        runner::DeliveryAssignmentArtifactReader::V3(assignment) => {
            if assignment.workstream != binding.workstream
                || assignment.assignment_id != binding.assignment_id
                || assignment.lane_id != *lane
                || assignment.attempt != binding.attempt
                || assignment.base_commit != *base
                || assignment.worktree != worktree
                || assignment.recovery.is_some()
            {
                return Err("fresh Implementer V3 assignment identity drift".to_owned());
            }
            runner::validate_approved_command_bindings(&assignment)
                .map_err(|error| error.to_string())?;
            "autopilot.delivery_assignment.v3"
        }
        runner::DeliveryAssignmentArtifactReader::V4(assignment) => {
            if assignment.workstream != binding.workstream
                || assignment.assignment_id != binding.assignment_id
                || assignment.lane_id != *lane
                || assignment.attempt != binding.attempt
                || assignment.base_commit != *base
                || assignment.worktree != worktree
                || assignment.recovery.is_some()
            {
                return Err("fresh Implementer V4 assignment identity drift".to_owned());
            }
            runner::materializer_v4::replay_v4_materialization(&assignment)
                .map_err(|error| error.to_string())?;
            runner::validate_approved_command_bindings_v4(
                &assignment.ordered_units,
                &assignment.approved_commands,
            )
            .map_err(|error| error.to_string())?;
            "autopilot.delivery_assignment.v4"
        }
    };
    rows.push((PathBuf::from(path), schema.to_owned(), bytes));
    Ok(rows)
}

/// Delivery can issue exactly the three closed continuations above. Selection
/// comes from issued role/profile identity, never from assignment shape.
fn staged_issue_artifacts(
    issue: &runner::IssuedRunnerAction,
) -> Result<Vec<(PathBuf, String, Vec<u8>)>, String> {
    match issue.receipt_binding.role_id.0.as_str() {
        "validator" => staged_validator_issue_artifacts(issue),
        "recovery-engineer" => staged_recovery_issue_artifacts(issue),
        "implementer" => staged_implementer_issue_artifacts(issue),
        role => Err(format!(
            "fresh issued action has unsupported role/profile: {role}"
        )),
    }
}

fn stage_delivery_semantics(
    _state: &CoreState,
    binding: &runner::IssuedRunnerBinding,
    result: &kernel::generated::DeliveryResultV2,
    facts: &ValidatedDeliveryFacts,
    carrier_bytes: &[u8],
    continuation_run_revision: u64,
) -> Result<StagedDeliverySemantics, String> {
    let delivery = delivery_v1_projection(result);
    let mut refs = vec![
        Ref(binding.assignment_id.0.clone()),
        Ref(binding.action_id.0.clone()),
        result.submission.execution_audit_ref.clone(),
        Ref(format!(
            "policy-denials:{}",
            facts.denial_ledger.entries.len()
        )),
    ];
    let (transcript_path, transcript_schema, transcript_bytes) =
        staged_delivery_transcript(binding, carrier_bytes)?;
    refs.push(Ref(transcript_path.display().to_string()));
    let mut artifacts = vec![(transcript_path, transcript_schema, transcript_bytes)];
    if runner::delivery_submission_outcome(&result.submission)
        == runner::DeliverySubmissionOutcome::Blocked
    {
        refs.push(Ref("agent:delivery-blocked".to_owned()));
        if binding.role_id.0 == "recovery-engineer" {
            let disposition = result
                .submission
                .recovery_disposition
                .as_ref()
                .ok_or_else(|| {
                    "blocked Recovery Engineer result lacks recovery disposition".to_owned()
                })?;
            refs.extend([
                Ref(format!("recovery-disposition:{disposition:?}")),
                recovery_disposition_failure_ref(disposition),
                lane_blocker_ref(binding)?,
            ]);
            return Ok(StagedDeliverySemantics {
                event_kind: "recovery:inadmissible".to_owned(),
                refs,
                effect: DeferredHostEffectV1::Done {
                    payload: CoreToHostDonePayload {
                        status: format!("recovery-fail-closed:{disposition:?}"),
                    },
                },
                issues: Vec::new(),
                artifacts,
            });
        }
        match assess_blocked_delivery_recovery(binding, result, facts)? {
            DeliveryRecoveryDecision::Admit(assessment) => {
                refs.extend(recovery_assessment_refs(binding, &assessment));
                if assessment.admission == DeliveryRecoveryAdmission::PolicyDenialRepairable {
                    refs.push(Ref("delivery-policy-denial-reconciliation".to_owned()));
                }
                refs.push(Ref(format!("recovery-pending:{}", binding.assignment_id.0)));
                let issue = stage_delivery_recovery_issue(
                    binding,
                    result,
                    &assessment,
                    continuation_run_revision,
                )?;
                refs.push(Ref("delivery:recovery-required".to_owned()));
                artifacts.extend(staged_issue_artifacts(&issue)?);
                return Ok(StagedDeliverySemantics {
                    event_kind: "delivery:recovery-required".to_owned(),
                    refs,
                    effect: DeferredHostEffectV1::Spawn {
                        payload: CoreToHostSpawnPayload {
                            action: issue.action.clone(),
                        },
                    },
                    issues: vec![issue],
                    artifacts,
                });
            }
            DeliveryRecoveryDecision::Unsafe(error) => {
                refs.extend([
                    Ref(format!("delivery-recovery-unsafe:{error:?}")),
                    Ref("semantic-recovery-unsafe".to_owned()),
                    lane_blocker_ref(binding)?,
                ]);
            }
            DeliveryRecoveryDecision::Inadmissible(reason) => {
                refs.extend([
                    Ref(format!("delivery-recovery-reason:{reason}")),
                    delivery_blocker_failure_ref(result.submission.blocker_class.as_ref()),
                    lane_blocker_ref(binding)?,
                ]);
            }
        }
        return Ok(StagedDeliverySemantics {
            event_kind: "recovery:inadmissible".to_owned(),
            refs,
            effect: DeferredHostEffectV1::Done {
                payload: CoreToHostDonePayload {
                    status: "delivery-recovery-inadmissible".to_owned(),
                },
            },
            issues: Vec::new(),
            artifacts,
        });
    }
    let expected = delivery_expectation_from_binding(binding)?;
    let (package, accepted) = match facts.assignment.v4.as_ref() {
        Some(artifact) => {
            let package = runner::establish_delivery_package_v4(&delivery, &expected, artifact)
                .map_err(|error| format!("delivery package: {error:?}"))?;
            let accepted = runner::accept_delivery_v4_with_package_facts(
                &delivery, &expected, artifact, &package,
            )
            .map_err(|error| format!("delivery package acceptance: {error:?}"))?;
            (package, accepted)
        }
        None => {
            let package = runner::establish_delivery_package(&delivery, &expected)
                .map_err(|error| format!("delivery package: {error:?}"))?;
            let accepted = runner::accept_delivery_with_package_facts(
                std::slice::from_ref(&delivery),
                &expected,
                &package,
            )
            .map_err(|error| format!("delivery package acceptance: {error:?}"))?;
            (package, accepted)
        }
    };
    let package_authority = match facts.assignment.v4.as_ref() {
        Some(artifact) => runner::ValidationPackageAuthority::RootedV4(Box::new(artifact.clone())),
        None => runner::ValidationPackageAuthority::LegacyV3,
    };
    let issue = validation_issue_for_delivery(
        binding,
        &accepted,
        &facts.command_executions,
        package_authority,
        continuation_run_revision,
    )?;
    refs.extend([
        Ref(package.package_commit.0),
        Ref(package.package_tree.0),
        Ref("validation:required".to_owned()),
        Ref(format!(
            "validator-assignment:{}",
            issue.binding.assignment_id.0
        )),
    ]);
    artifacts.extend(staged_issue_artifacts(&issue)?);
    Ok(StagedDeliverySemantics {
        event_kind: "agent:delivery-accepted".to_owned(),
        refs,
        effect: DeferredHostEffectV1::Spawn {
            payload: CoreToHostSpawnPayload {
                action: issue.action.clone(),
            },
        },
        issues: vec![issue],
        artifacts,
    })
}

fn stage_delivery_recovery_issue(
    binding: &runner::IssuedRunnerBinding,
    result: &kernel::generated::DeliveryResultV2,
    assessment: &DeliveryRecoveryAssessment,
    continuation_run_revision: u64,
) -> Result<runner::IssuedRunnerAction, String> {
    let approved_units = read_delivery_assignment_units(binding)?;
    let base_commit = binding
        .base_commit
        .clone()
        .ok_or_else(|| "delivery recovery missing base commit".to_owned())?;
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
    let mut diagnosis_details = result.submission.hard_boundary_violations.clone();
    diagnosis_details.extend([
        format!(
            "mechanical in-scope dirty paths: [{}]",
            assessment.snapshot.in_scope_dirty_paths.join(",")
        ),
        format!(
            "package recovery admission: {}; snapshot={}",
            assessment.admission.as_str(),
            assessment.snapshot.snapshot_digest
        ),
    ]);
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
        continuation_run_revision,
    )?;
    let facts = runner::RunnerTransportFacts::from_env().map_err(|error| error.to_string())?;
    match delivery_assignment_v4_for_binding(binding)? {
        Some(source) => runner::delivery_issue_v4_with_facts(
            &recovery_v4_assignment(assignment, source),
            &facts,
        )
        .map_err(|error| error.to_string()),
        None => runner::delivery_issue_with_facts(&assignment, &facts)
            .map_err(|error| error.to_string()),
    }
}

fn commit_staged_delivery_submit(
    state: &mut CoreState,
    request: &ChildControlRequest,
    binding: &runner::ReceiptV1RunnerBinding,
    _facade: &kernel::generated::AgentRunSpec,
    raw: &[u8],
    prepared: runner::child::PreparedCarrier,
) -> Result<SubmitReceipt, SubmitDiagnostic> {
    let legacy = runner::receipt_v1_validator_facade(binding);
    if planning_result_consumed(state, &legacy) || terminal_consumed(state, &legacy) {
        return Err(delivery_staging_retry(
            "submit.already_consumed",
            "",
            "delivery binding is already terminal or consumed",
        ));
    }
    let result: kernel::generated::DeliveryResultV2 =
        serde_json::from_value(prepared.carrier.clone()).map_err(|error| {
            delivery_staging_retry("submit.delivery_carrier", "/raw_payload", error.to_string())
        })?;
    let carrier_bytes = crate::evidence::canonical_json(&prepared.carrier).map_err(|error| {
        delivery_staging_retry("submit.canonical_json", "/raw_payload", error.to_string())
    })?;
    let audit_path = PathBuf::from(&legacy.carrier_path).with_extension("tool-audit.json");
    let mut staged_audits = Vec::new();
    for artifact in &prepared.artifacts {
        let (path, bytes) = prepared_artifact_bytes(artifact).map_err(|error| {
            delivery_staging_retry("submit.delivery_audit", "/tool_audit_ref", error)
        })?;
        if path == audit_path {
            staged_audits.push(bytes);
        }
    }
    let audit_bytes = match staged_audits.len() {
        1 => staged_audits.remove(0),
        0 => {
            return Err(delivery_staging_retry(
                "submit.delivery_audit",
                "/tool_audit_ref",
                "staged delivery audit is absent",
            ));
        }
        count => {
            return Err(delivery_staging_retry(
                "submit.delivery_audit",
                "/tool_audit_ref",
                format!("staged delivery audit is ambiguous: {count} exact-path artifacts"),
            ));
        }
    };
    let facts = validate_delivery_result_v2_staged(&result, &legacy, Some(binding), &audit_bytes)
        .map_err(|error| {
        delivery_staging_retry("submit.delivery_parent_predicate", "", error)
    })?;
    staged_delivery_runtime_evidence(&request.runtime_evidence, &facts).map_err(|error| {
        delivery_staging_retry(
            "submit.delivery_runtime_evidence",
            "/runtime_evidence",
            error,
        )
    })?;
    let continuation_run_revision = receipt_v1_continuation_run_revision(binding)
        .map_err(|error| delivery_staging_retry("submit.delivery_transition", "", error))?;
    let semantic = stage_delivery_semantics(
        state,
        &legacy,
        &result,
        &facts,
        &carrier_bytes,
        continuation_run_revision,
    )
    .map_err(|error| delivery_staging_retry("submit.delivery_transition", "", error))?;
    let sidecar = PreparedDeliveryTransitionV1 {
        schema: PREPARED_DELIVERY_TRANSITION_SCHEMA.to_owned(),
        event_kind: semantic.event_kind.clone(),
        refs: semantic.refs.clone(),
    };
    validate_delivery_transition(&sidecar)
        .map_err(|error| delivery_staging_retry("submit.delivery_transition", "", error))?;
    let sidecar_path = prepared_delivery_transition_path(binding)
        .map_err(|error| delivery_staging_retry("submit.delivery_transition", "", error))?;
    let sidecar_bytes = crate::evidence::canonical_json(&sidecar)
        .map_err(|error| delivery_staging_retry("submit.canonical_json", "", error.to_string()))?;
    let mut staged_artifacts = prepared
        .artifacts
        .iter()
        .map(|artifact| {
            prepared_artifact_bytes(artifact).map(|(path, bytes)| {
                (
                    path,
                    "autopilot.staged_submit_artifact.v1".to_owned(),
                    bytes,
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| delivery_staging_retry("submit.delivery_artifact", "", error))?;
    staged_artifacts.extend(semantic.artifacts);
    staged_artifacts.push((
        sidecar_path,
        PREPARED_DELIVERY_TRANSITION_SCHEMA.to_owned(),
        sidecar_bytes,
    ));
    let issued_actions = semantic
        .issues
        .iter()
        .map(|issue| {
            let binding_bytes =
                crate::evidence::canonical_json(&issue.receipt_binding).map_err(|error| {
                    delivery_staging_retry("submit.canonical_json", "", error.to_string())
                })?;
            Ok(PreparedSubmitIssuedAction {
                action_ref: issued_action_ref(&issue.action, &issue.receipt_binding)
                    .map_err(|error| delivery_staging_retry("submit.issued_action", "", error))?,
                action: issue.action.clone(),
                binding_ref: runner::receipt_binding_ref(&issue.receipt_binding).map_err(
                    |error| delivery_staging_retry("submit.issued_binding", "", error.to_string()),
                )?,
                binding_digest: Digest(sha256_hex_local(&binding_bytes)),
            })
        })
        .collect::<Result<Vec<_>, SubmitDiagnostic>>()?;
    let carrier_artifact = artifact_ref(
        Path::new(&legacy.carrier_path),
        "autopilot.delivery_result.v2",
        &carrier_bytes,
    );
    let artifact_refs = staged_artifacts
        .iter()
        .map(|(path, schema, bytes)| artifact_ref(path, schema, bytes))
        .collect::<Vec<_>>();
    let transition_path = submit_transition_path(binding)
        .map_err(|error| delivery_staging_retry("submit.transition_path", "", error))?;
    let effect = semantic.effect;
    let transition_body = serde_json::json!({
        "schema": "autopilot.prepared_submit_transition_body.v1",
        "carrier": carrier_artifact,
        "artifact_refs": artifact_refs,
        "issued_actions": issued_actions,
        "deferred_host_effect": effect,
    });
    let transition_bytes = crate::evidence::canonical_json(&transition_body)
        .map_err(|error| delivery_staging_retry("submit.canonical_json", "", error.to_string()))?;
    let receipt = SubmitReceipt {
        schema: SchemaId("autopilot.submit_receipt.v1".to_owned()),
        receipt_id: crate::state_root::fresh_uuid_v7()
            .map_err(|error| delivery_staging_retry("submit.receipt_id", "", error.to_string()))?,
        run_id: binding.run_id.clone(),
        run_revision: binding.run_revision,
        workstream: binding.workstream.clone(),
        action_id: binding.action_id.clone(),
        assignment_id: binding.assignment_id.clone(),
        attempt: binding.attempt,
        profile_id: binding.profile_id.clone(),
        tool_name: binding.tool_name.clone(),
        boundary_id: binding.boundary_id.clone(),
        result_contract: binding.result_contract.clone(),
        schema_digest: Digest(binding.schema_digest.clone()),
        spec_digest: Digest(binding.spec_digest.clone()),
        carrier_binding_digest: Digest(binding.carrier_binding_digest.clone()),
        authority_digest: Digest(binding.authority_digest.clone()),
        frozen_validator_versions: vec![SubmitReceiptValidatorVersion {
            validator_id: Id("delivery-parent-stage".to_owned()),
            version: "v1".to_owned(),
            digest: Digest(sha256_hex_local(b"delivery-parent-stage:v1")),
        }],
        raw_payload_digest: Digest(sha256_hex_local(raw)),
        raw_payload_byte_count: raw.len() as u64,
        request_id: request.request_id.clone(),
        tool_call_id: request.tool_call_id.clone(),
        prepared_transition: PreparedSubmitTransitionV1 {
            schema: SchemaId("autopilot.prepared_submit_transition.v1".to_owned()),
            transition_ref: Ref(transition_path.display().to_string()),
            transition_digest: Digest(sha256_hex_local(&transition_bytes)),
            carrier: carrier_artifact,
            artifact_refs,
            issued_actions,
            deferred_host_effect: effect,
        },
    };
    let receipt_bytes = crate::evidence::canonical_json(&receipt)
        .map_err(|error| delivery_staging_retry("submit.canonical_json", "", error.to_string()))?;
    runner::write_bounded_file_create_once(
        Path::new(&legacy.carrier_path),
        &carrier_bytes,
        MAX_TERMINAL_CARRIER_BYTES,
    )
    .map_err(|error| delivery_staging_retry("submit.carrier_write", "", error.to_string()))?;
    for (path, _, bytes) in &staged_artifacts {
        runner::write_bounded_file_create_once(path, bytes, SUBMIT_RECEIPT_MAX_BYTES).map_err(
            |error| delivery_staging_retry("submit.artifact_write", "", error.to_string()),
        )?;
    }
    runner::write_bounded_file_create_once(
        &transition_path,
        &transition_bytes,
        SUBMIT_RECEIPT_MAX_BYTES,
    )
    .map_err(|error| delivery_staging_retry("submit.transition_write", "", error.to_string()))?;
    let receipt_path = submit_receipt_path(binding)
        .map_err(|error| delivery_staging_retry("submit.receipt_path", "", error))?;
    runner::write_bounded_file_create_once(&receipt_path, &receipt_bytes, SUBMIT_RECEIPT_MAX_BYTES)
        .map_err(|error| delivery_staging_retry("submit.receipt_write", "", error.to_string()))?;
    root_or_verify_submit_receipt(state, &receipt, binding)
        .map_err(|error| delivery_staging_retry("submit.receipt_root", "", error))?;
    Ok(receipt)
}

#[derive(Clone)]
struct StagedValidationSemantics {
    event_kind: String,
    refs: Vec<Ref>,
    effect: DeferredHostEffectV1,
    issues: Vec<runner::IssuedRunnerAction>,
    artifacts: Vec<(PathBuf, String, Vec<u8>)>,
    finalization: Option<PreparedValidationFinalizationV1>,
}

fn validation_staging_retry(
    code: &str,
    pointer: &str,
    detail: impl Into<String>,
) -> SubmitDiagnostic {
    child_control_diagnostic(
        code,
        pointer,
        "a complete receipt-backed Validator integration or recovery transition",
        &serde_json::json!(detail.into()),
        "Correct the Validator authority/value or retry with the exact issued receipt_v1 capability.",
    )
}

fn exact_prepared_artifact(
    artifacts: &[runner::child::PreparedArtifact],
    path: &Path,
) -> Result<Vec<u8>, String> {
    let mut matches = Vec::new();
    for artifact in artifacts {
        // A PreparedCarrier is all-or-nothing authority. In particular, an
        // unrelated malformed JSON artifact must not be hidden by filtering
        // it out before the exact path cardinality check.
        let (candidate, bytes) = prepared_artifact_bytes(artifact).map_err(|error| {
            format!(
                "staged artifact serialization/path failure while selecting {}: {error}",
                path.display()
            )
        })?;
        if candidate == path {
            matches.push(bytes);
        }
    }
    match matches.as_slice() {
        [bytes] => Ok(bytes.clone()),
        [] => Err(format!("staged artifact is absent at {}", path.display())),
        _ => Err(format!(
            "staged artifact is ambiguous at {}",
            path.display()
        )),
    }
}

fn staged_authority_artifact(
    path: &Path,
    digest: &str,
    max_bytes: usize,
    schema: &str,
) -> Result<(PathBuf, String, Vec<u8>), String> {
    let bytes = runner::read_bounded_authority_file(path, max_bytes)
        .map_err(|error| format!("authority read {}: {error}", path.display()))?;
    if sha256_hex_local(&bytes) != digest {
        return Err(format!("authority digest drift at {}", path.display()));
    }
    Ok((path.to_path_buf(), schema.to_owned(), bytes))
}

fn fresh_validation_spec(
    result_spec_bytes: &str,
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<kernel::generated::AgentRunSpecV5, String> {
    let bytes = result_spec_bytes.as_bytes();
    if bytes.len() > MAX_CARRIER_SPEC_BYTES || sha256_hex_local(bytes) != binding.spec_digest {
        return Err("fresh validation carrier spec receipt drift".to_owned());
    }
    let spec: kernel::generated::AgentRunSpecV5 = serde_json::from_slice(bytes)
        .map_err(|error| format!("fresh validation V5 spec JSON: {error}"))?;
    runner::validate_receipt_v1_spec(binding, &spec)
        .map_err(|error| format!("fresh validation V5 spec authority: {error}"))?;
    Ok(spec)
}

fn validate_validation_result_v2_staged(
    result: &kernel::generated::ValidationResultV2,
    binding: &runner::ReceiptV1RunnerBinding,
    audit: &[u8],
) -> Result<Vec<(PathBuf, String, Vec<u8>)>, String> {
    let facade = runner::receipt_v1_validator_facade(binding);
    if result.schema.0 != "autopilot.validation_result.v2"
        || result.action_id != facade.action_id
        || result.assignment_id != facade.assignment_id
        || result.run_revision != facade.run_revision
        || result.workstream != facade.workstream
        || result.role_id != facade.role_id
        || result.mode != facade.mode
        || result.prompt_path.0 != facade.prompt_path
        || result.prompt_digest.0 != facade.prompt_digest
        || result.spec_path.0 != facade.spec_path
        || result.spec_digest.0 != facade.spec_digest
        || result.carrier_path.0 != facade.carrier_path
        || result.boundary_id != facade.boundary_id
        || result.boundary_digest.0 != facade.boundary_digest
        || result.result_contract != facade.result_contract
        || result.result_contract_digest.0 != facade.result_contract_digest
        || result.settings_digest.0 != facade.settings_digest
        || result.skills_digest.0 != facade.skills_digest
        || result.subscription_digest.0 != facade.subscription_digest
    {
        return Err("fresh V2 validation package identity drift".to_owned());
    }
    let spec = fresh_validation_spec(&result.spec_bytes.0, binding)?;
    let view = runner::project_v5_spec_for_shared_admission(&spec);
    if view.assignment_path.as_ref() != Some(&result.assignment_path)
        || view.assignment_digest.as_ref() != Some(&result.assignment_digest)
        || view.context_manifest_path.as_ref() != Some(&result.context_manifest_path)
        || view.context_manifest_digest.as_ref() != Some(&result.context_manifest_digest)
        || view.validation_id.as_ref() != Some(&result.validation_id)
        || view.validation_attempt != Some(result.validation_attempt)
        || view.semantic_round != Some(result.semantic_round)
        || view.producer_assignment_ids.as_ref() != Some(&result.producer_assignment_ids)
    {
        return Err("fresh V2 validation carrier artifact binding drift".to_owned());
    }
    let profile = runner::terminal_profile_for(
        &facade.role_id.0,
        &facade.boundary_id.0,
        &facade.result_contract.0,
    )
    .map_err(|error| error.to_string())?;
    if result.terminal_profile_id != profile.0
        || result.tool_name.0 != profile.1
        || result.tool_schema_digest.0 != profile.4
        || result.carrier_binding.0 != runner::child::carrier_binding(&view)
        || result.runtime_extension_digest.0 != kernel::generated::CHILD_ADDON_DIGEST
    {
        return Err("fresh V2 validation terminal profile provenance drift".to_owned());
    }
    let assignment_row = staged_authority_artifact(
        Path::new(&result.assignment_path.0),
        &result.assignment_digest.0,
        MAX_VALIDATION_BOUND_ARTIFACT_BYTES,
        "autopilot.validation_assignment.v2",
    )?;
    let assignment: kernel::generated::ValidationAssignmentV2 =
        serde_json::from_slice(&assignment_row.2)
            .map_err(|error| format!("fresh V2 validation assignment JSON: {error}"))?;
    let context_row = staged_authority_artifact(
        Path::new(&result.context_manifest_path.0),
        &result.context_manifest_digest.0,
        MAX_VALIDATION_BOUND_ARTIFACT_BYTES,
        "autopilot.validation_context.v2",
    )?;
    let context: kernel::generated::ValidationContextV2 = serde_json::from_slice(&context_row.2)
        .map_err(|error| format!("fresh V2 validation context JSON: {error}"))?;
    // These frozen V2 predicates remain the exact semantic authority.
    runner::child::admit_validation_submission_with_authority(
        &result.submission,
        &assignment,
        &context,
    )
    .map_err(|error| format!("fresh V2 validation submission authority: {error}"))?;
    if assignment.validation_id != result.validation_id
        || assignment.validation_key != result.validation_key
        || assignment.validation_attempt != result.validation_attempt
        || assignment.semantic_round != result.semantic_round
        || assignment.producer_assignment_ids != result.producer_assignment_ids
        || assignment.exact_commit != result.exact_commit
        || assignment.exact_tree != result.exact_tree
    {
        return Err("fresh V2 validation assignment/result identity drift".to_owned());
    }
    let prompt_row = staged_authority_artifact(
        Path::new(&facade.prompt_path),
        &facade.prompt_digest,
        runner::child::MAX_RENDERED_PROMPT_BYTES,
        "autopilot.rendered_prompt.v1",
    )?;
    let spec_row = staged_authority_artifact(
        Path::new(&facade.spec_path),
        &facade.spec_digest,
        runner::child::MAX_AGENT_RUN_SPEC_BYTES,
        "autopilot.agent_run_spec.v5",
    )?;
    let audit_path = PathBuf::from(&facade.carrier_path).with_extension("tool-audit.json");
    if result.tool_audit_ref.0 != audit_path.display().to_string()
        || audit.len() > MAX_TOOL_AUDIT_BYTES
        || sha256_hex_local(audit) != result.tool_audit_digest.0
    {
        return Err("fresh V2 validation tool audit drift".to_owned());
    }
    let audit_value: ValidationToolAudit =
        serde_json::from_slice(audit).map_err(|error| error.to_string())?;
    if audit_value.schema != "autopilot.tool_audit.v1"
        || audit_value.tool_call_id != result.tool_call_id
        || audit_value.profile_id != result.terminal_profile_id
        || audit_value.tool_name != result.tool_name.0
        || audit_value.boundary_id != result.boundary_id.0
        || audit_value.result_contract != result.result_contract.0
        || audit_value.schema_digest != result.tool_schema_digest.0
        || audit_value.binding != result.carrier_binding.0
    {
        return Err("fresh V2 validation tool audit content drift".to_owned());
    }
    let submission = serde_json::to_vec(
        &serde_json::to_value(&result.submission).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if sha256_hex_local(&submission) != result.submission_digest.0
        || audit_value.submission_digest != result.submission_digest.0
    {
        return Err("fresh V2 validation submission/audit digest drift".to_owned());
    }
    // The model submission/audit are already exact PreparedCarrier artifacts;
    // return only parent-read authority projections so receipt refs stay
    // unique while still binding every staged byte.
    Ok(vec![assignment_row, context_row, prompt_row, spec_row])
}

fn validate_validation_result_v3_staged(
    result: &kernel::generated::ValidationResultV3,
    binding: &runner::ReceiptV1RunnerBinding,
    raw_submission: &[u8],
    audit: &[u8],
) -> Result<Vec<(PathBuf, String, Vec<u8>)>, String> {
    let facade = runner::receipt_v1_validator_facade(binding);
    let assignment_path = binding
        .assignment_path
        .as_deref()
        .ok_or_else(|| "fresh V3 receipt binding lacks required assignment path".to_owned())?;
    let assignment_digest = binding
        .assignment_digest
        .as_deref()
        .ok_or_else(|| "fresh V3 receipt binding lacks required assignment digest".to_owned())?;
    if result.schema.0 != "autopilot.validation_result.v3"
        || result.action_id != facade.action_id
        || result.assignment_id != facade.assignment_id
        || result.run_revision != facade.run_revision
        || result.workstream != facade.workstream
        || result.role_id != facade.role_id
        || result.mode != facade.mode
        || result.prompt_path.0 != facade.prompt_path
        || result.prompt_digest.0 != facade.prompt_digest
        || result.spec_path.0 != facade.spec_path
        || result.spec_digest.0 != facade.spec_digest
        || result.carrier_path.0 != facade.carrier_path
        || result.boundary_id != facade.boundary_id
        || result.boundary_digest.0 != facade.boundary_digest
        || result.result_contract != facade.result_contract
        || result.result_contract_digest.0 != facade.result_contract_digest
        || result.settings_digest.0 != facade.settings_digest
        || result.skills_digest.0 != facade.skills_digest
        || result.subscription_digest.0 != facade.subscription_digest
        || result.assignment_path.0 != assignment_path
        || result.assignment_digest.0 != assignment_digest
    {
        return Err("fresh V3 validation package identity/provenance drift".to_owned());
    }
    let spec = fresh_validation_spec(&result.spec_bytes.0, binding)?;
    let view = runner::project_v5_spec_for_shared_admission(&spec);
    if view.assignment_path.as_ref() != Some(&result.assignment_path)
        || view.assignment_digest.as_ref() != Some(&result.assignment_digest)
        || view.context_manifest_path.as_ref() != Some(&result.context_manifest_path)
        || view.context_manifest_digest.as_ref() != Some(&result.context_manifest_digest)
        || view.validation_id.as_ref() != Some(&result.validation_id)
        || view.validation_attempt != Some(result.validation_attempt)
        || view.semantic_round != Some(result.semantic_round)
        || view.producer_assignment_ids.as_ref() != Some(&result.producer_assignment_ids)
        || view.lane_id != facade.lane_id
        || view.attempt != facade.attempt
        || view.base_commit != facade.base_commit
        || view.worktree.as_ref().map(|path| path.0.as_str()) != facade.worktree.as_deref()
    {
        return Err("fresh V3 validation V5 spec/result provenance drift".to_owned());
    }
    let profile = runner::terminal_profile_for(
        &facade.role_id.0,
        &facade.boundary_id.0,
        &facade.result_contract.0,
    )
    .map_err(|error| error.to_string())?;
    if result.terminal_profile_id != profile.0
        || result.tool_name.0 != profile.1
        || result.tool_schema_digest.0 != profile.4
        || result.carrier_binding.0 != runner::child::carrier_binding(&view)
        || result.runtime_extension_digest.0 != kernel::generated::CHILD_ADDON_DIGEST
        || result.tool_call_id.trim().is_empty()
    {
        return Err("fresh V3 validation terminal profile/tool binding drift".to_owned());
    }
    let assignment_row = staged_authority_artifact(
        Path::new(&result.assignment_path.0),
        &result.assignment_digest.0,
        kernel::generated::VALIDATION_ASSIGNMENT_V4_MAX_BYTES,
        "autopilot.validation_assignment.v4",
    )?;
    let assignment: kernel::generated::ValidationAssignmentV4 =
        serde_json::from_slice(&assignment_row.2)
            .map_err(|error| format!("fresh V3 ValidationAssignmentV4 JSON: {error}"))?;
    if serde_json::to_vec_pretty(&assignment).map_err(|error| error.to_string())?
        != assignment_row.2
        || assignment.schema.0 != "autopilot.validation_assignment.v4"
        || assignment.admission_mode != kernel::generated::AdmissionMode::ReceiptV1
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
        || assignment.candidate_root != view.cwd
        || assignment.base_commit.0 != view.base_commit.as_ref().map_or("", |sha| &sha.0)
    {
        return Err("fresh V3 ValidationAssignmentV4/result/spec identity drift".to_owned());
    }
    let expected_key = sha256_hex_local(
        format!(
            "validation.v3\0{}\0{}\0{}",
            assignment.validation_id.0, assignment.exact_commit.0, assignment.exact_tree.0
        )
        .as_bytes(),
    );
    if assignment.validation_key.0 != expected_key {
        return Err("fresh V3 validation key drift".to_owned());
    }
    let expectation = runner::validation_authority::ValidationAuthorityExpectation {
        validation_id: &assignment.validation_id,
        assignment_id: &assignment.assignment_id,
        base_commit: &assignment.base_commit,
        exact_commit: &assignment.exact_commit,
        exact_tree: &assignment.exact_tree,
        candidate_root: Path::new(&view.cwd.0),
    };
    let authority_bytes = runner::read_bounded_authority_file(
        Path::new(&result.authority_path.0),
        MAX_VALIDATION_BOUND_ARTIFACT_BYTES,
    )
    .map_err(|error| format!("fresh V3 authority read: {error}"))?;
    let authority_value: serde_json::Value = serde_json::from_slice(&authority_bytes)
        .map_err(|error| format!("fresh V3 authority JSON: {error}"))?;
    if serde_json::to_vec_pretty(&authority_value).map_err(|error| error.to_string())?
        != authority_bytes
        || runner::validation_authority::authority_digest(&authority_value)
            .map_err(|error| format!("fresh V3 authority digest: {error}"))?
            != result.authority_digest.0
    {
        return Err("fresh V3 authority canonical/material digest drift".to_owned());
    }
    let authority = runner::validation_authority::ValidationAuthorityIndex::load_staged_bytes(
        Path::new(&result.authority_path.0),
        &authority_bytes,
        &result.authority_digest.0,
        &expectation,
    )
    .map_err(validation_authority_failure_text)?;
    let authority_row = (
        PathBuf::from(&result.authority_path.0),
        "autopilot.validation_evidence_authority.v1".to_owned(),
        authority_bytes,
    );
    let context_row = staged_authority_artifact(
        Path::new(&result.context_manifest_path.0),
        &result.context_manifest_digest.0,
        kernel::generated::VALIDATION_CONTEXT_V3_MAX_BYTES,
        "autopilot.validation_context.v3",
    )?;
    let context: kernel::generated::ValidationContextV3 = serde_json::from_slice(&context_row.2)
        .map_err(|error| format!("fresh V3 validation context JSON: {error}"))?;
    if serde_json::to_vec_pretty(&context).map_err(|error| error.to_string())? != context_row.2
        || authority.context_projection() != context
    {
        return Err("fresh V3 context canonical authority projection drift".to_owned());
    }
    let submission_path = view
        .model_submission_path
        .as_ref()
        .ok_or_else(|| "fresh V3 model submission path absent".to_owned())?;
    if Path::new(&submission_path.0)
        != Path::new(&result.assignment_path.0)
            .parent()
            .ok_or_else(|| "fresh V3 assignment path has no parent".to_owned())?
            .join("model-submission.v3.json")
        || raw_submission.len() > kernel::generated::VALIDATION_SUBMISSION_V3_MAX_BYTES
        || sha256_hex_local(raw_submission) != result.submission_digest.0
    {
        return Err("fresh V3 raw model submission path/digest drift".to_owned());
    }
    let raw_value: serde_json::Value =
        serde_json::from_slice(raw_submission).map_err(|error| error.to_string())?;
    let result_submission =
        serde_json::to_value(&result.submission).map_err(|error| error.to_string())?;
    let canonical_raw = serde_json::to_vec(&raw_value).map_err(|error| error.to_string())?;
    if raw_submission != canonical_raw
        || raw_value != result_submission
        || sha256_hex_local(&canonical_raw) != result.submission_digest.0
    {
        return Err("fresh V3 raw/canonical submission equality drift".to_owned());
    }
    let admitted = authority
        .admit_raw(&raw_value, result.validation_attempt)
        .map_err(validation_authority_failure_text)?;
    let verdict_bytes = serde_json::to_vec(&result.verdict).map_err(|error| error.to_string())?;
    if admitted.submission != result.submission
        || admitted.verdict != result.verdict
        || admitted.verdict_bytes != verdict_bytes
        || sha256_hex_local(&verdict_bytes) != result.verdict_digest.0
    {
        return Err("fresh V3 normalized submission/verdict equality drift".to_owned());
    }
    let audit_path = PathBuf::from(&facade.carrier_path).with_extension("tool-audit.json");
    if result.tool_audit_ref.0 != audit_path.display().to_string()
        || audit.len() > MAX_TOOL_AUDIT_BYTES
        || sha256_hex_local(audit) != result.tool_audit_digest.0
    {
        return Err("fresh V3 audit path/digest drift".to_owned());
    }
    let parsed_audit: ValidationToolAudit =
        serde_json::from_slice(audit).map_err(|error| error.to_string())?;
    if parsed_audit.schema != "autopilot.tool_audit.v1"
        || parsed_audit.tool_call_id != result.tool_call_id
        || parsed_audit.profile_id != result.terminal_profile_id
        || parsed_audit.tool_name != result.tool_name.0
        || parsed_audit.boundary_id != result.boundary_id.0
        || parsed_audit.result_contract != result.result_contract.0
        || parsed_audit.schema_digest != result.tool_schema_digest.0
        || parsed_audit.binding != result.carrier_binding.0
        || parsed_audit.submission_digest != result.submission_digest.0
    {
        return Err("fresh V3 audit content drift".to_owned());
    }
    let prompt_row = staged_authority_artifact(
        Path::new(&facade.prompt_path),
        &facade.prompt_digest,
        runner::child::MAX_RENDERED_PROMPT_BYTES,
        "autopilot.rendered_prompt.v1",
    )?;
    let spec_row = staged_authority_artifact(
        Path::new(&facade.spec_path),
        &facade.spec_digest,
        runner::child::MAX_AGENT_RUN_SPEC_BYTES,
        "autopilot.agent_run_spec.v5",
    )?;
    // Raw submission/audit are exact PreparedCarrier artifacts. Do not name
    // them twice in the sealed transition.
    Ok(vec![
        assignment_row,
        context_row,
        authority_row,
        prompt_row,
        spec_row,
    ])
}

#[derive(Clone)]
struct ValidationRecoveryFinding {
    finding_id: Id,
    kind: kernel::generated::FindingKindV2,
    effect: kernel::generated::FindingEffect,
    citations: Vec<Ref>,
    summary: String,
    detail: String,
}

fn stage_validation_recovery(
    state: &CoreState,
    binding: &runner::IssuedRunnerBinding,
    producer_assignment_ids: &[Id],
    semantic_round: u32,
    exact_commit: &Sha,
    blockers: &[Id],
    findings: Vec<ValidationRecoveryFinding>,
    continuation_run_revision: u64,
) -> Result<StagedValidationSemantics, String> {
    let producer_id = producer_assignment_ids
        .first()
        .ok_or_else(|| "validation recovery missing producer assignment".to_owned())?;
    let producer =
        strict_recovery_source_binding(state, producer_id).map_err(|error| error.to_string())?;
    let policy =
        crate::repair::SemanticRecoveryPolicy::package().map_err(|error| error.to_string())?;
    let mut refs = vec![
        Ref(binding.assignment_id.0.clone()),
        Ref(producer.assignment_id.0.clone()),
        Ref(format!("blockers={}", ids(blockers))),
    ];
    if producer.role_id.0 == "recovery-engineer" || semantic_round > policy.max_attempts {
        refs.extend([
            Ref("semantic-recovery-exhausted".to_owned()),
            lane_blocker_ref(binding)?,
        ]);
        return Ok(StagedValidationSemantics {
            event_kind: "recovery:exhausted".to_owned(),
            refs,
            effect: DeferredHostEffectV1::Done {
                payload: CoreToHostDonePayload {
                    status: format!("recovery-exhausted:blockers={}", ids(blockers)),
                },
            },
            issues: Vec::new(),
            artifacts: Vec::new(),
            finalization: None,
        });
    }
    let findings = findings
        .into_iter()
        .filter(|finding| {
            finding.effect == kernel::generated::FindingEffect::ForwardBlocking
                && finding.kind != kernel::generated::FindingKindV2::ContextGap
                && finding.kind != kernel::generated::FindingKindV2::UnsafeBoundary
        })
        .collect::<Vec<_>>();
    if findings.is_empty() {
        refs.extend([
            Ref("semantic-recovery-inadmissible".to_owned()),
            lane_blocker_ref(binding)?,
        ]);
        return Ok(StagedValidationSemantics {
            event_kind: "recovery:inadmissible".to_owned(),
            refs,
            effect: DeferredHostEffectV1::Done {
                payload: CoreToHostDonePayload {
                    status: "validation-recovery-inadmissible".to_owned(),
                },
            },
            issues: Vec::new(),
            artifacts: Vec::new(),
            finalization: None,
        });
    }
    let repair_mode = if findings
        .iter()
        .any(|f| f.kind == kernel::generated::FindingKindV2::TestDefect)
    {
        "failed-test"
    } else if findings
        .iter()
        .any(|f| f.kind == kernel::generated::FindingKindV2::ContractDefect)
    {
        "conflict-resolution"
    } else if findings
        .iter()
        .any(|f| f.kind == kernel::generated::FindingKindV2::EvidenceGap)
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
        diagnosis_refs: std::iter::once(Ref(binding.carrier_path.clone()))
            .chain(
                findings
                    .iter()
                    .flat_map(|finding| finding.citations.clone()),
            )
            .collect(),
        diagnosis_ids: findings
            .iter()
            .map(|finding| finding.finding_id.clone())
            .chain(
                blockers
                    .iter()
                    .map(|id| idv(&format!("criterion:{}", id.0))),
            )
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        diagnosis_details: findings
            .iter()
            .map(|finding| {
                format!(
                    "{}: {} — {}",
                    finding.finding_id.0, finding.summary, finding.detail
                )
            })
            .collect(),
        original_gate: format!("validator:{}:semantic-round-1", binding.assignment_id.0),
        attempt_budget: policy.max_attempts,
    };
    let approved_units = read_delivery_assignment_units(&producer)?;
    let assignment = recovery_runner_assignment(
        &producer,
        exact_commit.clone(),
        approved_units,
        directive,
        continuation_run_revision,
    )?;
    let source_v4 = delivery_assignment_v4_for_binding(&producer)?;
    let facts = runner::RunnerTransportFacts::from_env().map_err(|error| error.to_string())?;
    let issue = match source_v4 {
        Some(source) => runner::delivery_issue_v4_with_facts(
            &recovery_v4_assignment(assignment, source),
            &facts,
        ),
        None => runner::delivery_issue_with_facts(&assignment, &facts),
    }
    .map_err(|error| error.to_string())?;
    let artifacts = staged_issue_artifacts(&issue)?;
    refs.extend([
        Ref(format!(
            "recovery-validation-pending:{}",
            binding.assignment_id.0
        )),
        Ref(format!("recovery-trigger:{}", binding.assignment_id.0)),
        Ref(issue.binding.assignment_id.0.clone()),
    ]);
    Ok(StagedValidationSemantics {
        event_kind: "validation:recovery-required".to_owned(),
        refs,
        effect: DeferredHostEffectV1::Spawn {
            payload: CoreToHostSpawnPayload {
                action: issue.action.clone(),
            },
        },
        issues: vec![issue],
        artifacts,
        finalization: None,
    })
}

fn append_unique_refs(refs: &mut Vec<Ref>, values: impl IntoIterator<Item = Ref>) {
    let mut seen = refs
        .iter()
        .map(|reference| reference.0.clone())
        .collect::<BTreeSet<_>>();
    for reference in values {
        if seen.insert(reference.0.clone()) {
            refs.push(reference);
        }
    }
}

fn staged_validation_integration(
    receipt_binding: &runner::ReceiptV1RunnerBinding,
    binding: &runner::IssuedRunnerBinding,
    verdict: &kernel::generated::ValidationVerdict,
) -> Result<
    (
        crate::integration::PreparedCandidate,
        (PathBuf, String, Vec<u8>),
    ),
    String,
> {
    let cwd = fs::canonicalize(std::env::current_dir().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    verify_run_main_stable(&cwd, &binding.workstream.0)?;
    let run_ref = run_main_ref(&binding.workstream.0);
    let plan_path = prepared_validation_integration_path(receipt_binding)?;
    let candidate = crate::integration::CandidateRequest {
        candidate_id: binding.assignment_id.0.clone(),
        enqueue_sequence: 0,
        kind: crate::integration::CandidateKind::ForwardRelease,
        candidate_tip: verdict.exact_commit.0.clone(),
    };
    let root = cwd
        .join(".pi/autopilot")
        .join(&binding.workstream.0)
        .join("integration")
        .join(&binding.assignment_id.0);
    let integrator = crate::integration::ReleaseIntegrator::new(&cwd, &cwd, &run_ref);
    let checks = focused_integration_checks(binding, verdict).map_err(|error| error.to_string())?;
    let (plan, bytes) =
        match runner::read_bounded_file_optional(&plan_path, SUBMIT_RECEIPT_MAX_BYTES)
            .map_err(|error| format!("validation integration plan read: {error}"))?
        {
            Some(bytes) => {
                let plan: PreparedValidationIntegrationV1 = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("validation integration plan JSON: {error}"))?;
                if crate::evidence::canonical_json(&plan).map_err(|error| error.to_string())?
                    != bytes
                    || plan.schema != PREPARED_VALIDATION_INTEGRATION_SCHEMA
                    || plan.run_main_ref != run_ref
                    || plan.candidate_id != candidate.candidate_id
                    || plan.candidate_tip != candidate.candidate_tip
                {
                    return Err("validation integration plan identity drift".to_owned());
                }
                (plan, bytes)
            }
            None => {
                let prepared = integrator
                    .prepare_release(candidate.clone(), &root, &checks)
                    .map_err(|error| format!("validation integration prepare: {error:?}"))?;
                let plan = PreparedValidationIntegrationV1 {
                    schema: PREPARED_VALIDATION_INTEGRATION_SCHEMA.to_owned(),
                    run_main_ref: run_ref.clone(),
                    candidate_id: candidate.candidate_id.clone(),
                    candidate_tip: candidate.candidate_tip.clone(),
                    old_tip: prepared.old_tip,
                    new_tip: prepared.new_tip,
                    tree: prepared.tree,
                    changed_paths: prepared.changed_paths,
                };
                let bytes =
                    crate::evidence::canonical_json(&plan).map_err(|error| error.to_string())?;
                // Plan first, CAS second. A retry can now prove the exact pair.
                runner::write_bounded_file_create_once(
                    &plan_path,
                    &bytes,
                    SUBMIT_RECEIPT_MAX_BYTES,
                )
                .map_err(|error| format!("validation integration plan write: {error}"))?;
                (plan, bytes)
            }
        };
    let current = git_stdout(
        &cwd,
        &["rev-parse", "--verify", &format!("{run_ref}^{{commit}}")],
    )
    .map_err(|error| format!("validation integration run-main read: {error}"))?;
    let current = current.trim();
    if current == plan.old_tip {
        let prepared = crate::integration::PreparedCandidate {
            request: candidate.clone(),
            old_tip: plan.old_tip.clone(),
            new_tip: plan.new_tip.clone(),
            tree: plan.tree.clone(),
            changed_paths: plan.changed_paths.clone(),
        };
        integrator
            .cas_release(&prepared)
            .map_err(|error| format!("validation integration CAS: {error:?}"))?;
    } else if current != plan.new_tip {
        return Err(format!(
            "validation integration moved-ref conflict: expected old={} or new={}, got={current}",
            plan.old_tip, plan.new_tip
        ));
    }
    let prepared = crate::integration::PreparedCandidate {
        request: candidate,
        old_tip: plan.old_tip.clone(),
        new_tip: plan.new_tip.clone(),
        tree: plan.tree.clone(),
        changed_paths: plan.changed_paths.clone(),
    };
    Ok((
        prepared,
        (
            plan_path,
            PREPARED_VALIDATION_INTEGRATION_SCHEMA.to_owned(),
            bytes,
        ),
    ))
}

/// Exact semantic predicates shared with the historical integration path.
/// The only new input is the receipt-sealed PreparedCandidate; no source,
/// package, or carrier is reread after the child admission turn.
fn validation_integration_semantic_refs(
    state: &CoreState,
    binding: &runner::IssuedRunnerBinding,
    verdict: &kernel::generated::ValidationVerdict,
    prepared: &crate::integration::PreparedCandidate,
) -> Result<Vec<Ref>, String> {
    let lane_id = binding
        .lane_id
        .as_ref()
        .ok_or_else(|| "fresh Validator integration lacks required lane authority".to_owned())?;
    let change = crate::staleness::MergeChange {
        changed_paths: prepared.changed_paths.clone(),
        changed_surfaces: prepared.changed_paths.clone(),
        affected_forward_edges: vec![format!("edge:{}", lane_id.0)],
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
    let closure_bundle = closure_bundle_for_integration(prepared, &stale)?;
    let policy = crate::closure::RepairPolicy::package()
        .map_err(|error| format!("closure-policy:{error:?}"))?;
    let mut ledger = crate::closure::RepairLedger::new(policy);
    let repair_route = ledger.record_fix_attempt(&closure_bundle);
    Ok(vec![
        Ref("module-wired:integration".to_owned()),
        Ref("module-wired:staleness".to_owned()),
        Ref("module-wired:closure".to_owned()),
        Ref("module-wired:repair".to_owned()),
        Ref(prepared.request.candidate_id.clone()),
        Ref(prepared.old_tip.clone()),
        Ref(prepared.new_tip.clone()),
        Ref(prepared.tree.clone()),
        Ref(format!("stale:{}", stale.stale.len())),
        Ref(format!("repair-route:{repair_route:?}")),
        Ref(format!("unit-closed:{}", lane_id.0)),
    ]
    .into_iter()
    .chain(
        satisfied_forward_gate_refs(&binding.workstream.0, Some(lane_id), state)
            .map_err(|error| error.to_string())?,
    )
    .collect())
}

struct StagedValidationNextEffect {
    refs: Vec<Ref>,
    effect: DeferredHostEffectV1,
    issues: Vec<runner::IssuedRunnerAction>,
    artifacts: Vec<(PathBuf, String, Vec<u8>)>,
    finalization: Option<PreparedValidationFinalizationV1>,
}

fn staged_validation_done_effect(
    mut refs: Vec<Ref>,
    status: String,
    receipt_binding: &runner::ReceiptV1RunnerBinding,
    binding: &runner::IssuedRunnerBinding,
) -> Result<StagedValidationNextEffect, String> {
    let mut artifacts = Vec::new();
    let finalization = if status.starts_with("lifecycle:close:result_ref=") {
        let (finalization, path, bytes) = read_prepared_validation_finalization(receipt_binding)?
            .ok_or_else(|| {
            "fresh Validator close lacks prepared finalization intent".to_owned()
        })?;
        if finalization.workstream != binding.workstream.0 {
            return Err("fresh Validator finalization workstream drift".to_owned());
        }
        verify_result_ref(&finalization.result_ref, &finalization.tip)
            .map_err(|error| error.to_string())?;
        append_unique_refs(&mut refs, validation_finalization_refs(&finalization));
        artifacts.push((
            path,
            PREPARED_VALIDATION_FINALIZATION_SCHEMA.to_owned(),
            bytes,
        ));
        Some(finalization)
    } else {
        None
    };
    Ok(StagedValidationNextEffect {
        refs,
        effect: DeferredHostEffectV1::Done {
            payload: CoreToHostDonePayload { status },
        },
        issues: Vec::new(),
        artifacts,
        finalization,
    })
}

/// Select the post-integration delivery continuation against a private
/// projection containing the sealed unit-close evidence. The selected action
/// revision is the immutable parent receipt generation plus one, never the
/// projected event/root revision.
fn stage_next_delivery_after_validation_integration(
    state: &CoreState,
    receipt_binding: &runner::ReceiptV1RunnerBinding,
    binding: &runner::IssuedRunnerBinding,
    verdict: &kernel::generated::ValidationVerdict,
    prepared: &crate::integration::PreparedCandidate,
    continuation_run_revision: u64,
) -> Result<StagedValidationNextEffect, String> {
    let integration_refs = validation_integration_semantic_refs(state, binding, verdict, prepared)?;
    let mut projected = CoreState {
        event_path: None,
        state: state.state.clone(),
        events: state.events.clone(),
        event_bytes: state.event_bytes.clone(),
        blocked_latches: state.blocked_latches.clone(),
        blocked_reporter_tool_calls: state.blocked_reporter_tool_calls.clone(),
        blocked_projection_error: state.blocked_projection_error,
    };
    // The current Validator is terminal for all post-integration predicates
    // even though the real terminal row is deliberately deferred until the
    // receipt is rooted. Without this private consumption projection, the
    // final lane can never reach lifecycle readiness before ACCEPT.
    projected
        .append(
            EventKind("submit:receipt-projected".to_owned()),
            vec![terminal_consumed_ref(binding)],
        )
        .map_err(|error| error.to_string())?;
    projected
        .append(
            EventKind("integration:forward-integrated".to_owned()),
            integration_refs.clone(),
        )
        .map_err(|error| error.to_string())?;
    // A finalization intent is written before the result-ref CAS. On a
    // crash/response-loss retry it is the sole authority for publication: do
    // not re-run final checks, source/package reads, or lifecycle selection.
    if let Some((finalization, _, _)) = read_prepared_validation_finalization(receipt_binding)? {
        if finalization.workstream != binding.workstream.0
            || finalization.tip != prepared.new_tip
            || finalization.close_signal != exact_close_signal(&finalization.result_ref)
        {
            return Err("fresh Validator prepared finalization/integration drift".to_owned());
        }
        let publication = PublicationPrepared {
            schema: "PublicationPrepared".to_owned(),
            run_id: finalization.run_id.clone(),
            tip: finalization.tip.clone(),
            result_ref: finalization.result_ref.clone(),
            gate_digest: finalization.gate_digest.clone(),
        };
        let result =
            publish_prepared_result_ref(&binding.workstream.0, &publication, &mut projected)
                .map_err(|error| error.to_string())?;
        return staged_validation_done_effect(
            integration_refs,
            exact_close_signal(&result.name),
            receipt_binding,
            binding,
        );
    }
    // This is the legacy ordering: closure readiness is evaluated immediately
    // after integration, before allocation attempts to describe any remaining
    // lane. A fully closed one-lane plan has zero open allocation lanes.
    if let Some(status) = advance_lifecycle_if_ready_with_finalization(
        &binding.workstream.0,
        None,
        ClosureTrigger::IntegrationComplete,
        &mut projected,
        Some(receipt_binding),
    )
    .map_err(|error| error.to_string())?
    {
        return staged_validation_done_effect(integration_refs, status, receipt_binding, binding);
    }
    let approved_artifact = read_approved_plan_artifact(&binding.workstream.0, &projected)
        .map_err(|error| format!("next delivery approved plan: {error}"))?;
    let approved = approved_artifact.units();
    let submission = allocation_submission_from_plan(&binding.workstream.0, approved, &projected)?;
    let allocation = allocation::validate_allocation(
        approved,
        &submission,
        AllocationPolicy {
            parallel_cap: 8,
            active_implementers: active_implementers(&projected),
        },
    )
    .map_err(|error| format!("next delivery allocation: {error:?}"))?;
    let readiness = lane_readiness_from_events(&submission.lanes, approved, &projected);
    let resources = host_resource_facts()?;
    let mut selected = dispatch::select_ready_lanes(&DispatchInput {
        lanes: allocation.lanes,
        readiness: readiness.clone(),
        active_implementers: active_implementers(&projected),
        parallel_cap: 8,
        resources,
    });
    selected.retain(|lane| !lane_closed(&projected, lane));
    let mut dispatchable = Vec::new();
    for lane in selected {
        if !lane_has_live_delivery(&projected, &lane)? {
            dispatchable.push(lane);
        }
    }
    let selected = dispatchable;
    let Some(lane_id) = selected.first() else {
        if let Some(status) = advance_lifecycle_if_ready_with_finalization(
            &binding.workstream.0,
            None,
            ClosureTrigger::IntegrationComplete,
            &mut projected,
            Some(receipt_binding),
        )
        .map_err(|error| error.to_string())?
        {
            return staged_validation_done_effect(
                integration_refs,
                status,
                receipt_binding,
                binding,
            );
        }
        let status = if active_or_unknown_work(&projected) || queued_candidates(&projected) > 0 {
            format!(
                "dispatch:waiting:{};{}",
                advance_diagnostics(&projected, &submission, approved, &readiness, &selected),
                projected.summary()
            )
        } else {
            rejection(
                "dispatch-stuck",
                &format!(
                    "{};{}",
                    advance_diagnostics(&projected, &submission, approved, &readiness, &selected),
                    projected.summary()
                ),
            )
        };
        return Ok(StagedValidationNextEffect {
            refs: integration_refs,
            effect: DeferredHostEffectV1::Done {
                payload: CoreToHostDonePayload { status },
            },
            issues: Vec::new(),
            artifacts: Vec::new(),
            finalization: None,
        });
    };
    let facts = runner::RunnerTransportFacts::from_env().map_err(|error| error.to_string())?;
    let issue = match &approved_artifact {
        ApprovedPlanAuthority::V1(_) => {
            let mut assignment = assignment(&binding.workstream.0, lane_id, approved, &submission)
                .map_err(|error| error.to_string())?;
            assignment.run_revision = continuation_run_revision;
            runner::delivery_issue_with_facts(&assignment, &facts)
        }
        ApprovedPlanAuthority::V2 { artifact, root } => {
            let mut assignment = assignment_v4(
                &binding.workstream.0,
                lane_id,
                approved,
                &submission,
                artifact,
                root,
            )
            .map_err(|error| error.to_string())?;
            assignment.run_revision = continuation_run_revision;
            runner::delivery_issue_v4_with_facts(&assignment, &facts)
        }
    }
    .map_err(|error| error.to_string())?;
    if issue.action.run_revision != continuation_run_revision
        || issue.receipt_binding.run_revision != continuation_run_revision
        || issue.binding.run_revision != continuation_run_revision
    {
        return Err("next delivery action/binding continuation revision drift".to_owned());
    }
    let artifacts = staged_issue_artifacts(&issue)?;
    let mut refs = integration_refs;
    refs.extend([
        Ref("delivery:next-required".to_owned()),
        Ref(issue.binding.assignment_id.0.clone()),
        Ref(issue.binding.action_id.0.clone()),
    ]);
    Ok(StagedValidationNextEffect {
        refs,
        effect: DeferredHostEffectV1::Spawn {
            payload: CoreToHostSpawnPayload {
                action: issue.action.clone(),
            },
        },
        issues: vec![issue],
        artifacts,
        finalization: None,
    })
}

fn commit_staged_validation_submit(
    state: &mut CoreState,
    request: &ChildControlRequest,
    binding: &runner::ReceiptV1RunnerBinding,
    _facade: &kernel::generated::AgentRunSpec,
    raw: &[u8],
    prepared: runner::child::PreparedCarrier,
) -> Result<SubmitReceipt, SubmitDiagnostic> {
    let legacy = runner::receipt_v1_validator_facade(binding);
    if terminal_consumed(state, &legacy) {
        return Err(validation_staging_retry(
            "submit.already_consumed",
            "",
            "Validator binding is already terminal",
        ));
    }
    let carrier_bytes = crate::evidence::canonical_json(&prepared.carrier).map_err(|error| {
        validation_staging_retry("submit.canonical_json", "/raw_payload", error.to_string())
    })?;
    let continuation = receipt_v1_continuation_run_revision(binding)
        .map_err(|error| validation_staging_retry("submit.validation_transition", "", error))?;
    let audit_path = PathBuf::from(&legacy.carrier_path).with_extension("tool-audit.json");
    let audit = exact_prepared_artifact(&prepared.artifacts, &audit_path).map_err(|error| {
        validation_staging_retry("submit.validation_audit", "/tool_audit_ref", error)
    })?;
    let (semantic, mut authority_artifacts, carrier_schema) = if binding.result_contract.0
        == "autopilot.validation_result.v2"
    {
        let result: kernel::generated::ValidationResultV2 =
            serde_json::from_value(prepared.carrier.clone()).map_err(|error| {
                validation_staging_retry(
                    "submit.validation_carrier",
                    "/raw_payload",
                    error.to_string(),
                )
            })?;
        let raw_path = PathBuf::from(result.assignment_path.0.clone())
            .parent()
            .ok_or_else(|| {
                validation_staging_retry(
                    "submit.validation_submission",
                    "",
                    "V2 assignment path has no parent",
                )
            })?
            .join("model-submission.json");
        let raw_submission =
            exact_prepared_artifact(&prepared.artifacts, &raw_path).map_err(|error| {
                validation_staging_retry(
                    "submit.validation_submission",
                    "/model_submission_path",
                    error,
                )
            })?;
        let raw_value: serde_json::Value =
            serde_json::from_slice(&raw_submission).map_err(|error| {
                validation_staging_retry("submit.validation_submission", "", error.to_string())
            })?;
        if raw_value
            != serde_json::to_value(&result.submission).map_err(|error| {
                validation_staging_retry("submit.validation_submission", "", error.to_string())
            })?
        {
            return Err(validation_staging_retry(
                "submit.validation_submission",
                "",
                "V2 raw/staged submission equality drift",
            ));
        }
        let rows =
            validate_validation_result_v2_staged(&result, binding, &audit).map_err(|error| {
                validation_staging_retry("submit.validation_parent_predicate", "", error)
            })?;
        let blockers = validation_blockers(&result);
        let semantic = if result.submission.outcome
            == kernel::generated::ValidationOutcomeV2::FORWARDREADY
            && blockers.is_empty()
        {
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
            let (integration_prepared, integration) =
                staged_validation_integration(binding, &legacy, &verdict).map_err(|error| {
                    validation_staging_retry("submit.validation_integration", "", error)
                })?;
            let next = stage_next_delivery_after_validation_integration(
                state,
                binding,
                &legacy,
                &verdict,
                &integration_prepared,
                continuation,
            )
            .map_err(|error| {
                validation_staging_retry("submit.validation_next_effect", "", error)
            })?;
            let mut refs = next.refs.clone();
            append_unique_refs(
                &mut refs,
                std::iter::once(Ref(result.exact_commit.0.clone()))
                    .chain(std::iter::once(Ref(result.exact_tree.0.clone())))
                    .chain(std::iter::once(Ref(format!(
                        "submission-digest:{}",
                        result.submission_digest.0
                    ))))
                    .chain(std::iter::once(Ref(format!(
                        "audit-digest:{}",
                        result.tool_audit_digest.0
                    ))))
                    .chain(
                        result
                            .submission
                            .criterion_results
                            .iter()
                            .flat_map(|criterion| criterion.evidence_refs.clone()),
                    )
                    .chain(
                        result
                            .submission
                            .findings
                            .iter()
                            .flat_map(|finding| finding.evidence_refs.clone()),
                    ),
            );
            append_unique_refs(&mut refs, next.refs);
            let transcript =
                staged_validation_transcript(&legacy, &carrier_bytes).map_err(|error| {
                    validation_staging_retry("submit.validation_transcript", "", error)
                })?;
            append_unique_refs(
                &mut refs,
                std::iter::once(Ref(transcript.0.display().to_string())),
            );
            let mut artifacts = vec![integration, transcript];
            artifacts.extend(next.artifacts);
            StagedValidationSemantics {
                event_kind: "integration:forward-integrated".to_owned(),
                refs,
                effect: next.effect,
                issues: next.issues,
                artifacts,
                finalization: next.finalization,
            }
        } else if result.submission.outcome != kernel::generated::ValidationOutcomeV2::FORWARDREADY
            && !blockers.is_empty()
        {
            let findings = result
                .submission
                .findings
                .iter()
                .map(|finding| ValidationRecoveryFinding {
                    finding_id: finding.finding_id.clone(),
                    kind: finding.kind.clone(),
                    effect: finding.effect.clone(),
                    citations: finding.evidence_refs.clone(),
                    summary: finding.summary.clone(),
                    detail: finding.detail.clone(),
                })
                .collect();
            stage_validation_recovery(
                state,
                &legacy,
                &result.producer_assignment_ids,
                result.semantic_round,
                &Sha(result.exact_commit.0.clone()),
                &blockers,
                findings,
                continuation,
            )
            .map_err(|error| validation_staging_retry("submit.validation_recovery", "", error))?
        } else {
            return Err(validation_staging_retry(
                "submit.validation_verdict",
                "/outcome",
                "V2 outcome/blocker incoherence",
            ));
        };
        (semantic, rows, "autopilot.validation_result.v2")
    } else {
        let result: kernel::generated::ValidationResultV3 =
            serde_json::from_value(prepared.carrier.clone()).map_err(|error| {
                validation_staging_retry(
                    "submit.validation_carrier",
                    "/raw_payload",
                    error.to_string(),
                )
            })?;
        let raw_path = PathBuf::from(result.assignment_path.0.clone())
            .parent()
            .ok_or_else(|| {
                validation_staging_retry(
                    "submit.validation_submission",
                    "",
                    "assignment path has no parent",
                )
            })?
            .join("model-submission.v3.json");
        let raw_submission =
            exact_prepared_artifact(&prepared.artifacts, &raw_path).map_err(|error| {
                validation_staging_retry(
                    "submit.validation_submission",
                    "/model_submission_path",
                    error,
                )
            })?;
        let rows = validate_validation_result_v3_staged(&result, binding, &raw_submission, &audit)
            .map_err(|error| {
                validation_staging_retry("submit.validation_parent_predicate", "", error)
            })?;
        let blockers = validation_blockers_v3(&result);
        let semantic = if result.verdict.outcome
            == kernel::generated::ValidationOutcomeV2::FORWARDREADY
            && blockers.is_empty()
        {
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
            let (integration_prepared, integration) =
                staged_validation_integration(binding, &legacy, &verdict).map_err(|error| {
                    validation_staging_retry("submit.validation_integration", "", error)
                })?;
            let next = stage_next_delivery_after_validation_integration(
                state,
                binding,
                &legacy,
                &verdict,
                &integration_prepared,
                continuation,
            )
            .map_err(|error| {
                validation_staging_retry("submit.validation_next_effect", "", error)
            })?;
            let mut refs = next.refs.clone();
            append_unique_refs(
                &mut refs,
                std::iter::once(Ref(result.exact_commit.0.clone()))
                    .chain(std::iter::once(Ref(result.exact_tree.0.clone())))
                    .chain(std::iter::once(Ref(format!(
                        "submission-digest:{}",
                        result.submission_digest.0
                    ))))
                    .chain(std::iter::once(Ref(format!(
                        "verdict-digest:{}",
                        result.verdict_digest.0
                    ))))
                    .chain(std::iter::once(Ref(format!(
                        "audit-digest:{}",
                        result.tool_audit_digest.0
                    ))))
                    .chain(std::iter::once(Ref(format!(
                        "authority-digest:{}",
                        result.authority_digest.0
                    ))))
                    .chain(
                        result
                            .verdict
                            .criterion_results
                            .iter()
                            .flat_map(|criterion| {
                                criterion
                                    .model_citation_refs
                                    .iter()
                                    .chain(&criterion.command_receipt_refs)
                                    .chain(&criterion.package_check_receipt_refs)
                                    .cloned()
                            }),
                    )
                    .chain(
                        result
                            .verdict
                            .findings
                            .iter()
                            .flat_map(|finding| finding.citation_refs.clone()),
                    ),
            );
            append_unique_refs(&mut refs, next.refs);
            let transcript =
                staged_validation_transcript(&legacy, &carrier_bytes).map_err(|error| {
                    validation_staging_retry("submit.validation_transcript", "", error)
                })?;
            append_unique_refs(
                &mut refs,
                std::iter::once(Ref(transcript.0.display().to_string())),
            );
            let mut artifacts = vec![integration, transcript];
            artifacts.extend(next.artifacts);
            StagedValidationSemantics {
                event_kind: "integration:forward-integrated".to_owned(),
                refs,
                effect: next.effect,
                issues: next.issues,
                artifacts,
                finalization: next.finalization,
            }
        } else if result.verdict.outcome != kernel::generated::ValidationOutcomeV2::FORWARDREADY
            && !blockers.is_empty()
        {
            let findings = result
                .verdict
                .findings
                .iter()
                .map(|finding| ValidationRecoveryFinding {
                    finding_id: finding.finding_id.clone(),
                    kind: finding.kind.clone(),
                    effect: finding.effect.clone(),
                    citations: finding.citation_refs.clone(),
                    summary: finding.summary.clone(),
                    detail: finding.detail.clone(),
                })
                .collect();
            stage_validation_recovery(
                state,
                &legacy,
                &result.producer_assignment_ids,
                result.semantic_round,
                &Sha(result.exact_commit.0.clone()),
                &blockers,
                findings,
                continuation,
            )
            .map_err(|error| validation_staging_retry("submit.validation_recovery", "", error))?
        } else {
            return Err(validation_staging_retry(
                "submit.validation_verdict",
                "/verdict/outcome",
                "V3 outcome/blocker incoherence",
            ));
        };
        (semantic, rows, "autopilot.validation_result.v3")
    };
    let sidecar = PreparedValidationTransitionV1 {
        schema: PREPARED_VALIDATION_TRANSITION_SCHEMA.to_owned(),
        event_kind: semantic.event_kind.clone(),
        refs: semantic.refs.clone(),
        finalization: semantic.finalization.clone(),
    };
    validate_validation_transition(&sidecar)
        .map_err(|error| validation_staging_retry("submit.validation_transition", "", error))?;
    let sidecar_path = prepared_validation_transition_path(binding)
        .map_err(|error| validation_staging_retry("submit.validation_transition", "", error))?;
    let sidecar_bytes = crate::evidence::canonical_json(&sidecar).map_err(|error| {
        validation_staging_retry("submit.canonical_json", "", error.to_string())
    })?;
    let mut staged_artifacts = prepared
        .artifacts
        .iter()
        .map(|artifact| {
            prepared_artifact_bytes(artifact).map(|(path, bytes)| {
                (
                    path,
                    "autopilot.staged_submit_artifact.v1".to_owned(),
                    bytes,
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| validation_staging_retry("submit.validation_artifact", "", error))?;
    staged_artifacts.append(&mut authority_artifacts);
    staged_artifacts.extend(semantic.artifacts.clone());
    staged_artifacts.push((
        sidecar_path,
        PREPARED_VALIDATION_TRANSITION_SCHEMA.to_owned(),
        sidecar_bytes,
    ));
    let issued_actions = semantic
        .issues
        .iter()
        .map(|issue| {
            let binding_bytes =
                crate::evidence::canonical_json(&issue.receipt_binding).map_err(|error| {
                    validation_staging_retry("submit.canonical_json", "", error.to_string())
                })?;
            Ok(PreparedSubmitIssuedAction {
                action_ref: issued_action_ref(&issue.action, &issue.receipt_binding)
                    .map_err(|error| validation_staging_retry("submit.issued_action", "", error))?,
                action: issue.action.clone(),
                binding_ref: runner::receipt_binding_ref(&issue.receipt_binding).map_err(
                    |error| {
                        validation_staging_retry("submit.issued_binding", "", error.to_string())
                    },
                )?,
                binding_digest: Digest(sha256_hex_local(&binding_bytes)),
            })
        })
        .collect::<Result<Vec<_>, SubmitDiagnostic>>()?;
    let carrier_artifact = artifact_ref(
        Path::new(&legacy.carrier_path),
        carrier_schema,
        &carrier_bytes,
    );
    let artifact_refs = staged_artifacts
        .iter()
        .map(|(path, schema, bytes)| artifact_ref(path, schema, bytes))
        .collect::<Vec<_>>();
    let transition_path = submit_transition_path(binding)
        .map_err(|error| validation_staging_retry("submit.transition_path", "", error))?;
    let effect = semantic.effect;
    let transition_body = serde_json::json!({ "schema": "autopilot.prepared_submit_transition_body.v1", "carrier": carrier_artifact, "artifact_refs": artifact_refs, "issued_actions": issued_actions, "deferred_host_effect": effect });
    let transition_bytes = crate::evidence::canonical_json(&transition_body).map_err(|error| {
        validation_staging_retry("submit.canonical_json", "", error.to_string())
    })?;
    let receipt = SubmitReceipt {
        schema: SchemaId("autopilot.submit_receipt.v1".to_owned()),
        receipt_id: crate::state_root::fresh_uuid_v7().map_err(|error| {
            validation_staging_retry("submit.receipt_id", "", error.to_string())
        })?,
        run_id: binding.run_id.clone(),
        run_revision: binding.run_revision,
        workstream: binding.workstream.clone(),
        action_id: binding.action_id.clone(),
        assignment_id: binding.assignment_id.clone(),
        attempt: binding.attempt,
        profile_id: binding.profile_id.clone(),
        tool_name: binding.tool_name.clone(),
        boundary_id: binding.boundary_id.clone(),
        result_contract: binding.result_contract.clone(),
        schema_digest: Digest(binding.schema_digest.clone()),
        spec_digest: Digest(binding.spec_digest.clone()),
        carrier_binding_digest: Digest(binding.carrier_binding_digest.clone()),
        authority_digest: Digest(binding.authority_digest.clone()),
        frozen_validator_versions: vec![SubmitReceiptValidatorVersion {
            validator_id: Id("validation-parent-stage".to_owned()),
            version: "v1".to_owned(),
            digest: Digest(sha256_hex_local(b"validation-parent-stage:v1")),
        }],
        raw_payload_digest: Digest(sha256_hex_local(raw)),
        raw_payload_byte_count: raw.len() as u64,
        request_id: request.request_id.clone(),
        tool_call_id: request.tool_call_id.clone(),
        prepared_transition: PreparedSubmitTransitionV1 {
            schema: SchemaId("autopilot.prepared_submit_transition.v1".to_owned()),
            transition_ref: Ref(transition_path.display().to_string()),
            transition_digest: Digest(sha256_hex_local(&transition_bytes)),
            carrier: carrier_artifact,
            artifact_refs,
            issued_actions,
            deferred_host_effect: effect,
        },
    };
    let receipt_bytes = crate::evidence::canonical_json(&receipt).map_err(|error| {
        validation_staging_retry("submit.canonical_json", "", error.to_string())
    })?;
    runner::write_bounded_file_create_once(
        Path::new(&legacy.carrier_path),
        &carrier_bytes,
        MAX_TERMINAL_CARRIER_BYTES,
    )
    .map_err(|error| validation_staging_retry("submit.carrier_write", "", error.to_string()))?;
    for (path, _, bytes) in &staged_artifacts {
        runner::write_bounded_file_create_once(path, bytes, SUBMIT_RECEIPT_MAX_BYTES).map_err(
            |error| validation_staging_retry("submit.artifact_write", "", error.to_string()),
        )?;
    }
    runner::write_bounded_file_create_once(
        &transition_path,
        &transition_bytes,
        SUBMIT_RECEIPT_MAX_BYTES,
    )
    .map_err(|error| validation_staging_retry("submit.transition_write", "", error.to_string()))?;
    let receipt_path = submit_receipt_path(binding)
        .map_err(|error| validation_staging_retry("submit.receipt_path", "", error))?;
    runner::write_bounded_file_create_once(&receipt_path, &receipt_bytes, SUBMIT_RECEIPT_MAX_BYTES)
        .map_err(|error| validation_staging_retry("submit.receipt_write", "", error.to_string()))?;
    root_or_verify_submit_receipt(state, &receipt, binding)
        .map_err(|error| validation_staging_retry("submit.receipt_root", "", error))?;
    Ok(receipt)
}

#[derive(Clone)]
struct StagedPlanningSemantics {
    event_kind: String,
    refs: Vec<Ref>,
    artifacts: Vec<(PathBuf, String, Vec<u8>)>,
}

#[derive(Clone)]
struct StagedPlanningEffect {
    effect: DeferredHostEffectV1,
    issues: Vec<runner::IssuedRunnerAction>,
    artifacts: Vec<(PathBuf, String, Vec<u8>)>,
}

/// Stage every legacy planning-only semantic branch before any receipt
/// artifact is published.  This is intentionally a branch-by-boundary match:
/// V1/V2 and ordinary/recovery are selected from the issued binding, never
/// from the shape of model bytes.
fn stage_planning_semantics(
    state: &CoreState,
    binding: &runner::IssuedRunnerBinding,
    carrier: &AgentCarrier,
    _v2_admission: Option<&planning::ApprovedWorkMapV2>,
    recovery: PlanningRecoveryAdmission,
) -> Result<StagedPlanningSemantics, (String, String)> {
    let assignment = planning_assignment_for(&binding.workstream.0, &binding.assignment_id.0)
        .map_err(|error| {
            (
                "".to_owned(),
                format!("planning assignment authority: {error}"),
            )
        })?;
    let assignment_boundary = assignment.boundary_id.as_deref().ok_or_else(|| {
        (
            "".to_owned(),
            "planning manifest boundary authority is absent".to_owned(),
        )
    })?;
    let binding_attempt = binding.attempt.ok_or_else(|| {
        (
            "".to_owned(),
            "fresh planning binding attempt authority is absent".to_owned(),
        )
    })?;
    if assignment.role != binding.role_id.0
        || assignment.mode != binding.mode.0
        || assignment_boundary != binding.boundary_id.0
        || assignment_boundary != binding.result_contract.0
        || u32::from(assignment.ordinal) != binding_attempt
    {
        return Err((
            "".to_owned(),
            "planning manifest role/mode/boundary/result-contract/ordinal authority drift"
                .to_owned(),
        ));
    }
    let mut refs = vec![
        Ref(binding.assignment_id.0.clone()),
        Ref(binding.action_id.0.clone()),
        Ref(binding.boundary_id.0.clone()),
        Ref(binding.workstream.0.clone()),
        Ref(binding.spec_digest.clone()),
    ];
    let mut artifacts = Vec::new();

    if let PlanningRecoveryAdmission::FailClosed(disposition) = recovery {
        refs.extend([
            Ref(carrier.carrier_path.clone()),
            Ref(format!("recovery-disposition:{disposition:?}")),
            recovery_disposition_failure_ref(&disposition),
            Ref("semantic-recovery-fail-closed".to_owned()),
        ]);
        return Ok(StagedPlanningSemantics {
            event_kind: "recovery:inadmissible".to_owned(),
            refs,
            artifacts,
        });
    }

    if carrier.boundary_id == "planning.work-map.v1"
        && is_canonical_output_assignment(
            &carrier.workstream,
            &carrier.assignment_id,
            &carrier.boundary_id,
        )
        .map_err(|error| ("".to_owned(), error))?
    {
        let path = if carrier.role_id == "recovery-engineer" {
            recovery_work_map_path(&carrier.workstream)
        } else {
            work_map_path(&carrier.workstream)
        };
        artifacts.push((
            path,
            "autopilot.planning_work_map.v1".to_owned(),
            carrier.raw_output.as_bytes().to_vec(),
        ));
    }

    if carrier.boundary_id != "planning.plan-review.v1" {
        if carrier.role_id == "recovery-engineer"
            && carrier.mode == "planning-repair"
            && matches!(
                carrier.boundary_id.as_str(),
                "planning.work-map.v1" | "planning.work-map.v2"
            )
        {
            let baseline_path = binding.planning_subject_path.as_ref().ok_or_else(|| {
                (
                    "/recovery".to_owned(),
                    "planning recovery baseline path missing".to_owned(),
                )
            })?;
            let baseline_digest = binding.planning_subject_digest.as_ref().ok_or_else(|| {
                (
                    "/recovery".to_owned(),
                    "planning recovery baseline digest missing".to_owned(),
                )
            })?;
            refs.extend([
                Ref("planning-rereview-required".to_owned()),
                Ref(format!("recovery-baseline-carrier:{baseline_path}")),
                Ref(format!("recovery-baseline-sha256:{baseline_digest}")),
                Ref(format!(
                    "recovery-output-sha256:{}",
                    sha256_hex_local(carrier.raw_output.as_bytes())
                )),
            ]);
            return Ok(StagedPlanningSemantics {
                event_kind: "planning:recovery-completed".to_owned(),
                refs,
                artifacts,
            });
        }
        return Ok(StagedPlanningSemantics {
            event_kind: "agent:result".to_owned(),
            refs,
            artifacts,
        });
    }

    let review_error = review_approves_execution(&carrier.raw_output).err();
    let is_first_review = assignment.role == "plan-reviewer" && assignment.ordinal == 1;
    let is_final_review = assignment.role == "plan-reviewer" && assignment.ordinal == 2;
    if let Some(error) = review_error {
        if !error.starts_with("plan-review:blocked:") {
            return Err(("/verdicts".to_owned(), error));
        }
        if is_first_review {
            let baseline_path = binding.planning_subject_path.as_ref().ok_or_else(|| {
                (
                    "/verdicts".to_owned(),
                    "planning recovery baseline path missing".to_owned(),
                )
            })?;
            let baseline_digest = binding.planning_subject_digest.as_ref().ok_or_else(|| {
                (
                    "/verdicts".to_owned(),
                    "planning recovery baseline digest missing".to_owned(),
                )
            })?;
            refs.extend([
                Ref("planning-recovery-required".to_owned()),
                Ref(format!("recovery-baseline-carrier:{baseline_path}")),
                Ref(format!("recovery-baseline-sha256:{baseline_digest}")),
                Ref(format!("rejected-review-carrier:{}", carrier.carrier_path)),
                Ref(format!("rejected-review-diagnosis:{error}")),
            ]);
            return Ok(StagedPlanningSemantics {
                event_kind: "planning:recovery-required".to_owned(),
                refs,
                artifacts,
            });
        }
        if is_final_review {
            refs.extend([
                Ref(carrier.carrier_path.clone()),
                Ref("semantic-recovery-exhausted".to_owned()),
            ]);
            return Ok(StagedPlanningSemantics {
                event_kind: "recovery:exhausted".to_owned(),
                refs,
                artifacts,
            });
        }
        return Err((
            "/verdicts".to_owned(),
            "review ordinal authority drift".to_owned(),
        ));
    }

    let subject_is_v2 = planning_subject_is_v2(binding)
        .map_err(|error| ("".to_owned(), format!("planning review subject: {error}")))?;
    if subject_is_v2 {
        // The review subject is an earlier event-rooted receipt carrier. Re-
        // admit its exact immutable bytes, then build (but do not publish) the
        // V2 image/binding for the enclosing receipt transaction.
        let subject = v2_subject_binding(state, binding)
            .map_err(|error| ("".to_owned(), format!("approved-plan-v2 subject: {error}")))?;
        let admitted = admit_v2_work_map(state, &subject, true).map_err(|error| {
            (
                "".to_owned(),
                format!("approved-plan-v2 admission: {error}"),
            )
        })?;
        let root = std::env::current_dir()
            .map_err(|error| ("".to_owned(), error.to_string()))?
            .join(".pi/autopilot")
            .join(&binding.workstream.0);
        let staged = approved_plan_v2::stage_approved_plan_v2(
            &binding.workstream.0,
            &root.join("approved-plan.v2.json"),
            &root.join("approved-plan.v2-binding.json"),
            &admitted,
        )
        .map_err(|error| ("".to_owned(), format!("approved-plan-v2: {error}")))?;
        let promotion = staged.promotion.clone();
        artifacts.extend([
            (
                staged.image_path,
                approved_plan_v2::APPROVED_PLAN_V2_SCHEMA.to_owned(),
                staged.image_bytes,
            ),
            (
                staged.binding_path,
                approved_plan_v2::APPROVED_PLAN_V2_BINDING_SCHEMA.to_owned(),
                staged.binding_bytes,
            ),
        ]);
        let ready_root = ApprovedPlanV2ReadyRootV1 {
            schema: APPROVED_PLAN_V2_READY_ROOT_SCHEMA.to_owned(),
            workstream: carrier.workstream.clone(),
            binding_path: promotion.binding_path.display().to_string(),
            binding_sha256: promotion.binding_sha256,
            approved_plan_sha256: promotion.approved_plan_sha256,
            final_review_action_id: binding.action_id.0.clone(),
            final_review_assignment_id: binding.assignment_id.0.clone(),
            final_review_run_revision: binding.run_revision,
        };
        refs.extend([
            approved_plan_v2_ready_root_ref(&ready_root).map_err(|error| ("".to_owned(), error))?,
            Ref(ready_root.binding_path),
        ]);
    } else {
        let subject_path = binding.planning_subject_path.as_ref().ok_or_else(|| {
            (
                "".to_owned(),
                "approved review missing bound subject path".to_owned(),
            )
        })?;
        let subject_digest = binding.planning_subject_digest.as_ref().ok_or_else(|| {
            (
                "".to_owned(),
                "approved review missing bound subject digest".to_owned(),
            )
        })?;
        let work_map = planning_subject_raw(binding)
            .map_err(|error| ("".to_owned(), format!("approved-plan subject: {error}")))?;
        let units = parse_approved_units(&work_map)
            .map_err(|error| ("".to_owned(), format!("approved-plan: {error}")))?;
        let approved = ApprovedPlanArtifactV1 { units };
        validate_approved_plan_v1(&approved)
            .map_err(|error| ("".to_owned(), format!("approved-plan: {error}")))?;
        let bytes = serde_json::to_vec_pretty(&approved)
            .map_err(|error| ("".to_owned(), format!("approved-plan bytes: {error}")))?;
        let path = plan_path(&carrier.workstream);
        artifacts.push((path.clone(), "autopilot.approved_plan.v1".to_owned(), bytes));
        refs.extend([
            Ref(path.display().to_string()),
            Ref(format!("review-subject-carrier:{subject_path}")),
            Ref(format!("review-subject-sha256:{subject_digest}")),
        ]);
    }
    Ok(StagedPlanningSemantics {
        event_kind: "planning:ready-to-execute".to_owned(),
        refs,
        artifacts,
    })
}

fn stage_v2_work_map_admission(
    state: &CoreState,
    binding: &runner::ReceiptV1RunnerBinding,
    facade: &kernel::generated::AgentRunSpec,
    carrier_bytes: &[u8],
) -> Result<planning::ApprovedWorkMapV2, String> {
    let atom_path = facade
        .atom_registry_path
        .as_ref()
        .ok_or_else(|| "V2 staged spec lacks atom registry path".to_owned())?;
    let atom_digest = facade
        .atom_registry_digest
        .as_ref()
        .ok_or_else(|| "V2 staged spec lacks atom registry digest".to_owned())?;
    let legacy = runner::receipt_v1_validator_facade(binding);
    let recovery_subject = if binding.role_id.0 == "recovery-engineer" {
        let subject = v2_subject_binding(state, &legacy)?;
        Some(admit_v2_work_map(state, &subject, false)?)
    } else {
        None
    };
    let admitted = planning::work_map_v2::admit_work_map_v2_staged_carrier(
        Path::new(&binding.carrier_path),
        carrier_bytes,
        facade,
        &binding.spec_digest,
        planning::WorkMapV2AdmissionContext {
            atom_registry_path: Path::new(&atom_path.0),
            atom_registry_digest: &atom_digest.0,
            recovery_subject: recovery_subject.as_ref(),
        },
    )
    .map_err(|error| format!("V2 strict Core admission: {error}"))?;
    let authority = admitted
        .source_actual_authority()
        .ok_or_else(|| "V2 staged admission lost actual carrier authority".to_owned())?;
    if authority.pi_version != runner::REQUIRED_PI_VERSION {
        return Err("V2 staged Pi-version authority drift".to_owned());
    }
    Ok(admitted)
}

fn staged_planning_effect(
    state: &CoreState,
    binding: &runner::IssuedRunnerBinding,
    staged_carrier: &AgentCarrier,
    staged_carrier_bytes: &[u8],
    semantic_event_kind: &str,
    semantic_refs: &[Ref],
    continuation_run_revision: u64,
) -> Result<StagedPlanningEffect, String> {
    let mut projected = CoreState {
        event_path: None,
        state: state.state.clone(),
        events: state.events.clone(),
        event_bytes: state.event_bytes.clone(),
        blocked_latches: state.blocked_latches.clone(),
        blocked_reporter_tool_calls: state.blocked_reporter_tool_calls.clone(),
        blocked_projection_error: state.blocked_projection_error,
    };
    // Every sibling issued from this receipt receives the parent's immutable
    // receipt_v1 binding generation plus one. Projection rows and durable
    // roots are semantic evidence only; neither may select a run revision.

    // An accepted receipt is planning authority before its Host completion.
    // Project every earlier fully rooted receipt through its own sealed
    // transition, rather than treating an unconsumed sibling as in-flight.
    // Discovery starts exclusively from exact accepted-root refs/events.
    let rooted_receipts = rooted_planning_receipts(state)?;
    project_unconsumed_rooted_planning_receipts(
        &mut projected,
        &rooted_receipts,
        &binding.workstream.0,
    )?;

    let mut projection_refs = vec![
        // The receipt id is minted after staging, so this in-memory row uses
        // only a nonpersisted structural sentinel. It is never an authority
        // ref and exists solely to keep the projected row's closed shape.
        Ref(format!(
            "{SUBMIT_RECEIPT_CONSUMED_PREFIX}projected:{}:{}:{}",
            binding.action_id.0, binding.assignment_id.0, binding.run_revision
        )),
        planning_result_consumed_ref(binding),
        terminal_consumed_ref(binding),
        planning_transition_kind_ref(semantic_event_kind)?,
    ];
    projection_refs.extend(semantic_refs.iter().cloned());
    // This is the current receipt's private, eventual consumption row. Its
    // next action revision remains the parent receipt_v1 binding generation
    // plus one, never this synthetic row's revision or live mutable state.
    projected
        .append(
            EventKind("submit:receipt-consumed".to_owned()),
            projection_refs,
        )
        .map_err(|error| error.to_string())?;
    if semantic_event_kind == "planning:ready-to-execute" {
        return Ok(StagedPlanningEffect {
            effect: DeferredHostEffectV1::Done {
                payload: CoreToHostDonePayload {
                    status: format!(
                        "ready-to-execute:workstream={};{}",
                        binding.workstream.0,
                        state.summary()
                    ),
                },
            },
            issues: Vec::new(),
            artifacts: Vec::new(),
        });
    }
    match next_planning_outcome(&binding.workstream.0, &projected)? {
        planning::PlanningWaveOutcome::Launch { assignments, .. } => {
            let input_set = read_planning_input_set(&binding.workstream.0)?;
            let accepted = projected_accepted_planning_artifacts(
                &binding.workstream.0,
                &rooted_receipts,
                binding,
                staged_carrier_bytes,
            )?;
            let needs_atom_registry =
                assignments.iter().any(|assignment| {
                    matches!(
                        assignment.boundary_id.as_deref(),
                        Some("planning.work-map.v1" | "planning.work-map.v2")
                    )
                }) || planning_task_extractors_complete(&binding.workstream.0, &projected)?;
            let (atom_registry, artifacts) = if needs_atom_registry {
                let (path, digest, bytes) = stage_atom_registry_from_rooted_receipts(
                    &binding.workstream.0,
                    &rooted_receipts,
                    binding,
                    staged_carrier,
                )?;
                (
                    Some((path.clone(), digest)),
                    vec![(
                        PathBuf::from(path),
                        "autopilot.planning_atom_registry.v1".to_owned(),
                        bytes,
                    )],
                )
            } else {
                (None, Vec::new())
            };
            let mut issues = Vec::new();
            for assignment in &assignments {
                let registry = matches!(
                    assignment.boundary_id.as_deref(),
                    Some("planning.work-map.v1" | "planning.work-map.v2")
                )
                .then(|| atom_registry.clone())
                .flatten();
                issues.push(
                    planning_bg_action(
                        &binding.workstream.0,
                        assignment,
                        continuation_run_revision,
                        &input_set,
                        registry,
                        accepted.clone(),
                    )
                    .map_err(|error| error.to_string())?,
                );
            }
            let actions = issues.iter().map(|issue| issue.action.clone()).collect();
            Ok(StagedPlanningEffect {
                effect: DeferredHostEffectV1::SpawnWave {
                    payload: CoreToHostSpawnWavePayload { actions },
                },
                issues,
                artifacts,
            })
        }
        planning::PlanningWaveOutcome::WaitingOnInFlight { wave_id, active } => {
            Ok(StagedPlanningEffect {
                effect: DeferredHostEffectV1::Done {
                    payload: CoreToHostDonePayload {
                        status: planning_waiting_status(&wave_id, &active, state),
                    },
                },
                issues: Vec::new(),
                artifacts: Vec::new(),
            })
        }
        planning::PlanningWaveOutcome::Complete => Ok(StagedPlanningEffect {
            effect: DeferredHostEffectV1::Done {
                payload: CoreToHostDonePayload {
                    status: format!("submit:planning-accepted;{}", state.summary()),
                },
            },
            issues: Vec::new(),
            artifacts: Vec::new(),
        }),
        planning::PlanningWaveOutcome::Blocked(blocked) => {
            Err(format!("planning wave blocked: {}", blocked.wave_id))
        }
        planning::PlanningWaveOutcome::CapacityUnknown(detail) => {
            Err(format!("planning capacity unknown: {detail}"))
        }
    }
}

/// Fully-rooted receipt authority used only inside a serialized staging turn.
/// It carries no model/source input: every carrier and transition was verified
/// against the receipt root before this structure is constructed.
struct RootedPlanningReceipt {
    receipt: SubmitReceipt,
    binding: runner::ReceiptV1RunnerBinding,
    facade: runner::IssuedRunnerBinding,
    rooted: SubmitReceiptEventRef,
    transition: PreparedPlanningTransitionV1,
    carrier: AgentCarrier,
    consumed: bool,
}

fn receipt_binding_for_rooted_receipt(
    state: &CoreState,
    receipt: &SubmitReceipt,
) -> Result<runner::ReceiptV1RunnerBinding, String> {
    let mut matches = strict_versioned_runner_bindings(state)?
        .into_iter()
        .filter_map(|binding| match binding {
            VersionedRunnerBinding::ReceiptV1(binding)
                if receipt_matches_binding(receipt, &binding) =>
            {
                Some(binding)
            }
            VersionedRunnerBinding::ReplayV0(_) | VersionedRunnerBinding::ReceiptV1(_) => None,
        })
        .collect::<Vec<_>>();
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err("rooted receipt lacks its exact receipt_v1 binding".to_owned()),
        count => Err(format!(
            "rooted receipt has ambiguous receipt_v1 bindings:{count}"
        )),
    }
}

fn rooted_planning_carrier(
    receipt: &SubmitReceipt,
    facade: &runner::IssuedRunnerBinding,
) -> Result<AgentCarrier, String> {
    let artifact = &receipt.prepared_transition.carrier;
    verify_prepared_artifact(artifact, MAX_TERMINAL_CARRIER_BYTES)?;
    let bytes = runner::read_bounded_authority_file(
        Path::new(&artifact.artifact_ref.0),
        MAX_TERMINAL_CARRIER_BYTES,
    )
    .map_err(|error| format!("rooted planning carrier read: {error}"))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("rooted planning carrier JSON: {error}"))?;
    let canonical = crate::evidence::canonical_json(&value)
        .map_err(|error| format!("rooted planning carrier canonical JSON: {error}"))?;
    if canonical != bytes {
        return Err("rooted planning carrier canonical bytes drift".to_owned());
    }
    let carrier: AgentCarrier = serde_json::from_value(value)
        .map_err(|error| format!("rooted planning carrier shape: {error}"))?;
    validate_planning_binding(&carrier, facade)
        .map_err(|error| format!("rooted planning carrier binding: {error}"))?;
    if facade.boundary_id.0 == "planning.work-map.v2"
        && carrier.pi_version.as_deref() != Some(runner::REQUIRED_PI_VERSION)
    {
        return Err("rooted planning carrier Pi-version authority drift".to_owned());
    }
    Ok(carrier)
}

/// Discover receipt authority only from exact accepted-root events.  There is
/// intentionally no directory scan, state-ref inventory, carrier fallback, or
/// model/source reread here.
fn rooted_planning_receipts(state: &CoreState) -> Result<Vec<RootedPlanningReceipt>, String> {
    let mut rooted = Vec::new();
    for event in &state.events {
        if event.kind.0 != "submit:accepted" {
            continue;
        }
        if event
            .artifact_refs
            .iter()
            .any(|reference| reference.0.starts_with(SUBMIT_RECEIPT_EVENT_REF_PREFIX))
        {
            return Err("accepted event contains circular event reference".to_owned());
        }
        let mut roots = Vec::new();
        for reference in &event.artifact_refs {
            if let Some(root) = decode_submit_receipt_root(reference)? {
                roots.push(root);
            }
        }
        if roots.is_empty() {
            continue;
        }
        if roots.len() != 1 {
            return Err("accepted receipt event has duplicate root refs".to_owned());
        }
        let root = roots.remove(0);
        let receipt = read_submit_receipt_at(Path::new(&root.receipt_ref.0))?
            .ok_or_else(|| "accepted receipt root references a missing receipt".to_owned())?;
        if receipt_root(&receipt)? != root {
            return Err("accepted receipt root/receipt identity drift".to_owned());
        }
        verify_durable_submit_receipt_transaction(&receipt)?;
        let binding = receipt_binding_for_rooted_receipt(state, &receipt)?;
        if receipt.prepared_transition.carrier.artifact_ref.0 != binding.carrier_path {
            return Err("rooted receipt carrier/binding identity drift".to_owned());
        }
        let rooted_event = verify_rooted_submit_receipt(state, &receipt)?;
        verify_receipt_issued_actions_at_continuation_revision(&receipt, &binding)?;
        if !binding.result_contract.0.starts_with("planning.") {
            continue;
        }
        let transition = prepared_planning_transition_from_receipt(&receipt)?;
        let facade = runner::receipt_v1_validator_facade(&binding);
        let carrier = rooted_planning_carrier(&receipt, &facade)?;
        let consumed =
            receipt_is_exactly_consumed(state, &receipt, &binding, &rooted_event, &transition)?;
        rooted.push(RootedPlanningReceipt {
            receipt,
            binding,
            facade,
            rooted: rooted_event,
            transition,
            carrier,
            consumed,
        });
    }
    Ok(rooted)
}

fn receipt_consumption_refs(
    receipt: &SubmitReceipt,
    binding: &runner::ReceiptV1RunnerBinding,
    rooted: &SubmitReceiptEventRef,
    transition: &PreparedPlanningTransitionV1,
) -> Result<Vec<Ref>, String> {
    if !receipt_matches_binding(receipt, binding) {
        return Err("receipt consumption binding identity drift".to_owned());
    }
    let facade = runner::receipt_v1_validator_facade(binding);
    let mut refs = vec![
        Ref(format!(
            "{SUBMIT_RECEIPT_CONSUMED_PREFIX}{}",
            receipt.receipt_id.0
        )),
        terminal_consumed_ref(&facade),
        receipt.prepared_transition.transition_ref.clone(),
        receipt.prepared_transition.carrier.artifact_ref.clone(),
        encode_submit_receipt_event_ref(rooted)?,
        runner::receipt_binding_ref(binding).map_err(|error| error.to_string())?,
        planning_result_consumed_ref(&facade),
        planning_transition_kind_ref(&transition.event_kind)?,
    ];
    refs.extend(transition.refs.iter().cloned());
    refs.extend(
        receipt
            .prepared_transition
            .artifact_refs
            .iter()
            .map(|artifact| artifact.artifact_ref.clone()),
    );
    for issued in &receipt.prepared_transition.issued_actions {
        verify_issued_action(issued)?;
        refs.push(issued.action_ref.clone());
        refs.push(issued.binding_ref.clone());
    }
    Ok(refs)
}

/// A ref in aggregate state is not enough to suppress a projection: it must
/// be backed by exactly one complete receipt-consumed row. This prevents a
/// loose namespaced ref from hiding prior accepted planning authority.
fn receipt_is_exactly_consumed(
    state: &CoreState,
    receipt: &SubmitReceipt,
    binding: &runner::ReceiptV1RunnerBinding,
    rooted: &SubmitReceiptEventRef,
    transition: &PreparedPlanningTransitionV1,
) -> Result<bool, String> {
    let consumed_ref = Ref(format!(
        "{SUBMIT_RECEIPT_CONSUMED_PREFIX}{}",
        receipt.receipt_id.0
    ));
    let rows = state
        .events
        .iter()
        .filter(|event| {
            event.kind.0 == "submit:receipt-consumed"
                && event
                    .artifact_refs
                    .iter()
                    .any(|reference| *reference == consumed_ref)
        })
        .collect::<Vec<_>>();
    if rows.is_empty() {
        if state.state.refs.contains_key(&consumed_ref) {
            return Err("receipt-consumed ref lacks its exact durable row".to_owned());
        }
        return Ok(false);
    }
    if rows.len() != 1 {
        return Err("receipt has duplicate durable consume rows".to_owned());
    }
    let expected = receipt_consumption_refs(receipt, binding, rooted, transition)?;
    if rows[0].artifact_refs != expected || !state.state.refs.contains_key(&consumed_ref) {
        return Err("receipt durable consume row identity drift".to_owned());
    }
    Ok(true)
}

/// Rooted receipts are globally corruption-checked, but staging may project
/// only the exact current workstream into its private scheduling state.
fn project_unconsumed_rooted_planning_receipts(
    projected: &mut CoreState,
    rooted_receipts: &[RootedPlanningReceipt],
    workstream: &str,
) -> Result<(), String> {
    for prior in rooted_receipts
        .iter()
        .filter(|receipt| !receipt.consumed && receipt.facade.workstream.0 == workstream)
    {
        let refs = receipt_consumption_refs(
            &prior.receipt,
            &prior.binding,
            &prior.rooted,
            &prior.transition,
        )?;
        projected
            .append(EventKind("submit:receipt-consumed".to_owned()), refs)
            .map_err(|error| format!("rooted receipt projection append: {error}"))?;
    }
    Ok(())
}

fn projected_accepted_planning_artifacts(
    workstream: &str,
    rooted_receipts: &[RootedPlanningReceipt],
    current_binding: &runner::IssuedRunnerBinding,
    current_carrier_bytes: &[u8],
) -> Result<Vec<runner::AcceptedPlanningArtifactBinding>, String> {
    let manifest = read_planning_schedule_manifest(workstream)?;
    let assignments = manifest
        .assignments
        .iter()
        .enumerate()
        .map(|(order, assignment)| (assignment.assignment_id.as_str(), (order, assignment)))
        .collect::<BTreeMap<_, _>>();
    let mut rows = Vec::<(String, usize, runner::AcceptedPlanningArtifactBinding)>::new();
    let mut append = |binding: &runner::IssuedRunnerBinding, path: &str, digest: &str| {
        if binding.workstream.0 != workstream {
            return Ok(());
        }
        let Some((order, assignment)) = assignments.get(binding.assignment_id.0.as_str()) else {
            return Err(format!(
                "rooted accepted artifact has unknown assignment {}",
                binding.assignment_id.0
            ));
        };
        let expected = assignment.boundary_id.as_deref().ok_or_else(|| {
            format!(
                "rooted accepted artifact assignment {} lacks boundary authority",
                binding.assignment_id.0
            )
        })?;
        if binding.boundary_id.0 != expected || binding.result_contract.0 != expected {
            return Err(format!(
                "rooted accepted artifact boundary drift {}",
                binding.assignment_id.0
            ));
        }
        for category_id in accepted_artifact_categories_for_role(&assignment.role, expected)
            .map_err(|error| error.to_string())?
        {
            rows.push((
                (*category_id).to_owned(),
                *order,
                runner::AcceptedPlanningArtifactBinding {
                    category_id: (*category_id).to_owned(),
                    assignment_id: binding.assignment_id.clone(),
                    role_id: binding.role_id.clone(),
                    boundary_id: binding.result_contract.clone(),
                    terminal_route: binding.terminal_route.clone(),
                    path: path.to_owned(),
                    digest: digest.to_owned(),
                },
            ));
        }
        Ok(())
    };
    for prior in rooted_receipts {
        append(
            &prior.facade,
            &prior.receipt.prepared_transition.carrier.artifact_ref.0,
            &prior.receipt.prepared_transition.carrier.sha256.0,
        )?;
    }
    append(
        current_binding,
        &current_binding.carrier_path,
        &sha256_hex_local(current_carrier_bytes),
    )?;
    rows.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    let latest_synthesized = rows
        .iter()
        .filter(|(category, _, _)| category == "synthesized-work-map")
        .map(|(_, order, _)| *order)
        .max();
    rows.retain(|(category, order, _)| {
        category != "synthesized-work-map" || Some(*order) == latest_synthesized
    });
    Ok(rows.into_iter().map(|(_, _, artifact)| artifact).collect())
}

fn stage_atom_registry_from_rooted_receipts(
    workstream: &str,
    rooted_receipts: &[RootedPlanningReceipt],
    current_binding: &runner::IssuedRunnerBinding,
    current_carrier: &AgentCarrier,
) -> Result<(String, String, Vec<u8>), String> {
    let manifest = read_planning_manifest_value(workstream)
        .map_err(|error| format!("CONTEXT_GAP:planning-manifest:{error}"))?;
    let authority_set_id = manifest["authority_set_id"]
        .as_str()
        .ok_or("CONTEXT_GAP:planning-manifest:missing authority_set_id")?
        .to_owned();
    let assignments = manifest_assignments(workstream)
        .map_err(|error| format!("CONTEXT_GAP:planning-manifest:{error}"))?;
    let mut carriers = BTreeMap::<String, (&runner::IssuedRunnerBinding, &AgentCarrier)>::new();
    for prior in rooted_receipts {
        if prior.facade.workstream.0 == workstream && prior.facade.role_id.0 == "task-extractor" {
            if carriers
                .insert(
                    prior.facade.assignment_id.0.clone(),
                    (&prior.facade, &prior.carrier),
                )
                .is_some()
            {
                return Err(format!(
                    "CONTEXT_GAP:atom-registry:ambiguous rooted extractor {}",
                    prior.facade.assignment_id.0
                ));
            }
        }
    }
    if current_binding.workstream.0 == workstream && current_binding.role_id.0 == "task-extractor" {
        if carriers
            .insert(
                current_binding.assignment_id.0.clone(),
                (current_binding, current_carrier),
            )
            .is_some()
        {
            return Err(format!(
                "CONTEXT_GAP:atom-registry:ambiguous staged extractor {}",
                current_binding.assignment_id.0
            ));
        }
    }
    let mut records = Vec::new();
    let mut producer_ids = Vec::new();
    for (assignment_order, assignment) in assignments
        .iter()
        .enumerate()
        .filter(|(_, assignment)| assignment.role == "task-extractor")
    {
        let (binding, carrier) = carriers.remove(&assignment.assignment_id).ok_or_else(|| {
            format!(
                "CONTEXT_GAP:atom-registry:unaccepted {}",
                assignment.assignment_id
            )
        })?;
        let expected = assignment.boundary_id.as_deref().ok_or_else(|| {
            format!(
                "CONTEXT_GAP:atom-registry:missing boundary {}",
                assignment.assignment_id
            )
        })?;
        if binding.assignment_id.0 != assignment.assignment_id
            || binding.role_id.0 != assignment.role
            || binding.boundary_id.0 != expected
            || binding.result_contract.0 != expected
        {
            return Err(format!(
                "CONTEXT_GAP:atom-registry:rooted binding drift {}",
                assignment.assignment_id
            ));
        }
        if assignment.atom_id_prefix.is_none() {
            return Err(format!(
                "CONTEXT_GAP:atom-registry-prefix:{}",
                binding.assignment_id.0
            ));
        }
        // The exact carrier was already value-admitted before its receipt was
        // rooted. Re-parse only its immutable receipt artifact here; do not
        // reopen task/source authority while projecting this parallel wave.
        let atoms: kernel::generated::TaskAtoms = serde_json::from_str(&carrier.raw_output)
            .map_err(|error| {
                format!(
                    "CONTEXT_GAP:atom-registry-atoms:{}:{error}",
                    binding.assignment_id.0
                )
            })?;
        producer_ids.push(binding.assignment_id.clone());
        records.push((
            assignment_order,
            0usize,
            binding.assignment_id.clone(),
            atoms,
        ));
    }
    if !carriers.is_empty() {
        return Err("CONTEXT_GAP:atom-registry:rooted extractor assignment drift".to_owned());
    }
    let atoms = planning::sorted_registry_atoms(records)
        .map_err(|error| context_status("atom-registry", error))?;
    let bytes = planning::atom_registry_bytes(workstream, &authority_set_id, producer_ids, atoms)
        .map_err(|error| context_status("atom-registry", error))?;
    let path = std::env::current_dir()
        .map_err(|error| error.to_string())?
        .join(atom_registry_path(workstream));
    Ok((path.display().to_string(), sha256_hex_local(&bytes), bytes))
}

fn submit_receipt_path_from_receipt(receipt: &SubmitReceipt) -> Result<PathBuf, String> {
    let root = submit_root_for_carrier(Path::new(
        &receipt.prepared_transition.carrier.artifact_ref.0,
    ))?;
    let key = sha256_hex_local(
        format!(
            "submit-receipt.v1\\0{}\\0{}\\0{}\\0{}",
            receipt.run_id.0, receipt.action_id.0, receipt.assignment_id.0, receipt.run_revision
        )
        .as_bytes(),
    );
    Ok(root.join("submit-receipts").join(format!("{key}.json")))
}

fn prepared_transition_body(transition: &PreparedSubmitTransitionV1) -> serde_json::Value {
    serde_json::json!({
        "schema": "autopilot.prepared_submit_transition_body.v1",
        "carrier": transition.carrier,
        "artifact_refs": transition.artifact_refs,
        "issued_actions": transition.issued_actions,
        "deferred_host_effect": transition.deferred_host_effect,
    })
}

fn encode_submit_receipt_root(root: &SubmitReceiptRootV1) -> Result<Ref, String> {
    let bytes = crate::evidence::canonical_json(root)
        .map_err(|error| format!("receipt root canonical JSON: {error}"))?;
    let text = String::from_utf8(bytes).map_err(|error| format!("receipt root UTF-8: {error}"))?;
    Ok(Ref(format!("{SUBMIT_RECEIPT_ROOT_PREFIX}{text}")))
}

fn decode_submit_receipt_root(reference: &Ref) -> Result<Option<SubmitReceiptRootV1>, String> {
    let Some(value) = reference.0.strip_prefix(SUBMIT_RECEIPT_ROOT_PREFIX) else {
        return Ok(None);
    };
    let root: SubmitReceiptRootV1 = serde_json::from_str(value)
        .map_err(|error| format!("submit receipt root JSON: {error}"))?;
    let canonical = crate::evidence::canonical_json(&root)
        .map_err(|error| format!("submit receipt root canonical JSON: {error}"))?;
    if canonical != value.as_bytes() {
        return Err("submit receipt root ref is not canonical".to_owned());
    }
    Ok(Some(root))
}

fn encode_submit_receipt_event_ref(reference: &SubmitReceiptEventRef) -> Result<Ref, String> {
    let bytes = crate::evidence::canonical_json(reference)
        .map_err(|error| format!("receipt event ref canonical JSON: {error}"))?;
    let text =
        String::from_utf8(bytes).map_err(|error| format!("receipt event ref UTF-8: {error}"))?;
    Ok(Ref(format!("{SUBMIT_RECEIPT_EVENT_REF_PREFIX}{text}")))
}

fn decode_submit_receipt_event_ref(
    reference: &Ref,
) -> Result<Option<SubmitReceiptEventRef>, String> {
    let Some(value) = reference.0.strip_prefix(SUBMIT_RECEIPT_EVENT_REF_PREFIX) else {
        return Ok(None);
    };
    let root: SubmitReceiptEventRef = serde_json::from_str(value)
        .map_err(|error| format!("submit receipt event ref JSON: {error}"))?;
    let canonical = crate::evidence::canonical_json(&root)
        .map_err(|error| format!("submit receipt event ref canonical JSON: {error}"))?;
    if canonical != value.as_bytes() {
        return Err("submit receipt event ref is not canonical".to_owned());
    }
    Ok(Some(root))
}

fn issued_action_ref(
    action: &BackgroundAction,
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<Ref, String> {
    let bytes = crate::evidence::canonical_json(action)
        .map_err(|error| format!("issued action canonical JSON: {error}"))?;
    let binding_bytes = crate::evidence::canonical_json(binding)
        .map_err(|error| format!("issued binding canonical JSON: {error}"))?;
    let reference = IssuedActionReceiptRefV1 {
        schema: "autopilot.issued_action_receipt_ref.v1".to_owned(),
        action_id: action.action_id.clone(),
        assignment_id: action.assignment_id.clone(),
        run_revision: action.run_revision,
        byte_count: bytes.len() as u64,
        sha256: Digest(sha256_hex_local(&bytes)),
        binding_byte_count: binding_bytes.len() as u64,
        binding_sha256: Digest(sha256_hex_local(&binding_bytes)),
    };
    let encoded = crate::evidence::canonical_json(&reference)
        .map_err(|error| format!("issued action ref canonical JSON: {error}"))?;
    let text =
        String::from_utf8(encoded).map_err(|error| format!("issued action ref UTF-8: {error}"))?;
    Ok(Ref(format!("issued-action:{text}")))
}

fn decode_issued_action_ref(reference: &Ref) -> Result<IssuedActionReceiptRefV1, String> {
    let value = reference
        .0
        .strip_prefix("issued-action:")
        .ok_or_else(|| "issued action ref prefix drift".to_owned())?;
    let decoded: IssuedActionReceiptRefV1 =
        serde_json::from_str(value).map_err(|error| format!("issued action ref JSON: {error}"))?;
    let canonical = crate::evidence::canonical_json(&decoded)
        .map_err(|error| format!("issued action ref canonical JSON: {error}"))?;
    if canonical != value.as_bytes() || decoded.schema != "autopilot.issued_action_receipt_ref.v1" {
        return Err("issued action ref canonical/schema drift".to_owned());
    }
    Ok(decoded)
}

fn verify_prepared_artifact(
    artifact: &PreparedSubmitArtifactRef,
    max_bytes: usize,
) -> Result<(), String> {
    if artifact.artifact_ref.0.is_empty() || artifact.artifact_schema.0.is_empty() {
        return Err("prepared artifact has empty identity".to_owned());
    }
    let byte_count = usize::try_from(artifact.byte_count)
        .map_err(|_| "prepared artifact byte count overflow".to_owned())?;
    if byte_count > max_bytes {
        return Err("prepared artifact declared byte count exceeds authority cap".to_owned());
    }
    let bytes = runner::read_bounded_authority_file(Path::new(&artifact.artifact_ref.0), max_bytes)
        .map_err(|error| format!("prepared artifact read: {error}"))?;
    if bytes.len() != byte_count || sha256_hex_local(&bytes) != artifact.sha256.0 {
        return Err("prepared artifact byte count or digest drift".to_owned());
    }
    Ok(())
}

fn verify_issued_action(issued: &PreparedSubmitIssuedAction) -> Result<(), String> {
    let action_ref = decode_issued_action_ref(&issued.action_ref)?;
    let action_bytes = crate::evidence::canonical_json(&issued.action)
        .map_err(|error| format!("issued action canonical JSON: {error}"))?;
    if action_ref.action_id != issued.action.action_id
        || action_ref.assignment_id != issued.action.assignment_id
        || action_ref.run_revision != issued.action.run_revision
        || action_ref.byte_count != action_bytes.len() as u64
        || action_ref.sha256.0 != sha256_hex_local(&action_bytes)
    {
        return Err("issued action identity/byte count/digest drift".to_owned());
    }
    let versioned = runner::decode_versioned_binding_ref(&issued.binding_ref.0)
        .map_err(|error| format!("issued binding ref: {error}"))?;
    let VersionedRunnerBinding::ReceiptV1(binding) = versioned else {
        return Err("issued action binding is not receipt_v1".to_owned());
    };
    let binding_bytes = crate::evidence::canonical_json(&binding)
        .map_err(|error| format!("issued binding canonical JSON: {error}"))?;
    if issued.binding_digest.0 != sha256_hex_local(&binding_bytes)
        || action_ref.binding_byte_count != binding_bytes.len() as u64
        || action_ref.binding_sha256.0 != sha256_hex_local(&binding_bytes)
        || runner::receipt_binding_ref(&binding).map_err(|error| error.to_string())?
            != issued.binding_ref
        || issued_action_ref(&issued.action, &binding)? != issued.action_ref
        || binding.action_id != issued.action.action_id
        || binding.assignment_id != issued.action.assignment_id
        || binding.run_revision != issued.action.run_revision
    {
        return Err("issued binding identity/digest drift".to_owned());
    }
    Ok(())
}

/// Issued actions are immutable continuations of the parent receipt_v1
/// binding. They must not be tied to accepted roots, event references, or the
/// mutable state revision observed during completion.
fn verify_issued_action_at_continuation_revision(
    issued: &PreparedSubmitIssuedAction,
    continuation_run_revision: u64,
) -> Result<(), String> {
    verify_issued_action(issued)?;
    let versioned = runner::decode_versioned_binding_ref(&issued.binding_ref.0)
        .map_err(|error| format!("issued binding ref: {error}"))?;
    let VersionedRunnerBinding::ReceiptV1(binding) = versioned else {
        return Err("issued action binding is not receipt_v1".to_owned());
    };
    if issued.action.run_revision != continuation_run_revision
        || binding.run_revision != continuation_run_revision
    {
        return Err(format!(
            "issued action/binding continuation revision drift: expected={continuation_run_revision};action={};binding={}",
            issued.action.run_revision, binding.run_revision
        ));
    }
    Ok(())
}

fn verify_deferred_effect(transition: &PreparedSubmitTransitionV1) -> Result<(), String> {
    let actions = transition
        .issued_actions
        .iter()
        .map(|issued| issued.action.clone())
        .collect::<Vec<_>>();
    match &transition.deferred_host_effect {
        DeferredHostEffectV1::Done { .. } if actions.is_empty() => Ok(()),
        DeferredHostEffectV1::Spawn { payload }
            if actions.as_slice() == [payload.action.clone()] =>
        {
            Ok(())
        }
        DeferredHostEffectV1::SpawnWave { payload } if payload.actions == actions => Ok(()),
        _ => Err("deferred Host effect does not exactly match issued actions".to_owned()),
    }
}

fn verify_embedded_transition_identity(receipt: &SubmitReceipt) -> Result<Vec<u8>, String> {
    let transition = &receipt.prepared_transition;
    if transition.schema.0 != "autopilot.prepared_submit_transition.v1" {
        return Err("prepared transition schema drift".to_owned());
    }
    let expected_path = submit_receipt_path_from_receipt(receipt)?;
    let mut expected_transition_path = expected_path;
    expected_transition_path.set_extension("transition.json");
    if transition.transition_ref.0 != expected_transition_path.display().to_string() {
        return Err("prepared transition path identity drift".to_owned());
    }
    let body = crate::evidence::canonical_json(&prepared_transition_body(transition))
        .map_err(|error| format!("prepared transition canonical JSON: {error}"))?;
    if transition.transition_digest.0 != sha256_hex_local(&body) {
        return Err("prepared transition embedded body digest drift".to_owned());
    }
    let mut artifacts = BTreeSet::new();
    for artifact in &transition.artifact_refs {
        if !artifacts.insert(artifact.artifact_ref.0.clone()) {
            return Err("prepared transition has duplicate artifact ref".to_owned());
        }
    }
    let mut actions = BTreeSet::new();
    for issued in &transition.issued_actions {
        if !actions.insert(issued.action_ref.0.clone()) {
            return Err("prepared transition has duplicate issued action ref".to_owned());
        }
        // This checks only receipt-embedded canonical action/binding bytes;
        // receipt-only completion never opens a carrier, spec, or repository.
        verify_issued_action(issued)?;
    }
    verify_deferred_effect(transition)?;
    Ok(body)
}

fn verify_durable_submit_receipt_transaction(receipt: &SubmitReceipt) -> Result<(), String> {
    let path = submit_receipt_path_from_receipt(receipt)?;
    let durable = read_submit_receipt_at(&path)?
        .ok_or_else(|| "create-once submit receipt is absent".to_owned())?;
    if durable != *receipt {
        return Err("create-once submit receipt identity drift".to_owned());
    }
    let transition_body = verify_embedded_transition_identity(receipt)?;
    let transition_bytes = runner::read_bounded_authority_file(
        Path::new(&receipt.prepared_transition.transition_ref.0),
        SUBMIT_RECEIPT_MAX_BYTES,
    )
    .map_err(|error| format!("prepared transition read: {error}"))?;
    if transition_bytes != transition_body {
        return Err("prepared transition durable body drift".to_owned());
    }
    verify_prepared_artifact(
        &receipt.prepared_transition.carrier,
        MAX_TERMINAL_CARRIER_BYTES,
    )?;
    for artifact in &receipt.prepared_transition.artifact_refs {
        verify_prepared_artifact(artifact, SUBMIT_RECEIPT_MAX_BYTES)?;
    }
    for issued in &receipt.prepared_transition.issued_actions {
        verify_issued_action(issued)?;
    }
    Ok(())
}

fn actual_event_ref(state: &CoreState, index: usize) -> Result<AutopilotEventRef, String> {
    let event = state
        .events
        .get(index)
        .ok_or_else(|| "accepted event row is absent".to_owned())?;
    let bytes = state
        .event_bytes
        .get(index)
        .ok_or_else(|| "accepted event bytes are absent".to_owned())?;
    let canonical = crate::evidence::canonical_json(event)
        .map_err(|error| format!("accepted event canonical JSON: {error}"))?;
    if canonical != *bytes {
        return Err("accepted event persisted bytes are not canonical".to_owned());
    }
    Ok(AutopilotEventRef {
        schema_version: SchemaId("autopilot.event.v1".to_owned()),
        sequence: event.sequence,
        kind: event.kind.clone(),
        row_sha256: Digest(sha256_hex_local(bytes)),
    })
}

fn receipt_root(receipt: &SubmitReceipt) -> Result<SubmitReceiptRootV1, String> {
    let receipt_path = submit_receipt_path_from_receipt(receipt)?;
    let receipt_bytes = crate::evidence::canonical_json(receipt)
        .map_err(|error| format!("receipt canonical JSON: {error}"))?;
    Ok(SubmitReceiptRootV1 {
        schema: "autopilot.submit_receipt_root.v1".to_owned(),
        receipt_ref: Ref(receipt_path.display().to_string()),
        receipt_sha256: Digest(sha256_hex_local(&receipt_bytes)),
        transition_ref: receipt.prepared_transition.transition_ref.clone(),
        transition_sha256: receipt.prepared_transition.transition_digest.clone(),
    })
}

fn accepted_root_index(
    state: &CoreState,
    root: &SubmitReceiptRootV1,
) -> Result<Option<usize>, String> {
    let expected_root_ref = encode_submit_receipt_root(root)?;
    let mut matches = Vec::new();
    for (index, event) in state.events.iter().enumerate() {
        if event.kind.0 != "submit:accepted" {
            continue;
        }
        if event
            .artifact_refs
            .iter()
            .any(|reference| reference.0.starts_with(SUBMIT_RECEIPT_EVENT_REF_PREFIX))
        {
            return Err("accepted event contains circular event reference".to_owned());
        }
        for reference in &event.artifact_refs {
            if let Some(decoded) = decode_submit_receipt_root(reference)?
                && decoded.receipt_ref == root.receipt_ref
            {
                matches.push((index, decoded));
            }
        }
    }
    match matches.len() {
        0 => Ok(None),
        1 => {
            let (index, decoded) = matches.remove(0);
            let event = &state.events[index];
            if decoded.schema != "autopilot.submit_receipt_root.v1"
                || decoded.receipt_sha256 != root.receipt_sha256
                || decoded.transition_ref != root.transition_ref
                || decoded.transition_sha256 != root.transition_sha256
                || event.artifact_refs
                    != vec![
                        expected_root_ref,
                        root.receipt_ref.clone(),
                        root.transition_ref.clone(),
                    ]
            {
                return Err("accepted receipt event root drift".to_owned());
            }
            Ok(Some(index))
        }
        _ => Err("conflicting duplicate accepted receipt roots".to_owned()),
    }
}

fn receipt_event_ref_for_root(
    state: &CoreState,
    root: &SubmitReceiptRootV1,
    accepted_index: usize,
) -> Result<Option<SubmitReceiptEventRef>, String> {
    let accepted_event = actual_event_ref(state, accepted_index)?;
    if accepted_event.kind.0 != "submit:accepted" {
        return Err("accepted event reference kind drift".to_owned());
    }
    let expected = SubmitReceiptEventRef {
        schema: SchemaId("autopilot.submit_receipt_event_ref.v1".to_owned()),
        receipt_ref: root.receipt_ref.clone(),
        receipt_sha256: root.receipt_sha256.clone(),
        accepted_event,
    };
    let encoded = encode_submit_receipt_event_ref(&expected)?;
    let mut matches = Vec::new();
    for event in &state.events {
        if event.kind.0 != "submit:accepted-event-ref" {
            continue;
        }
        for reference in &event.artifact_refs {
            if let Some(decoded) = decode_submit_receipt_event_ref(reference)?
                && decoded.receipt_ref == root.receipt_ref
            {
                matches.push((event, decoded));
            }
        }
    }
    match matches.len() {
        1 => {
            let (event, decoded) = matches.remove(0);
            if decoded != expected
                || event.artifact_refs
                    != vec![
                        encoded,
                        root.receipt_ref.clone(),
                        root.transition_ref.clone(),
                    ]
            {
                return Err("accepted receipt event hash reference drift".to_owned());
            }
            Ok(Some(expected))
        }
        0 => Ok(None),
        _ => Err("conflicting duplicate accepted receipt event hash references".to_owned()),
    }
}

fn append_receipt_event_ref(
    state: &mut CoreState,
    root: &SubmitReceiptRootV1,
    accepted_index: usize,
) -> Result<(), String> {
    let reference = SubmitReceiptEventRef {
        schema: SchemaId("autopilot.submit_receipt_event_ref.v1".to_owned()),
        receipt_ref: root.receipt_ref.clone(),
        receipt_sha256: root.receipt_sha256.clone(),
        accepted_event: actual_event_ref(state, accepted_index)?,
    };
    let encoded = encode_submit_receipt_event_ref(&reference)?;
    state
        .append(
            EventKind("submit:accepted-event-ref".to_owned()),
            vec![
                encoded,
                root.receipt_ref.clone(),
                root.transition_ref.clone(),
            ],
        )
        .map_err(|error| error.to_string())
}

fn verify_rooted_submit_receipt(
    state: &CoreState,
    receipt: &SubmitReceipt,
) -> Result<SubmitReceiptEventRef, String> {
    let root = receipt_root(receipt)?;
    let index = accepted_root_index(state, &root)?
        .ok_or_else(|| "accepted receipt event root is absent".to_owned())?;
    receipt_event_ref_for_root(state, &root, index)?
        .ok_or_else(|| "accepted receipt event hash reference is absent".to_owned())
}

/// Root, projection, and receipt-only completion all check the continuation
/// from the same immutable parent receipt/binding pair. No current state or
/// root/event position participates in this identity check.
fn verify_receipt_issued_actions_at_continuation_revision(
    receipt: &SubmitReceipt,
    parent_binding: &runner::ReceiptV1RunnerBinding,
) -> Result<(), String> {
    if !receipt_matches_binding(receipt, parent_binding) {
        return Err("receipt continuation parent binding identity drift".to_owned());
    }
    let continuation_run_revision = receipt_v1_continuation_run_revision(parent_binding)?;
    for issued in &receipt.prepared_transition.issued_actions {
        verify_issued_action_at_continuation_revision(issued, continuation_run_revision)?;
    }
    Ok(())
}

fn root_or_verify_submit_receipt(
    state: &mut CoreState,
    receipt: &SubmitReceipt,
    parent_binding: &runner::ReceiptV1RunnerBinding,
) -> Result<(), String> {
    verify_durable_submit_receipt_transaction(receipt)?;
    verify_receipt_issued_actions_at_continuation_revision(receipt, parent_binding)?;
    let root = receipt_root(receipt)?;
    if let Some(index) = accepted_root_index(state, &root)? {
        if receipt_event_ref_for_root(state, &root, index)?.is_none() {
            append_receipt_event_ref(state, &root, index)?;
        }
    } else {
        let root_ref = encode_submit_receipt_root(&root)?;
        state
            .append(
                EventKind("submit:accepted".to_owned()),
                vec![
                    root_ref,
                    root.receipt_ref.clone(),
                    root.transition_ref.clone(),
                ],
            )
            .map_err(|error| error.to_string())?;
        let index = state
            .events
            .len()
            .checked_sub(1)
            .ok_or_else(|| "accepted event append lost its row".to_owned())?;
        append_receipt_event_ref(state, &root, index)?;
    }
    Ok(())
}

fn blocked_binding_for_receipt(
    state: &CoreState,
    receipt: &BlockedReceipt,
) -> Result<runner::ReceiptV1RunnerBinding, String> {
    let mut matches = strict_versioned_runner_bindings(state)?
        .into_iter()
        .filter_map(|binding| match binding {
            VersionedRunnerBinding::ReceiptV1(binding)
                if binding.run_id == receipt.run_id
                    && binding.action_id == receipt.action_id
                    && binding.assignment_id == receipt.assignment_id
                    && binding.run_revision == receipt.run_revision
                    && binding.workstream == receipt.workstream
                    && binding.attempt == receipt.attempt =>
            {
                Some(binding)
            }
            VersionedRunnerBinding::ReceiptV1(_) | VersionedRunnerBinding::ReplayV0(_) => None,
        })
        .collect::<Vec<_>>();
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err("blocked receipt has no exact receipt_v1 binding".to_owned()),
        count => Err(format!(
            "blocked receipt has ambiguous receipt_v1 binding:{count}"
        )),
    }
}

fn blocked_root(
    receipt: &BlockedReceipt,
    latch: &BlockedLatch,
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<BlockedLatchRootV1, String> {
    if receipt.schema.0 != "autopilot.blocked_receipt.v1"
        || receipt.run_id != binding.run_id
        || receipt.run_revision != binding.run_revision
        || receipt.workstream != binding.workstream
        || receipt.action_id != binding.action_id
        || receipt.assignment_id != binding.assignment_id
        || receipt.attempt != binding.attempt
        || receipt.profile_id != BLOCKED_PROFILE_ID
        || receipt.tool_name.0 != BLOCKED_TOOL_NAME
    {
        return Err("blocked receipt/binding identity drift".to_owned());
    }
    validate_blocked_latch(receipt, latch)?;
    let receipt_path = blocked_receipt_path(binding)?;
    let latch_path = blocked_latch_path(binding)?;
    let receipt_bytes = crate::evidence::canonical_json(receipt)
        .map_err(|error| format!("blocked receipt canonical JSON: {error}"))?;
    let latch_bytes = crate::evidence::canonical_json(latch)
        .map_err(|error| format!("blocked latch canonical JSON: {error}"))?;
    Ok(BlockedLatchRootV1 {
        schema: "autopilot.blocked_latch_root.v1".to_owned(),
        blocked_receipt_ref: Ref(receipt_path.display().to_string()),
        blocked_receipt_sha256: Digest(sha256_hex_local(&receipt_bytes)),
        latch_ref: Ref(latch_path.display().to_string()),
        latch_sha256: Digest(sha256_hex_local(&latch_bytes)),
    })
}

fn encode_blocked_latch_root(root: &BlockedLatchRootV1) -> Result<Ref, String> {
    let bytes = crate::evidence::canonical_json(root)
        .map_err(|error| format!("blocked latch root canonical JSON: {error}"))?;
    let text =
        String::from_utf8(bytes).map_err(|error| format!("blocked latch root UTF-8: {error}"))?;
    Ok(Ref(format!("{BLOCKED_RECEIPT_ROOT_PREFIX}{text}")))
}

fn decode_blocked_latch_root(reference: &Ref) -> Result<Option<BlockedLatchRootV1>, String> {
    let Some(value) = reference.0.strip_prefix(BLOCKED_RECEIPT_ROOT_PREFIX) else {
        return Ok(None);
    };
    let root: BlockedLatchRootV1 =
        serde_json::from_str(value).map_err(|error| format!("blocked latch root JSON: {error}"))?;
    let canonical = crate::evidence::canonical_json(&root)
        .map_err(|error| format!("blocked latch root canonical JSON: {error}"))?;
    if canonical != value.as_bytes() || root.schema != "autopilot.blocked_latch_root.v1" {
        return Err("blocked latch root ref canonical/schema drift".to_owned());
    }
    Ok(Some(root))
}

fn encode_blocked_latch_event_ref(reference: &BlockedLatchEventRef) -> Result<Ref, String> {
    let bytes = crate::evidence::canonical_json(reference)
        .map_err(|error| format!("blocked latch event ref canonical JSON: {error}"))?;
    let text = String::from_utf8(bytes)
        .map_err(|error| format!("blocked latch event ref UTF-8: {error}"))?;
    Ok(Ref(format!("{BLOCKED_LATCH_EVENT_REF_PREFIX}{text}")))
}

fn decode_blocked_latch_event_ref(reference: &Ref) -> Result<Option<BlockedLatchEventRef>, String> {
    let Some(value) = reference.0.strip_prefix(BLOCKED_LATCH_EVENT_REF_PREFIX) else {
        return Ok(None);
    };
    let event_ref: BlockedLatchEventRef = serde_json::from_str(value)
        .map_err(|error| format!("blocked latch event ref JSON: {error}"))?;
    let canonical = crate::evidence::canonical_json(&event_ref)
        .map_err(|error| format!("blocked latch event ref canonical JSON: {error}"))?;
    if canonical != value.as_bytes() || event_ref.schema.0 != "autopilot.blocked_latch_event_ref.v1"
    {
        return Err("blocked latch event ref canonical/schema drift".to_owned());
    }
    Ok(Some(event_ref))
}

fn blocked_accepted_root_index(
    state: &CoreState,
    root: &BlockedLatchRootV1,
) -> Result<Option<usize>, String> {
    let encoded = encode_blocked_latch_root(root)?;
    let mut matches = Vec::new();
    for (index, event) in state.events.iter().enumerate() {
        if event.kind.0 != "blocked:accepted" {
            continue;
        }
        let roots = event
            .artifact_refs
            .iter()
            .map(decode_blocked_latch_root)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let roots = roots.into_iter().flatten().collect::<Vec<_>>();
        if roots.len() != 1 {
            return Err("blocked accepted event lacks exactly one root".to_owned());
        }
        let decoded = roots.into_iter().next().expect("one checked root");
        if decoded.blocked_receipt_ref == root.blocked_receipt_ref {
            if event.artifact_refs
                != vec![
                    encoded.clone(),
                    root.blocked_receipt_ref.clone(),
                    root.latch_ref.clone(),
                ]
            {
                return Err("blocked accepted event root drift".to_owned());
            }
            matches.push((index, decoded));
        }
    }
    match matches.len() {
        0 => Ok(None),
        1 => {
            let (index, found) = matches.remove(0);
            if found != *root {
                return Err("conflicting duplicate blocked accepted root".to_owned());
            }
            Ok(Some(index))
        }
        _ => Err("duplicate blocked accepted roots".to_owned()),
    }
}

fn blocked_event_ref_for_root(
    state: &CoreState,
    root: &BlockedLatchRootV1,
    accepted_index: usize,
) -> Result<Option<BlockedLatchEventRef>, String> {
    let blocked_event = actual_event_ref(state, accepted_index)?;
    if blocked_event.kind.0 != "blocked:accepted" {
        return Err("blocked accepted event kind drift".to_owned());
    }
    let expected = BlockedLatchEventRef {
        schema: SchemaId("autopilot.blocked_latch_event_ref.v1".to_owned()),
        blocked_receipt_ref: root.blocked_receipt_ref.clone(),
        blocked_receipt_sha256: root.blocked_receipt_sha256.clone(),
        latch_ref: root.latch_ref.clone(),
        latch_sha256: root.latch_sha256.clone(),
        blocked_event,
    };
    let encoded = encode_blocked_latch_event_ref(&expected)?;
    let mut matches = Vec::new();
    for event in &state.events {
        if event.kind.0 != "blocked:latch-event-ref" {
            continue;
        }
        let refs = event
            .artifact_refs
            .iter()
            .map(decode_blocked_latch_event_ref)
            .collect::<Result<Vec<_>, _>>()?;
        for decoded in refs.into_iter().flatten() {
            if decoded.blocked_receipt_ref == root.blocked_receipt_ref {
                if decoded != expected
                    || event.artifact_refs
                        != vec![
                            encoded.clone(),
                            root.blocked_receipt_ref.clone(),
                            root.latch_ref.clone(),
                        ]
                {
                    return Err("blocked latch event reference drift".to_owned());
                }
                matches.push(decoded);
            }
        }
    }
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.pop()),
        _ => Err("duplicate blocked latch event references".to_owned()),
    }
}

fn verify_durable_blocked_latch_transaction(
    receipt: &BlockedReceipt,
    latch: &BlockedLatch,
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<BlockedLatchRootV1, String> {
    let root = blocked_root(receipt, latch, binding)?;
    let durable_receipt = read_blocked_receipt_at(Path::new(&root.blocked_receipt_ref.0))?
        .ok_or_else(|| "create-once blocked receipt is absent".to_owned())?;
    let durable_latch = read_blocked_latch_at(Path::new(&root.latch_ref.0))?
        .ok_or_else(|| "create-once blocked latch is absent".to_owned())?;
    if durable_receipt != *receipt
        || durable_latch != *latch
        || root.blocked_receipt_sha256.0
            != sha256_hex_local(
                &crate::evidence::canonical_json(&durable_receipt)
                    .map_err(|error| error.to_string())?,
            )
        || root.latch_sha256.0
            != sha256_hex_local(
                &crate::evidence::canonical_json(&durable_latch)
                    .map_err(|error| error.to_string())?,
            )
    {
        return Err("create-once blocked receipt/latch bytes drift".to_owned());
    }
    Ok(root)
}

fn append_blocked_latch_event_ref(
    state: &mut CoreState,
    root: &BlockedLatchRootV1,
    accepted_index: usize,
) -> Result<(), String> {
    let reference = BlockedLatchEventRef {
        schema: SchemaId("autopilot.blocked_latch_event_ref.v1".to_owned()),
        blocked_receipt_ref: root.blocked_receipt_ref.clone(),
        blocked_receipt_sha256: root.blocked_receipt_sha256.clone(),
        latch_ref: root.latch_ref.clone(),
        latch_sha256: root.latch_sha256.clone(),
        blocked_event: actual_event_ref(state, accepted_index)?,
    };
    let encoded = encode_blocked_latch_event_ref(&reference)?;
    state
        .append(
            EventKind("blocked:latch-event-ref".to_owned()),
            vec![
                encoded,
                root.blocked_receipt_ref.clone(),
                root.latch_ref.clone(),
            ],
        )
        .map_err(|error| error.to_string())
}

fn root_or_verify_blocked_latch(
    state: &mut CoreState,
    receipt: &BlockedReceipt,
    latch: &BlockedLatch,
    binding: &runner::ReceiptV1RunnerBinding,
) -> Result<(), String> {
    let root = verify_durable_blocked_latch_transaction(receipt, latch, binding)?;
    if let Some(index) = blocked_accepted_root_index(state, &root)? {
        if blocked_event_ref_for_root(state, &root, index)?.is_none() {
            append_blocked_latch_event_ref(state, &root, index)?;
        }
    } else {
        let encoded = encode_blocked_latch_root(&root)?;
        state
            .append(
                EventKind("blocked:accepted".to_owned()),
                vec![
                    encoded,
                    root.blocked_receipt_ref.clone(),
                    root.latch_ref.clone(),
                ],
            )
            .map_err(|error| error.to_string())?;
        let index = state
            .events
            .len()
            .checked_sub(1)
            .ok_or_else(|| "blocked accepted event append lost its row".to_owned())?;
        append_blocked_latch_event_ref(state, &root, index)?;
    }
    Ok(())
}

fn encode_blocked_observed_ref(reference: &BlockedObservedRefV1) -> Result<Ref, String> {
    let bytes = crate::evidence::canonical_json(reference)
        .map_err(|error| format!("blocked observed ref canonical JSON: {error}"))?;
    let text =
        String::from_utf8(bytes).map_err(|error| format!("blocked observed ref UTF-8: {error}"))?;
    Ok(Ref(format!("{BLOCKED_OBSERVED_REF_PREFIX}{text}")))
}

fn decode_blocked_observed_ref(reference: &Ref) -> Result<Option<BlockedObservedRefV1>, String> {
    let Some(value) = reference.0.strip_prefix(BLOCKED_OBSERVED_REF_PREFIX) else {
        return Ok(None);
    };
    let observed: BlockedObservedRefV1 = serde_json::from_str(value)
        .map_err(|error| format!("blocked observed ref JSON: {error}"))?;
    let canonical = crate::evidence::canonical_json(&observed)
        .map_err(|error| format!("blocked observed ref canonical JSON: {error}"))?;
    if canonical != value.as_bytes() || observed.schema != "autopilot.blocked_result_observed.v1" {
        return Err("blocked observed ref canonical/schema drift".to_owned());
    }
    Ok(Some(observed))
}

/// Check deterministic paths for every already-issued V5 binding, never a
/// directory listing.  A create-once transaction that has not reached an
/// accepted root closes launches globally until its exact raw alias completes
/// it from the prepared immutable snapshot.
fn ensure_no_pending_blocked_transactions(state: &CoreState) -> Result<(), AnyError> {
    for versioned in strict_versioned_runner_bindings(state)? {
        let VersionedRunnerBinding::ReceiptV1(binding) = versioned else {
            continue;
        };
        let prepared_path = blocked_prepared_transaction_path(&binding)?;
        let receipt_path = blocked_receipt_path(&binding)?;
        let latch_path = blocked_latch_path(&binding)?;
        let prepared = read_blocked_prepared_transaction_at(&prepared_path)?;
        let receipt = read_blocked_receipt_at(&receipt_path)?;
        let latch = read_blocked_latch_at(&latch_path)?;
        let rooted = blocked_root_for_binding(state, &binding)?;
        if rooted.is_none() && (prepared.is_some() || receipt.is_some() || latch.is_some()) {
            return Err("blocked create-once transaction recovery pending".into());
        }
    }
    Ok(())
}

fn project_blocked_latches(
    state: &CoreState,
) -> Result<BTreeMap<(String, String), BlockedLatchState>, AnyError> {
    let mut projected = BTreeMap::new();
    let mut by_receipt = BTreeMap::<String, (String, String)>::new();
    let mut rooted_receipt_refs = BTreeSet::new();
    for event in &state.events {
        if event.kind.0 != "blocked:accepted" {
            continue;
        }
        let roots = event
            .artifact_refs
            .iter()
            .map(decode_blocked_latch_root)
            .collect::<Result<Vec<_>, _>>()?;
        let roots = roots.into_iter().flatten().collect::<Vec<_>>();
        if roots.len() != 1 {
            return Err("blocked accepted event lacks exactly one canonical root".into());
        }
        let root = roots.into_iter().next().expect("one checked root");
        let Some(index) = blocked_accepted_root_index(state, &root)? else {
            return Err("blocked accepted root disappeared during projection".into());
        };
        if blocked_event_ref_for_root(state, &root, index)?.is_none() {
            return Err("blocked accepted root lacks its event reference".into());
        }
        if !rooted_receipt_refs.insert(root.blocked_receipt_ref.0.clone()) {
            return Err("duplicate blocked root receipt reference".into());
        }
        let receipt = read_blocked_receipt_at(Path::new(&root.blocked_receipt_ref.0))?
            .ok_or("blocked root receipt is absent")?;
        let latch = read_blocked_latch_at(Path::new(&root.latch_ref.0))?
            .ok_or("blocked root latch is absent")?;
        let binding = blocked_binding_for_receipt(state, &receipt)?;
        let expected = blocked_root(&receipt, &latch, &binding)?;
        validate_blocked_latch_launch_scope(state, &receipt, &latch)?;
        if expected != root {
            return Err("blocked root artifact digest/path drift".into());
        }
        let key = (receipt.run_id.0.clone(), receipt.workstream.0.clone());
        if projected
            .insert(
                key.clone(),
                BlockedLatchState {
                    receipt: receipt.clone(),
                    latch,
                    reporter_observed: false,
                },
            )
            .is_some()
            || by_receipt
                .insert(receipt.receipt_id.0.clone(), key)
                .is_some()
        {
            return Err("duplicate blocked workstream or receipt root".into());
        }
    }
    for event in &state.events {
        if event.kind.0 != "blocked:latch-event-ref" {
            continue;
        }
        if event.artifact_refs.len() != 3 {
            return Err("blocked latch event reference count drift".into());
        }
        let reference = decode_blocked_latch_event_ref(&event.artifact_refs[0])?
            .ok_or("blocked latch event lacks canonical reference")?;
        if !rooted_receipt_refs.contains(&reference.blocked_receipt_ref.0) {
            return Err("orphan blocked latch event reference".into());
        }
    }
    for event in &state.events {
        if event.kind.0 != "blocked:result-observed" {
            continue;
        }
        if event.artifact_refs.len() != 1 {
            return Err("blocked observed event ref count drift".into());
        }
        let observed = decode_blocked_observed_ref(&event.artifact_refs[0])?
            .ok_or("blocked observed event lacks canonical reference")?;
        if event.artifact_refs != vec![encode_blocked_observed_ref(&observed)?] {
            return Err("blocked observed event reference drift".into());
        }
        let key = by_receipt
            .get(&observed.receipt_id.0)
            .ok_or("blocked observed receipt is not rooted")?
            .clone();
        let latch_state = projected
            .get_mut(&key)
            .ok_or("blocked observed workstream is absent")?;
        let reporter = latch_state
            .latch
            .cancellations
            .last()
            .ok_or("blocked observed latch reporter is absent")?;
        if latch_state.receipt.receipt_id != observed.receipt_id
            || latch_state.latch.latch_id != observed.latch_id
            || !reporter.reporter
            || reporter.task_id != observed.reporter_task_id
            || latch_state.reporter_observed
        {
            return Err("blocked observed identity/duplicate drift".into());
        }
        latch_state.reporter_observed = true;
    }
    Ok(projected)
}

fn blocked_gate(latch: &BlockedLatch) -> ChildControlBlockedGate {
    ChildControlBlockedGate {
        schema: SchemaId("autopilot.child_control_blocked_gate.v1".to_owned()),
        latch_id: latch.latch_id.clone(),
        run_id: latch.run_id.clone(),
        cancellations: latch
            .cancellations
            .iter()
            .map(|record| ChildControlBlockedCancellation {
                task_id: record.task_id.clone(),
                action_id: record.action_id.clone(),
                assignment_id: record.assignment_id.clone(),
                reporter: record.reporter,
            })
            .collect(),
    }
}

fn blocked_latch_for_workstream<'a>(
    state: &'a CoreState,
    workstream: &str,
) -> Option<&'a BlockedLatchState> {
    state
        .blocked_latches
        .iter()
        .find_map(|((_, candidate), latch)| (candidate == workstream).then_some(latch))
}

fn validate_blocked_gate(
    latch: &BlockedLatch,
    gate: &ChildControlBlockedGate,
) -> Result<(), String> {
    if gate.schema.0 != "autopilot.child_control_blocked_gate.v1"
        || gate.latch_id != latch.latch_id
        || gate.run_id != latch.run_id
        || gate.cancellations.len() != latch.cancellations.len()
    {
        return Err("blocked gate identity/count drift".to_owned());
    }
    for (gate_item, latch_item) in gate.cancellations.iter().zip(&latch.cancellations) {
        if gate_item.task_id != latch_item.task_id
            || gate_item.action_id != latch_item.action_id
            || gate_item.assignment_id != latch_item.assignment_id
            || gate_item.reporter != latch_item.reporter
        {
            return Err("blocked gate cancellation correlation drift".to_owned());
        }
    }
    Ok(())
}

fn ensure_workstream_unblocked(state: &CoreState, workstream: &str) -> Result<(), AnyError> {
    if let Some(error) = state.blocked_projection_error() {
        return Err(format!("blocked-latch:{error}").into());
    }
    if let Some(latch) = blocked_latch_for_workstream(state, workstream) {
        return Err(format!(
            "blocked-latch:workstream={workstream};receipt={};latch={}",
            latch.receipt.receipt_id.0, latch.latch.latch_id.0
        )
        .into());
    }
    Ok(())
}

fn workstream_for_background_action(
    state: &CoreState,
    action: &BackgroundAction,
) -> Result<String, AnyError> {
    let mut matches = strict_versioned_runner_bindings(state)?
        .into_iter()
        .filter_map(|versioned| match versioned {
            VersionedRunnerBinding::ReceiptV1(binding)
                if binding.action_id == action.action_id
                    && binding.assignment_id == action.assignment_id
                    && binding.run_revision == action.run_revision =>
            {
                Some(binding.workstream.0)
            }
            VersionedRunnerBinding::ReceiptV1(_) | VersionedRunnerBinding::ReplayV0(_) => None,
        })
        .collect::<Vec<_>>();
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err(format!(
            "blocked-latch:unbound-background-action:{}:{}:{}",
            action.action_id.0, action.assignment_id.0, action.run_revision
        )
        .into()),
        count => Err(format!(
            "blocked-latch:ambiguous-background-action:{}:{}:{}:{count}",
            action.action_id.0, action.assignment_id.0, action.run_revision
        )
        .into()),
    }
}

fn ensure_action_unblocked(state: &CoreState, action: &BackgroundAction) -> Result<(), AnyError> {
    if let Some(error) = state.blocked_projection_error() {
        return Err(format!("blocked-latch:{error}").into());
    }
    ensure_workstream_unblocked(state, &workstream_for_background_action(state, action)?)
}

fn child_control_accept(
    id: u64,
    request_id: Id,
    receipt: SubmitReceipt,
) -> Result<SeamEnvelope, AnyError> {
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "child-control".to_owned(),
        payload: serde_json::to_value(CoreToHostChildControlPayload {
            response: ChildControlResponse::Accept {
                schema: SchemaId("autopilot.child_control_response.v1".to_owned()),
                request_id,
                receipt: ChildControlAcceptReceipt::Submit {
                    schema: SchemaId("autopilot.child_control_accept_receipt.v1".to_owned()),
                    receipt,
                },
            },
            blocked_gate: Nullable(None),
        })?,
    })
}

fn child_control_accept_blocked(
    id: u64,
    request_id: Id,
    receipt: BlockedReceipt,
    latch: BlockedLatch,
) -> Result<SeamEnvelope, AnyError> {
    validate_blocked_latch(&receipt, &latch)
        .map_err(|error| format!("blocked acceptance drift:{error}"))?;
    let gate = blocked_gate(&latch);
    validate_blocked_gate(&latch, &gate)
        .map_err(|error| format!("blocked acceptance gate drift:{error}"))?;
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "child-control".to_owned(),
        payload: serde_json::to_value(CoreToHostChildControlPayload {
            response: ChildControlResponse::Accept {
                schema: SchemaId("autopilot.child_control_response.v1".to_owned()),
                request_id,
                receipt: ChildControlAcceptReceipt::Blocked {
                    schema: SchemaId("autopilot.child_control_accept_receipt.v1".to_owned()),
                    receipt,
                },
            },
            blocked_gate: Nullable(Some(gate)),
        })?,
    })
}

fn blocked_observation_ack(id: u64, state: &BlockedLatchState) -> Result<SeamEnvelope, AnyError> {
    let reporter = state
        .latch
        .cancellations
        .last()
        .filter(|record| record.reporter)
        .ok_or("blocked latch has no reporter")?;
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "blocked-result-observed".to_owned(),
        payload: serde_json::to_value(CoreToHostBlockedResultObservedPayload {
            schema: SchemaId("autopilot.blocked_result_observed_ack.v1".to_owned()),
            receipt_id: state.receipt.receipt_id.clone(),
            latch_id: state.latch.latch_id.clone(),
            reporter_task_id: reporter.task_id.clone(),
            status: BlockedResultObservedAckStatus::Acknowledged,
        })?,
    })
}

fn blocked_private_rejection(
    id: u64,
    route: &str,
    category: &str,
) -> Result<SeamEnvelope, AnyError> {
    // Private route errors are protocol rejections, not Core process errors.
    // Never reflect attacker-controlled parse, path, or persistence details.
    done(id, rejection(route, category))
}

fn route_blocked_result_observed(
    id: u64,
    payload: HostToCoreBlockedResultObservedPayload,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    match route_blocked_result_observed_inner(id, payload, state) {
        Ok(frame) => Ok(frame),
        Err(_) => blocked_private_rejection(id, "blocked-result-observed", "rejected"),
    }
}

fn route_blocked_result_observed_inner(
    id: u64,
    payload: HostToCoreBlockedResultObservedPayload,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    if !host_broker_authorized(&payload.broker_capability)
        || payload.schema.0 != "autopilot.blocked_result_observed.v1"
        || payload.tool_call_id.trim().is_empty()
    {
        return Err("rejection:blocked-result-observed:unauthenticated-or-malformed".into());
    }
    // Re-read the event-root projection before releasing the reporter; an
    // in-memory latch is never authority after artifact corruption.
    state.rebuild_blocked_latches()?;
    let latch_state = state
        .blocked_latches
        .values()
        .find(|entry| entry.receipt.receipt_id == payload.receipt_id)
        .cloned()
        .ok_or("rejection:blocked-result-observed:unknown-receipt")?;
    let binding = blocked_binding_for_receipt(state, &latch_state.receipt)
        .map_err(|error| format!("rejection:blocked-result-observed:{error}"))?;
    if payload.run_id != latch_state.receipt.run_id
        || payload.assignment_id != latch_state.receipt.assignment_id
        || payload.attempt != latch_state.receipt.attempt
        || !runner::constant_time_hex_digest_matches(&payload.token, &binding.run_capability_digest)
        || state
            .blocked_reporter_tool_calls
            .get(&payload.receipt_id.0)
            .is_some_and(|current| current != &payload.tool_call_id)
    {
        return Err("rejection:blocked-result-observed:identity-or-capability-drift".into());
    }
    if latch_state.reporter_observed {
        return blocked_observation_ack(id, &latch_state);
    }
    let reporter = latch_state
        .latch
        .cancellations
        .last()
        .filter(|record| record.reporter)
        .ok_or("rejection:blocked-result-observed:missing-reporter")?;
    let observed = BlockedObservedRefV1 {
        schema: "autopilot.blocked_result_observed.v1".to_owned(),
        receipt_id: latch_state.receipt.receipt_id.clone(),
        latch_id: latch_state.latch.latch_id.clone(),
        reporter_task_id: reporter.task_id.clone(),
    };
    state.append(
        EventKind("blocked:result-observed".to_owned()),
        vec![encode_blocked_observed_ref(&observed)?],
    )?;
    state.rebuild_blocked_latches()?;
    let acknowledged = state
        .blocked_latches
        .get(&(
            payload.run_id.0.clone(),
            latch_state.receipt.workstream.0.clone(),
        ))
        .ok_or("rejection:blocked-result-observed:projection-lost-latch")?;
    blocked_observation_ack(id, acknowledged)
}

fn route_blocked_reconcile(
    id: u64,
    payload: HostToCoreBlockedReconcilePayload,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    match route_blocked_reconcile_inner(id, payload, state) {
        Ok(frame) => Ok(frame),
        Err(_) => blocked_private_rejection(id, "blocked-reconcile", "rejected"),
    }
}

fn route_blocked_reconcile_inner(
    id: u64,
    payload: HostToCoreBlockedReconcilePayload,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    if !host_broker_authorized(&payload.broker_capability)
        || payload.schema.0 != "autopilot.blocked_reconcile.v1"
    {
        return Err("rejection:blocked-reconcile:unauthenticated-or-malformed".into());
    }
    recover_prepared_blocked_transactions_for_reconcile(state)?;
    state.rebuild_blocked_latches()?;
    let records = state
        .blocked_latches
        .values()
        .map(|entry| {
            let gate = blocked_gate(&entry.latch);
            validate_blocked_gate(&entry.latch, &gate)?;
            Ok(BlockedReconcileRecord {
                schema: SchemaId("autopilot.blocked_reconcile_record.v1".to_owned()),
                blocked_receipt: entry.receipt.clone(),
                blocked_gate: gate,
                reporter_observed: entry.reporter_observed,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "blocked-reconcile".to_owned(),
        payload: serde_json::to_value(CoreToHostBlockedReconcilePayload {
            schema: SchemaId("autopilot.blocked_reconcile_response.v1".to_owned()),
            records,
        })?,
    })
}

fn host_broker_authorized(supplied: &str) -> bool {
    matches!(runner::host_broker_capability_matches(supplied), Ok(true))
}

fn child_control_payload_retry(
    id: u64,
    payload: &serde_json::Value,
) -> Result<SeamEnvelope, AnyError> {
    let request_id = match payload
        .get("request")
        .and_then(|request| request.get("request_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        Some(value) => Id(value.to_owned()),
        None => Id("child-control-redacted".to_owned()),
    };
    child_control_redacted_retry(id, request_id)
}

fn child_control_redacted_retry(id: u64, request_id: Id) -> Result<SeamEnvelope, AnyError> {
    child_control_retry(
        id,
        request_id,
        submit_diagnostic_from_canonical_actual(
            "submit.broker_capability",
            "",
            "authenticated private Host/Core broker authority",
            b"",
            0,
            true,
            "Retry through the authenticated Host child-control broker.",
        ),
    )
}

fn child_control_retry(
    id: u64,
    request_id: Id,
    diagnostic: SubmitDiagnostic,
) -> Result<SeamEnvelope, AnyError> {
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "child-control".to_owned(),
        payload: serde_json::to_value(CoreToHostChildControlPayload {
            response: ChildControlResponse::Retry {
                schema: SchemaId("autopilot.child_control_response.v1".to_owned()),
                request_id,
                diagnostic,
            },
            blocked_gate: Nullable(None),
        })?,
    })
}

fn child_control_diagnostic(
    code: &str,
    pointer: &str,
    expected: &str,
    actual: &serde_json::Value,
    fix: &str,
) -> SubmitDiagnostic {
    match crate::evidence::canonical_json(actual) {
        Ok(bytes) => submit_diagnostic_from_canonical_actual(
            code,
            pointer,
            expected,
            &bytes,
            diagnostic_item_count(actual),
            matches!(code, "submit.capability" | "submit.broker_capability"),
            fix,
        ),
        // Never substitute `null` (or a partial serialization) for an actual
        // value. Canonicalization is itself the precise retry cause; its
        // diagnostic binds only that trusted cause, not fabricated bytes for
        // the rejected model value.
        Err(_) => submit_diagnostic_from_canonical_actual(
            "submit.diagnostic_canonical_json",
            pointer,
            "canonical JSON actual bytes",
            b"\"canonicalization failed\"",
            1,
            false,
            "Resubmit a JSON-compatible terminal payload.",
        ),
    }
}

fn diagnostic_item_count(actual: &serde_json::Value) -> u64 {
    match actual {
        serde_json::Value::Array(items) => items.len() as u64,
        serde_json::Value::Object(items) => items.len() as u64,
        serde_json::Value::Null
        | serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_) => 1,
    }
}

fn submit_diagnostic_from_canonical_actual(
    code: &str,
    pointer: &str,
    expected: &str,
    bytes: &[u8],
    item_count: u64,
    redacted: bool,
    fix: &str,
) -> SubmitDiagnostic {
    const PREVIEW_MAX_BYTES: usize = 256;
    let preview = if redacted {
        String::new()
    } else {
        let mut end = bytes.len().min(PREVIEW_MAX_BYTES);
        while end > 0 && !std::str::from_utf8(&bytes[..end]).is_ok() {
            end -= 1;
        }
        // Canonical JSON bytes are UTF-8. If the bounded cut falls inside a
        // code point, walk back to its boundary; failure here is impossible
        // without changing the exact bytes that were already hashed.
        std::str::from_utf8(&bytes[..end])
            .expect("canonical JSON byte prefix is UTF-8")
            .to_owned()
    };
    let truncated = redacted || preview.as_bytes().len() < bytes.len();
    let mut errors = vec![SubmitDiagnosticError {
        index: 0,
        code: code.to_owned(),
        pointer: pointer.to_owned(),
        expected: expected.to_owned(),
        actual: SubmitDiagnosticActual {
            preview,
            redacted,
            truncated,
            sha256: Digest(sha256_hex_local(bytes)),
            byte_count: bytes.len() as u64,
            item_count,
        },
        fix: fix.to_owned(),
    }];
    errors.sort_by(|left, right| {
        (
            left.pointer.as_bytes(),
            left.code.as_str(),
            left.expected.as_str(),
            left.actual.sha256.0.as_str(),
        )
            .cmp(&(
                right.pointer.as_bytes(),
                right.code.as_str(),
                right.expected.as_str(),
                right.actual.sha256.0.as_str(),
            ))
    });
    for (index, error) in errors.iter_mut().enumerate() {
        error.index = index as u32;
    }
    SubmitDiagnostic {
        schema: SchemaId("autopilot.submit_diagnostic.v1".to_owned()),
        code: "AUTOPILOT_SUBMIT_RETRY".to_owned(),
        error_count: errors.len() as u32,
        errors,
    }
}

/// Preserve RFC6901 input pointers and translate only genuine dotted/indexed
/// validator paths. In particular `units[0]` becomes `/units/0`, never the
/// incorrect escaped property `/units[0]`.
fn diagnostic_pointer(field: &str) -> String {
    if field.is_empty() {
        return String::new();
    }
    if field.starts_with('/') {
        return field.to_owned();
    }
    let mut segments = Vec::new();
    for dotted in field.split('.') {
        let mut rest = dotted;
        loop {
            match rest.find('[') {
                Some(open) => {
                    if open > 0 {
                        segments.push(&rest[..open]);
                    }
                    let Some(close) = rest[open + 1..].find(']') else {
                        segments.push(rest);
                        break;
                    };
                    let close = open + 1 + close;
                    let index = &rest[open + 1..close];
                    if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
                        segments.push(rest);
                        break;
                    }
                    segments.push(index);
                    rest = &rest[close + 1..];
                    if rest.is_empty() {
                        break;
                    }
                }
                None => {
                    if !rest.is_empty() {
                        segments.push(rest);
                    }
                    break;
                }
            }
        }
    }
    if segments.is_empty() {
        return String::new();
    }
    segments
        .into_iter()
        .fold(String::new(), |mut pointer, segment| {
            pointer.push('/');
            pointer.push_str(&segment.replace('~', "~0").replace('/', "~1"));
            pointer
        })
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
    if let Err(error) = ensure_workstream_unblocked(state, workstream) {
        return done(id, rejection("blocked-latch", &error.to_string()));
    }
    let source = TaskFiles(args[1..].iter().map(PathBuf::from).collect());
    let input_set = source
        .input_set()
        .map_err(|error| context_status("planning", error))?;
    let inventory = planning::p1_inventory_from_input_set(&input_set)
        .map_err(|error| context_status("planning", error))?;
    let dossier = planning::p2_ground(&RepoGrounding, &inventory)
        .map_err(|error| context_status("planning", error))?;
    let plan = planning::AssignmentPlan::d72_default();
    plan.validate(25)
        .map_err(|error| context_status("planning", error))?;
    let assignments =
        planning_assignments(workstream).map_err(|error| context_status("planning", error))?;
    write_planning_manifest(workstream, &input_set, &inventory, &dossier, &assignments)?;
    match next_planning_outcome(workstream, state)
        .map_err(|error| format!("CONTEXT_GAP:planning:{error}"))?
    {
        planning::PlanningWaveOutcome::Launch {
            assignments: wave, ..
        } => {
            let actions = planning_wave_actions(workstream, &wave, state, &input_set, None)?;
            controlled_spawn_wave(id, actions, state, "planning")
        }
        planning::PlanningWaveOutcome::WaitingOnInFlight { wave_id, active } => {
            let actions = match unacknowledged_planning_actions(state, &active) {
                Ok(actions) => actions,
                Err(error) => match migration_required_status(&error) {
                    Some(status) => return done(id, status),
                    None => return Err(error),
                },
            };
            if actions.is_empty() {
                return done(id, planning_waiting_status(&wave_id, &active, state));
            }
            validate_spawn_wave_actions(&actions)?;
            spawn_wave(id, actions, state)
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
    if let Err(error) = ensure_workstream_unblocked(state, workstream) {
        return done(id, rejection("blocked-latch", &error.to_string()));
    }
    if let Some(status) =
        advance_lifecycle_if_ready(workstream, None, ClosureTrigger::RunCommand, state)?
    {
        return done(id, status);
    }
    match advance_run(id, workstream, state) {
        Ok(outcome) => advance_run_envelope(id, outcome),
        Err(error) => match migration_required_status(&error) {
            Some(status) => done(id, status),
            None => Err(error),
        },
    }
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
    let approved_artifact = read_approved_plan_artifact(workstream, state)
        .map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
    let cwd = fs::canonicalize(std::env::current_dir()?)?;
    ensure_run_main_from_current_head(&cwd, workstream, delivery_execution_started(state))?;
    let approved = approved_artifact.units();
    let submission = allocation_submission_from_plan(workstream, approved, state)
        .map_err(|error| format!("CONTEXT_GAP:allocation:{error}"))?;
    let allocation = allocation::validate_allocation(
        approved,
        &submission,
        AllocationPolicy {
            parallel_cap: 8,
            active_implementers: active_implementers(state),
        },
    )
    .map_err(|error| format!("allocation:{error:?}"))?;
    let readiness = lane_readiness_from_events(&submission.lanes, approved, state);
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
    // marker cannot silently re-enable double dispatch. A malformed namespaced
    // binding is authority failure, never an absent live delivery.
    let mut dispatchable = Vec::new();
    for lane_id in selected {
        if !lane_has_live_delivery(state, &lane_id)? {
            dispatchable.push(lane_id);
        }
    }
    let selected = dispatchable;
    if let Some(lane_id) = selected.first() {
        // The ready-root enum is the explicit version authority. V1 keeps the
        // historical V3 assignment/policy path; only a rooted V2 image enters
        // V4 materialization before prompt/spec/carrier issuance.
        let facts = runner::RunnerTransportFacts::from_env()?;
        let issue = match &approved_artifact {
            ApprovedPlanAuthority::V1(_) => {
                let assignment = assignment(workstream, lane_id, approved, &submission)?;
                runner::delivery_issue_with_facts(&assignment, &facts)?
            }
            ApprovedPlanAuthority::V2 { artifact, root } => {
                let assignment =
                    assignment_v4(workstream, lane_id, approved, &submission, artifact, root)?;
                runner::delivery_issue_v4_with_facts(&assignment, &facts)?
            }
        };
        append_runner_invocation(state, &issue)?;
        let envelope = controlled_spawn(id, issue.action, state, "delivery")?;
        return Ok(AdvanceRunOutcome::Dispatched(envelope));
    }

    let diagnostics = advance_diagnostics(state, &submission, approved, &readiness, &selected);
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
    if blocked_latch_for_workstream(state, workstream).is_some() {
        return Ok(None);
    }
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
        let validation = strict_recovery_source_binding(state, &idv(&validation_id))?;
        if validation.workstream.0 != workstream
            || validation.role_id.0 != "validator"
            || !terminal_consumed(state, &validation)
        {
            continue;
        }
        // Fresh receipt transitions already contain the sole recovery action
        // and deferred spawn effect. Never re-enter the legacy carrier reader
        // (which would revalidate V5/Git and could duplicate that action).
        if receipt_transition_consumed_for_binding(
            state,
            &validation,
            VALIDATION_TRANSITION_KIND_REF_PREFIX,
        ) {
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
        let producer = strict_recovery_source_binding(state, producer_id)?;
        if let Some(recovery) =
            recovery_binding_for_resume(state, &producer, &validation.assignment_id)?
        {
            if terminal_consumed(state, &recovery) || launch_ack_consumed(state, &recovery) {
                continue;
            }
            let receipt_recovery = match versioned_binding_for(
                state,
                &recovery.action_id.0,
                &recovery.assignment_id.0,
            )? {
                VersionedRunnerBinding::ReceiptV1(binding) => binding,
                VersionedRunnerBinding::ReplayV0(binding) => {
                    return Err(replay_v0_migration_required(&binding));
                }
            };
            let action = planning_action_from_binding(&receipt_recovery)?;
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
    if blocked_latch_for_workstream(state, workstream).is_some() {
        return Ok(None);
    }
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
        let source = strict_recovery_source_binding(state, &idv(&source_id))?;
        if source.workstream.0 != workstream
            || source.result_contract.0 != "autopilot.delivery_result.v2"
            || !terminal_consumed(state, &source)
        {
            continue;
        }
        if receipt_transition_consumed_for_binding(
            state,
            &source,
            DELIVERY_TRANSITION_KIND_REF_PREFIX,
        ) {
            continue;
        }
        // Re-hash the durable source before inspecting any recovery directive or
        // re-emitting a child. A locally refreshed spec cannot replace the issued
        // assignment digest retained in the runner binding.
        read_delivery_assignment_artifact(&source)?;
        if let Some(recovery) = recovery_binding_for_resume(state, &source, &source.assignment_id)?
        {
            if terminal_consumed(state, &recovery) || launch_ack_consumed(state, &recovery) {
                continue;
            }
            let receipt_recovery = match versioned_binding_for(
                state,
                &recovery.action_id.0,
                &recovery.assignment_id.0,
            )? {
                VersionedRunnerBinding::ReceiptV1(binding) => binding,
                VersionedRunnerBinding::ReplayV0(binding) => {
                    return Err(replay_v0_migration_required(&binding));
                }
            };
            let action = planning_action_from_binding(&receipt_recovery)?;
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

fn lane_has_live_delivery(state: &CoreState, lane_id: &Id) -> Result<bool, String> {
    for reference in state
        .state
        .refs
        .keys()
        .filter(|reference| reference.0.starts_with(runner::ISSUED_BINDING_REF_PREFIX))
    {
        let binding = match runner::decode_versioned_binding_ref(&reference.0)
            .map_err(|error| format!("live-delivery namespaced binding decode: {error}"))?
        {
            VersionedRunnerBinding::ReplayV0(binding) => binding,
            VersionedRunnerBinding::ReceiptV1(binding) => {
                runner::receipt_v1_validator_facade(&binding)
            }
        };
        if matches!(
            binding.role_id.0.as_str(),
            "implementer" | "recovery-engineer"
        ) && binding.lane_id.as_ref() == Some(lane_id)
            && !terminal_consumed(state, &binding)
        {
            return Ok(true);
        }
    }
    Ok(false)
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
    state: &CoreState,
) -> Result<Vec<Ref>, AnyError> {
    let Some(lane_id) = lane_id else {
        return Ok(Vec::new());
    };
    let approved = read_approved_plan_artifact(workstream, state)
        .map_err(|error| format!("CONTEXT_GAP:approved-plan:{error}"))?;
    let units = approved.units();
    let unit = units
        .iter()
        .enumerate()
        .find(|(index, _)| approved_lane_id(*index) == *lane_id)
        .map(|(_, unit)| unit)
        .ok_or_else(|| format!("forward-gate:unknown-lane:{}", lane_id.0))?;
    let criterion = Id(format!("unit-complete:{}", unit.id.0));
    Ok(units
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
    if !matches!(
        carrier.schema.as_str(),
        "autopilot.planning_carrier.v1" | "autopilot.planning_carrier.v2"
    ) || carrier.assignment_id != assignment_id.0
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
    if let Err(error) = ensure_workstream_unblocked(state, &binding.workstream.0) {
        return done(id, rejection("blocked-latch", &error.to_string()));
    }
    if carrier.schema == "autopilot.planning_carrier.v2"
        && let Err(error) = verify_v2_observed_carrier(&carrier, &binding)
    {
        return done(id, rejection("agent-carrier-v2", &error));
    }
    let v2_admission = if carrier.schema == "autopilot.planning_carrier.v2" {
        match admit_v2_work_map(state, &binding, true) {
            Ok(admitted) => Some(admitted),
            Err(error) => return done(id, rejection("agent-carrier-v2", &error)),
        }
    } else {
        None
    };
    let review_v2_subject = if carrier.boundary_id == "planning.plan-review.v1" {
        match planning_subject_is_v2(&binding) {
            Ok(value) => value,
            Err(error) => return done(id, rejection("planning-subject", &error)),
        }
    } else {
        false
    };
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
    if v2_admission.is_none()
        && let Err(error) = validate_agent_output(&binding, &carrier.raw_output)
    {
        return done(id, boundary_status(&error));
    }
    let recovery_admission = match v2_admission.as_ref() {
        Some(admitted) => match admitted.recovery_disposition() {
            Some(
                kernel::generated::RecoveryDisposition::RequiresNewAuthority
                | kernel::generated::RecoveryDisposition::InfrastructureBlocked
                | kernel::generated::RecoveryDisposition::UnsafeBlocked,
            ) => PlanningRecoveryAdmission::FailClosed(
                admitted
                    .recovery_disposition()
                    .expect("matched V2 blocked recovery disposition")
                    .clone(),
            ),
            _ => PlanningRecoveryAdmission::Continue,
        },
        None => match validate_recovery_work_map(&carrier, &binding) {
            Ok(admission) => admission,
            Err(error) => return done(id, rejection("planning-recovery", &error)),
        },
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
        && v2_admission.is_none()
        && let Err(error) = apply_planning_side_effects(&carrier, &binding)
    {
        return done(id, rejection("planning-postprocess", &error));
    }
    if let Some(payload) = terminal {
        // V2 approval roots image/binding before terminal completion is
        // consumed and before the ready event is appended.
        if !review_v2_subject {
            append_terminal_event(state, payload, &binding)?;
            record_task_completion_control(state, payload)?;
        }
    } else if first_review_requires_recovery {
        return done(
            id,
            rejection(
                "planning-recovery",
                "blocked first review requires durable terminal evidence",
            ),
        );
    }
    if carrier.boundary_id == "planning.plan-review.v1"
        && !first_review_requires_recovery
        && review_v2_subject
    {
        let promotion = match promote_v2_review_subject(state, &binding) {
            Ok(value) => value,
            Err(error) => return done(id, rejection("approved-plan-v2", &error)),
        };
        if let Err(error) =
            read_approved_plan_v2(&promotion.binding_path, &promotion.binding_sha256)
        {
            return done(id, rejection("approved-plan-v2", &error));
        }
        let payload = terminal.ok_or_else(|| {
            "approved V2 final review requires durable terminal completion evidence".to_owned()
        })?;
        // This is deliberately one append.  Files may be create-once orphans
        // after a crash, but terminal consumption and completion-control facts
        // never exist without the event-rooted V2 binding/image authority.
        let ready_root = ApprovedPlanV2ReadyRootV1 {
            schema: APPROVED_PLAN_V2_READY_ROOT_SCHEMA.to_owned(),
            workstream: carrier.workstream.clone(),
            binding_path: promotion.binding_path.display().to_string(),
            binding_sha256: promotion.binding_sha256,
            approved_plan_sha256: promotion.approved_plan_sha256,
            final_review_action_id: binding.action_id.0.clone(),
            final_review_assignment_id: binding.assignment_id.0.clone(),
            final_review_run_revision: binding.run_revision,
        };
        let mut root_refs = v2_final_approval_root_refs(state, payload, &binding)?;
        root_refs.extend([
            approved_plan_v2_ready_root_ref(&ready_root)?,
            planning_result_consumed_ref(&binding),
        ]);
        state.append(EventKind("planning:ready-to-execute".to_owned()), root_refs)?;
        return done(
            id,
            format!(
                "ready-to-execute:workstream={};{}",
                carrier.workstream,
                state.summary()
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
        && matches!(
            carrier.boundary_id.as_str(),
            "planning.work-map.v1" | "planning.work-map.v2"
        )
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
        .map_err(|error| format!("CONTEXT_GAP:planning:{error}"))?
    {
        planning::PlanningWaveOutcome::Launch {
            assignments: next, ..
        } => {
            let input_set = read_planning_input_set(&carrier.workstream)
                .map_err(|error| format!("CONTEXT_GAP:planning-manifest:{error}"))?;
            let needs_atom_registry = next.iter().any(|assignment| {
                matches!(
                    assignment.boundary_id.as_deref(),
                    Some("planning.work-map.v1" | "planning.work-map.v2")
                )
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
            let actions = match unacknowledged_planning_actions(state, &active) {
                Ok(actions) => actions,
                Err(error) => match migration_required_status(&error) {
                    Some(status) => return done(id, status),
                    None => return Err(error),
                },
            };
            if actions.is_empty() {
                return done(id, planning_waiting_status(&wave_id, &active, state));
            }
            validate_spawn_wave_actions(&actions)?;
            return spawn_wave(id, actions, state);
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
    let binding = match versioned_binding_for(state, &payload.action_id.0, &payload.assignment_id.0)
    {
        Ok(VersionedRunnerBinding::ReplayV0(binding)) => binding,
        Ok(VersionedRunnerBinding::ReceiptV1(binding)) => {
            runner::receipt_v1_validator_facade(&binding)
        }
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
            match durable_launch_ack_task_id(state, &binding) {
                Ok(Some(existing)) if existing == *task_id => return done(id, state.summary()),
                Ok(Some(existing)) => {
                    return done(
                        id,
                        rejection(
                            "spawn-result",
                            &format!(
                                "acknowledged-task-id-conflict:expected={};actual={}",
                                existing.0, task_id.0
                            ),
                        ),
                    );
                }
                Ok(None) => {}
                Err(error) => return done(id, rejection("spawn-result", &error)),
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
        Err(error) => done(id, rejection("planning-postprocess", &error)),
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
    match versioned_binding_for(state, &payload.action_id.0, &payload.assignment_id.0) {
        Ok(VersionedRunnerBinding::ReceiptV1(binding)) => {
            return route_receipt_v1_task_completed(id, payload, binding, state);
        }
        Ok(VersionedRunnerBinding::ReplayV0(_)) => {}
        Err(error) => return done(id, rejection("terminal-binding", &error)),
    }
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
        let (_package, accepted) = match validated.assignment.v4.as_ref() {
            Some(artifact) => {
                let package = runner::establish_delivery_package_v4(&result, &expected, artifact);
                let accepted =
                    package
                        .as_ref()
                        .map_err(|error| error.clone())
                        .and_then(|package| {
                            runner::accept_delivery_v4_with_package_facts(
                                &result, &expected, artifact, package,
                            )
                        });
                match (package, accepted) {
                    (Ok(package), Ok(accepted)) => (package, accepted),
                    (Err(error), _) | (_, Err(error)) => {
                        return done(id, rejection("delivery-rejected", &format!("{error:?}")));
                    }
                }
            }
            None => {
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
                (package, accepted)
            }
        };
        let package_authority = match validated.assignment.v4.as_ref() {
            Some(artifact) => {
                runner::ValidationPackageAuthority::RootedV4(Box::new(artifact.clone()))
            }
            None => runner::ValidationPackageAuthority::LegacyV3,
        };
        let validation_issue = match validation_issue_for_delivery(
            &binding,
            &accepted,
            &validated.command_executions,
            package_authority,
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
    if (binding.boundary_id.0 == "planning.work-map.v2"
        && carrier.schema != "autopilot.planning_carrier.v2")
        || (binding.boundary_id.0 != "planning.work-map.v2"
            && carrier.schema == "autopilot.planning_carrier.v2")
    {
        return Err("planning carrier schema/version boundary mismatch".to_owned());
    }
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

fn verify_v2_observed_carrier(
    observed: &AgentCarrier,
    binding: &runner::IssuedRunnerBinding,
) -> Result<(), String> {
    let verified = read_verified_agent_carrier_v2(binding)?;
    if observed.raw_output.as_bytes() != verified.source.raw_work_map_payload() {
        return Err("V2 observed carrier raw output differs from sealed carrier".to_owned());
    }
    Ok(())
}

fn versioned_binding_for(
    state: &CoreState,
    action_id: &str,
    assignment_id: &str,
) -> Result<VersionedRunnerBinding, String> {
    let mut matches = strict_versioned_runner_bindings(state)?
        .into_iter()
        .filter(|binding| match binding {
            VersionedRunnerBinding::ReplayV0(binding) => {
                binding.action_id.0 == action_id && binding.assignment_id.0 == assignment_id
            }
            VersionedRunnerBinding::ReceiptV1(binding) => {
                binding.action_id.0 == action_id && binding.assignment_id.0 == assignment_id
            }
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

fn delivery_receipt_consumption_refs(
    receipt: &SubmitReceipt,
    binding: &runner::ReceiptV1RunnerBinding,
    rooted: &SubmitReceiptEventRef,
    transition: &PreparedDeliveryTransitionV1,
) -> Result<Vec<Ref>, String> {
    if !receipt_matches_binding(receipt, binding) {
        return Err("delivery receipt consumption binding identity drift".to_owned());
    }
    validate_delivery_transition(transition)?;
    let facade = runner::receipt_v1_validator_facade(binding);
    let mut refs = vec![
        Ref(format!(
            "{SUBMIT_RECEIPT_CONSUMED_PREFIX}{}",
            receipt.receipt_id.0
        )),
        terminal_consumed_ref(&facade),
        delivery_result_consumed_ref(&facade),
        receipt.prepared_transition.transition_ref.clone(),
        receipt.prepared_transition.carrier.artifact_ref.clone(),
        encode_submit_receipt_event_ref(rooted)?,
        runner::receipt_binding_ref(binding).map_err(|error| error.to_string())?,
        delivery_transition_kind_ref(&transition.event_kind)?,
    ];
    refs.extend(transition.refs.iter().cloned());
    refs.extend(
        receipt
            .prepared_transition
            .artifact_refs
            .iter()
            .map(|artifact| artifact.artifact_ref.clone()),
    );
    for issued in &receipt.prepared_transition.issued_actions {
        verify_issued_action(issued)?;
        refs.push(issued.action_ref.clone());
        refs.push(issued.binding_ref.clone());
    }
    Ok(refs)
}

fn delivery_receipt_is_exactly_consumed(
    state: &CoreState,
    receipt: &SubmitReceipt,
    binding: &runner::ReceiptV1RunnerBinding,
    rooted: &SubmitReceiptEventRef,
    transition: &PreparedDeliveryTransitionV1,
) -> Result<bool, String> {
    let consumed_ref = Ref(format!(
        "{SUBMIT_RECEIPT_CONSUMED_PREFIX}{}",
        receipt.receipt_id.0
    ));
    let rows = state
        .events
        .iter()
        .filter(|event| {
            event.kind.0 == "submit:receipt-consumed"
                && event
                    .artifact_refs
                    .iter()
                    .any(|reference| *reference == consumed_ref)
        })
        .collect::<Vec<_>>();
    if rows.is_empty() {
        if state.state.refs.contains_key(&consumed_ref) {
            return Err("delivery receipt-consumed ref lacks its durable row".to_owned());
        }
        return Ok(false);
    }
    if rows.len() != 1 {
        return Err("delivery receipt has duplicate durable consume rows".to_owned());
    }
    if rows[0].artifact_refs
        != delivery_receipt_consumption_refs(receipt, binding, rooted, transition)?
    {
        return Err("delivery receipt durable consume row identity drift".to_owned());
    }
    Ok(true)
}

fn validation_receipt_consumption_refs(
    receipt: &SubmitReceipt,
    binding: &runner::ReceiptV1RunnerBinding,
    rooted: &SubmitReceiptEventRef,
    transition: &PreparedValidationTransitionV1,
) -> Result<Vec<Ref>, String> {
    if !receipt_matches_binding(receipt, binding) {
        return Err("validation receipt consumption binding identity drift".to_owned());
    }
    validate_validation_transition(transition)?;
    let facade = runner::receipt_v1_validator_facade(binding);
    let mut refs = vec![
        Ref(format!(
            "{SUBMIT_RECEIPT_CONSUMED_PREFIX}{}",
            receipt.receipt_id.0
        )),
        terminal_consumed_ref(&facade),
        receipt.prepared_transition.transition_ref.clone(),
        receipt.prepared_transition.carrier.artifact_ref.clone(),
        encode_submit_receipt_event_ref(rooted)?,
        runner::receipt_binding_ref(binding).map_err(|error| error.to_string())?,
        validation_transition_kind_ref(&transition.event_kind)?,
    ];
    refs.extend(transition.refs.iter().cloned());
    refs.extend(
        receipt
            .prepared_transition
            .artifact_refs
            .iter()
            .map(|artifact| artifact.artifact_ref.clone()),
    );
    for issued in &receipt.prepared_transition.issued_actions {
        verify_issued_action(issued)?;
        refs.push(issued.action_ref.clone());
        refs.push(issued.binding_ref.clone());
    }
    Ok(refs)
}

fn validation_receipt_is_exactly_consumed(
    state: &CoreState,
    receipt: &SubmitReceipt,
    binding: &runner::ReceiptV1RunnerBinding,
    rooted: &SubmitReceiptEventRef,
    transition: &PreparedValidationTransitionV1,
) -> Result<bool, String> {
    let consumed_ref = Ref(format!(
        "{SUBMIT_RECEIPT_CONSUMED_PREFIX}{}",
        receipt.receipt_id.0
    ));
    let rows = state
        .events
        .iter()
        .filter(|event| {
            event.kind.0 == "submit:receipt-consumed"
                && event
                    .artifact_refs
                    .iter()
                    .any(|reference| *reference == consumed_ref)
        })
        .collect::<Vec<_>>();
    match rows.as_slice() {
        [] => {
            if state.state.refs.contains_key(&consumed_ref) {
                return Err("validation receipt-consumed ref lacks its durable row".to_owned());
            }
            Ok(false)
        }
        [row]
            if row.artifact_refs
                == validation_receipt_consumption_refs(receipt, binding, rooted, transition)? =>
        {
            Ok(true)
        }
        [_] => Err("validation receipt durable consume row identity drift".to_owned()),
        _ => Err("validation receipt has duplicate durable consume rows".to_owned()),
    }
}

/// Restart/recovery readers may recognize only the typed projection marker on
/// the one receipt-consumed row that also names this exact terminal binding.
/// They must not reopen a V5 carrier or infer a transition from loose refs.
fn receipt_transition_consumed_for_binding(
    state: &CoreState,
    binding: &runner::IssuedRunnerBinding,
    marker_prefix: &str,
) -> bool {
    state.events.iter().any(|event| {
        if event.kind.0 != "submit:receipt-consumed"
            || !event
                .artifact_refs
                .contains(&terminal_consumed_ref(binding))
        {
            return false;
        }
        event
            .artifact_refs
            .iter()
            .filter(|reference| reference.0.starts_with(marker_prefix))
            .count()
            == 1
    })
}

fn route_receipt_v1_task_completed(
    id: u64,
    payload: HostToCoreTaskCompletedPayload,
    binding: runner::ReceiptV1RunnerBinding,
    state: &mut CoreState,
) -> Result<SeamEnvelope, AnyError> {
    if payload.status != "completed" {
        return done(
            id,
            rejection(
                "submit-receipt",
                "receipt_v1 completion requires completed status",
            ),
        );
    }
    let receipt_path = match submit_receipt_path(&binding) {
        Ok(path) => path,
        Err(error) => return done(id, rejection("submit-receipt", &error)),
    };
    let receipt = match read_submit_receipt_at(&receipt_path) {
        Ok(Some(receipt)) => receipt,
        Ok(None) => return done(id, rejection("submit-receipt", "missing receipt")),
        Err(error) => return done(id, rejection("submit-receipt", &error)),
    };
    // Receipt V1 never falls back to the V4 carrier route. Completion reads
    // only the binding, receipt, and already-persisted event root; it never
    // rereads the spec, carrier, worktree, package, or raw model payload.
    if !receipt_matches_binding(&receipt, &binding)
        || receipt.prepared_transition.carrier.artifact_ref.0 != binding.carrier_path
        || verify_embedded_transition_identity(&receipt).is_err()
    {
        return done(
            id,
            rejection("submit-receipt", "receipt identity/transition mismatch"),
        );
    }
    // Completion consumes only receipt-rooted transition authority.  Planning
    // semantics are the staged immutable sidecar, never a reread carrier,
    // spec, repository, or a reconstructed legacy event.
    let planning_transition = if binding.result_contract.0.starts_with("planning.") {
        match prepared_planning_transition_from_receipt(&receipt) {
            Ok(transition) => Some(transition),
            Err(error) => return done(id, rejection("submit-receipt", &error)),
        }
    } else {
        None
    };
    let delivery_transition = if binding.result_contract.0 == "autopilot.delivery_result.v2" {
        match prepared_delivery_transition_from_receipt(&receipt) {
            Ok(transition) => Some(transition),
            Err(error) => return done(id, rejection("submit-receipt", &error)),
        }
    } else {
        None
    };
    let validation_transition = if matches!(
        binding.result_contract.0.as_str(),
        "autopilot.validation_result.v2" | "autopilot.validation_result.v3"
    ) {
        match prepared_validation_transition_from_receipt(&receipt) {
            Ok(transition) => Some(transition),
            Err(error) => return done(id, rejection("submit-receipt", &error)),
        }
    } else {
        None
    };
    // An orphan receipt is never completion authority. Verify the actual
    // persisted accepted EventRow hash; do not root it from task completion.
    let rooted = match verify_rooted_submit_receipt(state, &receipt) {
        Ok(reference) => reference,
        Err(error) => return done(id, rejection("submit-receipt", &error)),
    };
    if let Err(error) = verify_receipt_issued_actions_at_continuation_revision(&receipt, &binding) {
        return done(id, rejection("submit-receipt", &error));
    }
    let consumed_ref = Ref(format!(
        "{SUBMIT_RECEIPT_CONSUMED_PREFIX}{}",
        receipt.receipt_id.0
    ));
    let consumed = match (
        planning_transition.as_ref(),
        delivery_transition.as_ref(),
        validation_transition.as_ref(),
    ) {
        (Some(transition), None, None) => {
            match receipt_is_exactly_consumed(state, &receipt, &binding, &rooted, transition) {
                Ok(consumed) => consumed,
                Err(error) => return done(id, rejection("submit-receipt", &error)),
            }
        }
        (None, Some(transition), None) => {
            match delivery_receipt_is_exactly_consumed(
                state, &receipt, &binding, &rooted, transition,
            ) {
                Ok(consumed) => consumed,
                Err(error) => return done(id, rejection("submit-receipt", &error)),
            }
        }
        (None, None, Some(transition)) => {
            match validation_receipt_is_exactly_consumed(
                state, &receipt, &binding, &rooted, transition,
            ) {
                Ok(consumed) => consumed,
                Err(error) => return done(id, rejection("submit-receipt", &error)),
            }
        }
        (None, None, None) => state.state.refs.contains_key(&consumed_ref),
        _ => {
            return done(
                id,
                rejection("submit-receipt", "ambiguous staged transition"),
            );
        }
    };
    if consumed {
        return deferred_effect_envelope(
            id,
            &receipt.prepared_transition.deferred_host_effect,
            state,
            &binding.workstream.0,
        );
    }
    let refs = if let Some(transition) = planning_transition.as_ref() {
        match receipt_consumption_refs(&receipt, &binding, &rooted, transition) {
            Ok(refs) => refs,
            Err(error) => return done(id, rejection("submit-receipt", &error)),
        }
    } else if let Some(transition) = delivery_transition.as_ref() {
        match delivery_receipt_consumption_refs(&receipt, &binding, &rooted, transition) {
            Ok(refs) => refs,
            Err(error) => return done(id, rejection("submit-receipt", &error)),
        }
    } else if let Some(transition) = validation_transition.as_ref() {
        match validation_receipt_consumption_refs(&receipt, &binding, &rooted, transition) {
            Ok(refs) => refs,
            Err(error) => return done(id, rejection("submit-receipt", &error)),
        }
    } else {
        // Receipt V1 planning is the only staged parent transition in this
        // wave. Retain the closed generic shape for future non-planning
        // stages without granting it planning sidecar semantics.
        let rooted_ref = match encode_submit_receipt_event_ref(&rooted) {
            Ok(reference) => reference,
            Err(error) => return done(id, rejection("submit-receipt", &error)),
        };
        let mut refs = vec![
            consumed_ref,
            Ref(format!(
                "terminal-consumed:{}:{}:{}",
                binding.action_id.0, binding.assignment_id.0, binding.run_revision
            )),
            receipt.prepared_transition.transition_ref.clone(),
            receipt.prepared_transition.carrier.artifact_ref.clone(),
            rooted_ref,
            runner::receipt_binding_ref(&binding)?,
        ];
        refs.extend(
            receipt
                .prepared_transition
                .artifact_refs
                .iter()
                .map(|artifact| artifact.artifact_ref.clone()),
        );
        for issued in &receipt.prepared_transition.issued_actions {
            if let Err(error) = verify_issued_action(issued) {
                return done(id, rejection("submit-receipt", &error));
            }
            refs.push(issued.action_ref.clone());
            refs.push(issued.binding_ref.clone());
        }
        refs
    };
    state.append(EventKind("submit:receipt-consumed".to_owned()), refs)?;
    // Core intentionally preserves this exact deferred envelope across a
    // crash-after-consume/response. Final Host integration must dedupe by the
    // existing action id before applying a repeated spawn effect; Core cannot
    // invent task enumeration or status authority here.
    deferred_effect_envelope(
        id,
        &receipt.prepared_transition.deferred_host_effect,
        state,
        &binding.workstream.0,
    )
}

fn deferred_effect_envelope(
    id: u64,
    effect: &DeferredHostEffectV1,
    state: &CoreState,
    workstream: &str,
) -> Result<SeamEnvelope, AnyError> {
    if !matches!(effect, DeferredHostEffectV1::Done { .. })
        && let Err(error) = ensure_workstream_unblocked(state, workstream)
    {
        return done(id, rejection("blocked-latch", &error.to_string()));
    }
    match effect {
        DeferredHostEffectV1::Done { payload } => Ok(SeamEnvelope {
            v: CONTRACT_VERSION as u32,
            id,
            kind: "done".to_owned(),
            payload: serde_json::to_value(payload)?,
        }),
        DeferredHostEffectV1::Spawn { payload } => Ok(SeamEnvelope {
            v: CONTRACT_VERSION as u32,
            id,
            kind: "spawn".to_owned(),
            payload: serde_json::to_value(payload)?,
        }),
        DeferredHostEffectV1::SpawnWave { payload } => Ok(SeamEnvelope {
            v: CONTRACT_VERSION as u32,
            id,
            kind: "spawn-wave".to_owned(),
            payload: serde_json::to_value(payload)?,
        }),
    }
}

fn binding_for(
    state: &CoreState,
    action_id: &str,
    assignment_id: &str,
) -> Result<runner::IssuedRunnerBinding, String> {
    let mut matches = strict_versioned_runner_bindings(state)?
        .into_iter()
        .filter_map(|binding| match binding {
            VersionedRunnerBinding::ReplayV0(binding) => Some(binding),
            VersionedRunnerBinding::ReceiptV1(_) => None,
        })
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

fn v2_final_approval_root_refs(
    state: &CoreState,
    payload: &HostToCoreTaskCompletedPayload,
    binding: &runner::IssuedRunnerBinding,
) -> Result<Vec<Ref>, AnyError> {
    let task_binding = serde_json::json!({"task_id":payload.task_id,"action_id":payload.action_id,"assignment_id":payload.assignment_id,"run_revision":binding.run_revision});
    let config = crate::watchdog::WatchdogConfig::package()
        .map_err(|error| format!("watchdog:policy:{error:?}"))?;
    let turn = config.completed_turn(
        active_work(state),
        Id(format!("watchdog-action-{}", state.state.revision + 1)),
        state.state.revision + 1,
    );
    Ok(vec![
        Ref(payload.task_id.0.clone()),
        Ref(payload.action_id.0.clone()),
        Ref(payload.assignment_id.0.clone()),
        Ref(payload.status.clone()),
        Ref(binding.run_revision.to_string()),
        Ref(format!("task-binding:{task_binding}")),
        terminal_consumed_ref(binding),
        Ref("module-wired:watchdog".to_owned()),
        Ref(format!("watchdog-effects:{}", turn.effects.len())),
        Ref(format!(
            "watchdog-semantic-authority:{}",
            turn.has_semantic_authority()
        )),
        Ref("completion-control:rooted".to_owned()),
    ])
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

/// The Host journals a launched task before this acknowledgement.  Response
/// loss must therefore replay exactly one durable task binding, never infer a
/// replacement task id or append a second launch row.
fn durable_launch_ack_task_id(
    state: &CoreState,
    binding: &runner::IssuedRunnerBinding,
) -> Result<Option<Id>, String> {
    let mut task_ids = Vec::new();
    for event in &state.events {
        let Some(task) = exact_launch_ack_task_binding(event)? else {
            continue;
        };
        if task.action_id == binding.action_id
            && task.assignment_id == binding.assignment_id
            && task.run_revision == binding.run_revision
        {
            task_ids.push(task.task_id);
        }
    }
    match task_ids.len() {
        0 if launch_ack_consumed(state, binding) => {
            Err("launch acknowledgement reference lacks exact durable task binding".to_owned())
        }
        0 => Ok(None),
        1 if launch_ack_consumed(state, binding) => Ok(task_ids.pop()),
        1 => Err("launch acknowledgement task binding lacks consumed reference".to_owned()),
        _ => Err("duplicate durable launch acknowledgements for binding".to_owned()),
    }
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

fn delivery_result_consumed_ref(binding: &runner::IssuedRunnerBinding) -> Ref {
    Ref(format!(
        "delivery-result-consumed:{}:{}:{}",
        binding.action_id.0, binding.assignment_id.0, binding.run_revision
    ))
}

fn terminal_status_allowed(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "killed")
}

struct ValidatedDeliveryAssignment {
    legacy: runner::DeliveryAssignmentArtifact,
    v4: Option<runner::DeliveryAssignmentArtifactV4>,
}

fn validate_delivery_assignment_binding(
    spec: &kernel::generated::AgentRunSpec,
    binding: &runner::IssuedRunnerBinding,
) -> Result<ValidatedDeliveryAssignment, String> {
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
    let artifact = runner::read_delivery_assignment_artifact(&bytes)?;
    let (legacy, v4) = match artifact {
        runner::DeliveryAssignmentArtifactReader::V3(artifact) => {
            if artifact.schema != "autopilot.delivery_assignment.v3" {
                return Err("delivery V3 schema drift".to_owned());
            }
            (artifact, None)
        }
        runner::DeliveryAssignmentArtifactReader::V4(artifact) => {
            runner::materializer_v4::replay_v4_materialization(&artifact)?;
            let legacy = runner::DeliveryAssignmentArtifact {
                schema: "autopilot.delivery_assignment.v3".to_owned(),
                workstream: artifact.workstream.clone(),
                assignment_id: artifact.assignment_id.clone(),
                lane_id: artifact.lane_id.clone(),
                attempt: artifact.attempt,
                base_commit: artifact.base_commit.clone(),
                worktree: artifact.worktree.clone(),
                ordered_units: artifact.ordered_units.clone(),
                approved_commands: artifact.approved_commands.clone(),
                recovery: artifact.recovery.clone(),
            };
            (legacy, Some(artifact))
        }
    };
    if legacy.workstream != binding.workstream
        || legacy.assignment_id != binding.assignment_id
        || Some(&legacy.lane_id) != binding.lane_id.as_ref()
        || Some(legacy.attempt) != binding.attempt
        || Some(&legacy.base_commit) != binding.base_commit.as_ref()
        || Some(legacy.worktree.as_str()) != binding.worktree.as_deref()
        || legacy.ordered_units.is_empty()
    {
        return Err("delivery assignment artifact identity drift".to_owned());
    }
    validate_delivery_artifact_units(&legacy.ordered_units)?;
    runner::validate_approved_command_bindings(&legacy)?;
    Ok(ValidatedDeliveryAssignment { legacy, v4 })
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
        crate::allocation::validate_exact_unit_file_authority(&unit.files).map_err(|error| {
            format!(
                "delivery assignment unit {} has invalid exact file authority: {error}",
                unit.id.0
            )
        })?;
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
    crate::allocation::validate_exact_plan_file_union(
        units.iter().flat_map(|unit| unit.files.iter()),
    )
    .map_err(|error| format!("delivery assignment plan file authority drift: {error}"))?;
    Ok(())
}

struct ValidatedDeliveryFacts {
    assignment: ValidatedDeliveryAssignment,
    denial_ledger: runner::child::DeliveryPolicyDenialLedger,
    command_execution_ledger: runner::child::ApprovedCommandExecutionLedger,
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

/// Legacy carrier reader delegates to the same staged-byte predicate used by
/// ChildControl.  The path is forensic-only; only the exact audit bytes differ
/// between an already-persisted replay_v0 carrier and an in-memory receipt
/// transaction.
fn validate_delivery_result_v2(
    result: &kernel::generated::DeliveryResultV2,
    binding: &runner::IssuedRunnerBinding,
) -> Result<ValidatedDeliveryFacts, String> {
    let expected_audit = PathBuf::from(&binding.carrier_path).with_extension("tool-audit.json");
    let audit = runner::read_bounded_file(&expected_audit, MAX_TOOL_AUDIT_BYTES)
        .map_err(|error| error.to_string())?;
    validate_delivery_result_v2_staged(result, binding, None, &audit)
}

/// Parent delivery predicate over the exact in-memory carrier/audit bytes
/// prepared by child admission.  Fresh V5 specs are authenticated against the
/// receipt binding before their explicit V4 facade reaches legacy predicates.
fn validate_delivery_result_v2_staged(
    result: &kernel::generated::DeliveryResultV2,
    binding: &runner::IssuedRunnerBinding,
    receipt_binding: Option<&runner::ReceiptV1RunnerBinding>,
    audit: &[u8],
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
    let spec_value: serde_json::Value =
        serde_json::from_slice(spec_bytes).map_err(|error| error.to_string())?;
    let spec = match spec_value.get("admission_mode") {
        None => {
            if receipt_binding.is_some() {
                return Err("receipt_v1 delivery captured a replay_v0 spec".to_owned());
            }
            serde_json::from_value::<kernel::generated::AgentRunSpec>(spec_value)
                .map_err(|error| error.to_string())?
        }
        Some(serde_json::Value::String(mode)) if mode == "receipt_v1" => {
            let receipt_binding = receipt_binding
                .ok_or_else(|| "replay_v0 delivery captured a receipt_v1 spec".to_owned())?;
            let fresh: kernel::generated::AgentRunSpecV5 = serde_json::from_value(spec_value)
                .map_err(|error| format!("receipt_v1 delivery spec JSON: {error}"))?;
            runner::validate_receipt_v1_spec(receipt_binding, &fresh)
                .map_err(|error| format!("receipt_v1 delivery spec authority: {error}"))?;
            runner::project_v5_spec_for_shared_admission(&fresh)
        }
        Some(_) => return Err("delivery captured spec has unsupported admission mode".to_owned()),
    };
    let assignment = validate_delivery_assignment_binding(&spec, binding)?;
    match assignment.v4.as_ref() {
        Some(artifact) => runner::materializer_v4::admit_delivery_submission_v4(
            &result.submission,
            artifact,
            binding.required_focused_evidence as usize,
        ),
        None => runner::admit_delivery_submission_with_assignment(
            &result.submission,
            &assignment.legacy,
            binding.required_focused_evidence as usize,
        ),
    }?;
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
    if audit.len() > MAX_TOOL_AUDIT_BYTES {
        return Err("delivery tool audit exceeds bounded authority size".to_owned());
    }
    if sha256_hex_local(audit) != result.tool_audit_digest.0 {
        return Err("delivery tool audit digest drift".to_owned());
    }
    let (denial_ledger, command_execution_ledger) =
        validate_delivery_tool_audit_policy(audit, &spec, result)?;
    let command_executions = validate_delivery_command_executions(
        &assignment.legacy,
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
        command_execution_ledger,
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
    let assignment_bytes = runner::read_bounded_file(
        Path::new(&assignment_path.0),
        runner::DELIVERY_ASSIGNMENT_MAX_BYTES,
    )
    .map_err(|error| error.to_string())?;
    let (expected_version, expected_policy_digest) =
        match runner::read_delivery_assignment_artifact(&assignment_bytes)? {
            runner::DeliveryAssignmentArtifactReader::V3(_) => (
                runner::DELIVERY_POLICY_VERSION,
                runner::delivery_policy_digest(
                    &assignment_path.0,
                    &assignment_digest.0,
                    &worktree.0,
                    &spec.cwd.0,
                ),
            ),
            runner::DeliveryAssignmentArtifactReader::V4(_) => (
                runner::DELIVERY_POLICY_V5_VERSION,
                runner::delivery_policy_digest_v5(
                    &assignment_path.0,
                    &assignment_digest.0,
                    &worktree.0,
                    &spec.cwd.0,
                ),
            ),
        };
    if audit.schema != "autopilot.tool_audit.v2"
        || audit.tool_call_id != result.tool_call_id
        || audit.profile_id != result.terminal_profile_id
        || audit.tool_name != result.tool_name.0
        || audit.boundary_id != result.boundary_id.0
        || audit.result_contract != result.result_contract.0
        || audit.schema_digest != result.tool_schema_digest.0
        || audit.binding != result.carrier_binding.0
        || audit.submission_digest != result.submission_digest.0
        || policy.version != expected_version
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
    if let Err(error) = ensure_workstream_unblocked(state, workstream) {
        return done(id, rejection("blocked-latch", &error.to_string()));
    }
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
    if let Err(error) = ensure_workstream_unblocked(state, &request.workstream) {
        return done(id, rejection("blocked-latch", &error.to_string()));
    }
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

pub mod approved_plan_v2;
pub(crate) use approved_plan_v2::write_approved_plan_v2;
pub use approved_plan_v2::{
    APPROVED_PLAN_V2_BINDING_SCHEMA, APPROVED_PLAN_V2_BOUNDARY, APPROVED_PLAN_V2_SCHEMA,
    ApprovedPlanArtifactV2, ApprovedPlanV2BindingV1, ApprovedPlanV2Promotion,
    ApprovedPlanV2RecoverySubjectBindingV1, read_approved_plan_v2,
    write_approved_plan_v2_for_test_only,
};

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
fn spawn(id: u64, action: BackgroundAction, state: &CoreState) -> Result<SeamEnvelope, AnyError> {
    if let Err(error) = ensure_action_unblocked(state, &action) {
        return done(id, rejection("blocked-latch", &error.to_string()));
    }
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "spawn".to_owned(),
        payload: serde_json::to_value(CoreToHostSpawnPayload { action })?,
    })
}
fn spawn_wave(
    id: u64,
    actions: Vec<BackgroundAction>,
    state: &CoreState,
) -> Result<SeamEnvelope, AnyError> {
    for action in &actions {
        if let Err(error) = ensure_action_unblocked(state, action) {
            return done(id, rejection("blocked-latch", &error.to_string()));
        }
    }
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
fn replay_path(path: &Path) -> Result<(State, Vec<EventRow>, Vec<Vec<u8>>), AnyError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok((State::EMPTY, Vec::new(), Vec::new()));
        }
        Err(error) => return Err(error.into()),
    };
    let mut state = State::EMPTY;
    let mut events = Vec::new();
    let mut event_bytes = Vec::new();
    for line in io::BufReader::new(file).lines() {
        let line = line?;
        let event = serde_json::from_str::<EventRow>(&line)?;
        state = apply(state, &event);
        event_bytes.push(line.into_bytes());
        events.push(event);
    }
    Ok((state, events, event_bytes))
}
fn append_event(path: &Path, bytes: &[u8]) -> Result<(), AnyError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(bytes)?;
    file.write_all(b"\n")?;
    file.sync_data()?;
    Ok(())
}
fn rejection(code: &str, detail: &str) -> String {
    format!("rejection:{code}:{detail}")
}

fn migration_required_status(error: &AnyError) -> Option<String> {
    error
        .to_string()
        .strip_prefix(REPLAY_V0_MIGRATION_REQUIRED_PREFIX)
        .map(|detail| rejection("migration-required", detail))
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
    if let Err(error) = ensure_action_unblocked(state, &action) {
        return done(id, rejection("blocked-latch", &error.to_string()));
    }
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
    spawn(id, action, state)
}

fn controlled_spawn_wave(
    id: u64,
    actions: Vec<BackgroundAction>,
    state: &mut CoreState,
    trigger: &str,
) -> Result<SeamEnvelope, AnyError> {
    validate_spawn_wave_actions(&actions)?;
    for action in &actions {
        if let Err(error) = ensure_action_unblocked(state, action) {
            return done(id, rejection("blocked-latch", &error.to_string()));
        }
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
    spawn_wave(id, actions, state)
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
    if state.blocked_projection_error().is_some() || !state.blocked_latches.is_empty() {
        return Ok(None);
    }
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
    if let Err(error) = ensure_workstream_unblocked(state, &binding.workstream.0) {
        return done(id, rejection("blocked-latch", &error.to_string()));
    }
    append_runner_invocation(state, &issue)?;
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
    let producer = strict_recovery_source_binding(state, producer_id)?;
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
    let source_v4 = delivery_assignment_v4_for_binding(&producer)?;
    let assignment = recovery_runner_assignment(
        &producer,
        Sha(result.exact_commit.0.clone()),
        approved_units,
        directive,
        state.state.revision,
    )?;
    match source_v4 {
        Some(source) => spawn_recovery_assignment_v4(
            id,
            recovery_v4_assignment(assignment, source),
            state,
            "validation:recovery-required",
        ),
        None => spawn_recovery_assignment(id, assignment, state, "validation:recovery-required"),
    }
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
    // Fresh receipt staging and replay_v0 integration deliberately share the
    // same staleness, closure, repair, lane-close, and forward-gate predicate.
    let integration_refs =
        validation_integration_semantic_refs(state, binding, verdict, &prepared)?;
    state.append(
        EventKind("integration:forward-integrated".to_owned()),
        integration_refs,
    )?;
    if let Some(status) =
        advance_lifecycle_if_ready(workstream, None, ClosureTrigger::IntegrationComplete, state)?
    {
        return done(id, status);
    }
    match advance_run(id, workstream, state) {
        Ok(outcome) => advance_run_envelope(id, outcome),
        Err(error) => match migration_required_status(&error) {
            Some(status) => done(id, status),
            None => Err(error),
        },
    }
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

fn strict_recovery_bindings(
    state: &CoreState,
) -> Result<Vec<runner::IssuedRunnerBinding>, AnyError> {
    state
        .state
        .refs
        .keys()
        .filter(|reference| reference.0.starts_with(runner::ISSUED_BINDING_REF_PREFIX))
        .map(
            |reference| match runner::decode_versioned_binding_ref(&reference.0) {
                Ok(VersionedRunnerBinding::ReplayV0(binding)) => Ok(binding),
                Ok(VersionedRunnerBinding::ReceiptV1(binding)) => {
                    Ok(runner::receipt_v1_validator_facade(&binding))
                }
                Err(_) => Err("recovery durable runner binding ref is malformed".into()),
            },
        )
        .collect()
}

fn strict_recovery_source_binding(
    state: &CoreState,
    assignment_id: &Id,
) -> Result<runner::IssuedRunnerBinding, AnyError> {
    let mut matches = strict_recovery_bindings(state)?
        .into_iter()
        .filter(|binding| binding.assignment_id == *assignment_id)
        .collect::<Vec<_>>();
    match matches.len() {
        1 => Ok(matches.pop().expect("one matching recovery source binding")),
        0 => Err(format!(
            "recovery source binding missing for assignment {}",
            assignment_id.0
        )
        .into()),
        count => Err(format!(
            "recovery source binding duplicate for assignment {}: {count}",
            assignment_id.0
        )
        .into()),
    }
}

fn recovery_binding_for_resume(
    state: &CoreState,
    identity_source: &runner::IssuedRunnerBinding,
    trigger_assignment_id: &Id,
) -> Result<Option<runner::IssuedRunnerBinding>, AnyError> {
    let lane_id = identity_source.lane_id.as_ref().ok_or_else(|| {
        format!(
            "recovery resume identity source missing lane_id {}",
            identity_source.assignment_id.0
        )
    })?;
    let mut matches = Vec::new();
    for candidate in strict_recovery_bindings(state)?
        .into_iter()
        .filter(|candidate| {
            candidate.workstream == identity_source.workstream
                && candidate.role_id.0 == "recovery-engineer"
                && candidate.lane_id.as_ref() == Some(lane_id)
        })
    {
        let attempt = candidate.attempt.ok_or_else(|| {
            format!(
                "recovery resume binding missing selected attempt {}",
                candidate.assignment_id.0
            )
        })?;
        let expected = runner::expected_delivery_identity(
            &candidate.workstream,
            lane_id,
            &candidate.role_id,
            attempt,
        )?;
        if candidate.action_id != expected.action_id
            || candidate.assignment_id != expected.assignment_id
        {
            return Err(format!(
                "recovery resume binding identity drift: expected {}/{}, got {}/{}",
                expected.action_id.0,
                expected.assignment_id.0,
                candidate.action_id.0,
                candidate.assignment_id.0
            )
            .into());
        }
        let artifact = read_delivery_assignment_artifact(&candidate)?;
        if artifact
            .recovery
            .as_ref()
            .is_some_and(|directive| directive.trigger_assignment_id == *trigger_assignment_id)
        {
            matches.push(candidate);
        }
    }
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.pop()),
        count => Err(format!(
            "recovery resume has ambiguous durable recovery bindings for {}: {count}",
            trigger_assignment_id.0
        )
        .into()),
    }
}

#[cfg(test)]
mod recovery_resume_binding_tests {
    use super::*;

    fn unit() -> ApprovedUnit {
        let criterion = Id("criterion-U1".to_owned());
        ApprovedUnit {
            id: Id("U1".to_owned()),
            kind: kernel::generated::PlanUnitKind::Implementation,
            objective: "durable canonical recovery binding".to_owned(),
            operator_order: 1,
            decisions: Vec::new(),
            criteria: vec![criterion.clone()],
            criterion_text: vec![crate::allocation::ApprovedCriterion {
                id: criterion,
                text: "canonical binding is selected".to_owned(),
            }],
            dependencies: Vec::new(),
            predecessor_forward_criteria: Vec::new(),
            downstream_release_edges: vec![Id("edge-U1".to_owned())],
            files: vec![kernel::generated::Path("src/lib.rs".to_owned())],
            commands: vec![kernel::generated::PlanUnitCommand {
                command: "cargo test --lib".to_owned(),
                expected: "pass".to_owned(),
                effect: kernel::generated::CommandEffect::NoEffect,
                generated_paths: Vec::new(),
                handling: kernel::generated::CommandEffectHandling::None,
                scope_preservation: "final state remains in the approved file".to_owned(),
            }],
            package_checks: Vec::new(),
        }
    }

    fn binding(
        action_id: &str,
        assignment_id: &str,
        role_id: &str,
        mode: &str,
        lane_id: &str,
        attempt: u32,
        root: &Path,
    ) -> runner::IssuedRunnerBinding {
        runner::IssuedRunnerBinding {
            action_id: Id(action_id.to_owned()),
            assignment_id: Id(assignment_id.to_owned()),
            run_revision: 7,
            workstream: Id("main".to_owned()),
            role_id: Id(role_id.to_owned()),
            mode: ModeId(mode.to_owned()),
            boundary_id: kernel::generated::ContractId(
                "autopilot.delivery_submission.v2".to_owned(),
            ),
            result_contract: kernel::generated::ContractId(
                "autopilot.delivery_result.v2".to_owned(),
            ),
            prompt_path: root.join("prompt.md").display().to_string(),
            prompt_digest: "a".repeat(64),
            spec_path: root.join("spec.json").display().to_string(),
            spec_digest: "b".repeat(64),
            carrier_path: root.join("carrier.json").display().to_string(),
            session_id: Id("session".to_owned()),
            boundary_digest: "c".repeat(64),
            result_contract_digest: "d".repeat(64),
            settings_digest: "e".repeat(64),
            context_digest: "f".repeat(64),
            skills_digest: "0".repeat(64),
            subscription_digest: "1".repeat(64),
            terminal_route: None,
            assignment_path: None,
            assignment_digest: None,
            mode_parameter: None,
            planning_subject_assignment_id: None,
            planning_subject_path: None,
            planning_subject_digest: None,
            lane_id: Some(Id(lane_id.to_owned())),
            attempt: Some(attempt),
            base_commit: Some(Sha("base".to_owned())),
            worktree: Some(root.display().to_string()),
            required_focused_evidence: 2,
        }
    }

    #[test]
    fn bug_187_recovery_resume_selects_durable_canonical_binding_without_source_id_parsing() {
        let root = fs::canonicalize(std::env::temp_dir())
            .expect("canonical temporary root")
            .join(format!(
                "pi-autopilot-bug187-canonical-recovery-{}",
                std::process::id()
            ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("recovery binding root");
        let source_id = "opaque-source-identity-not-a-recovery-id";
        let lane_id = "Lsynthetic";
        let recovery_id = "recovery-assignment-main-Lsynthetic-a1";
        let recovery_action = "action-recovery-assignment-main-Lsynthetic-a1";
        let source = binding(
            "opaque-source-action",
            source_id,
            "implementer",
            "lane-delivery",
            lane_id,
            1,
            &root,
        );
        let mut recovery = binding(
            recovery_action,
            recovery_id,
            "recovery-engineer",
            "failed-test",
            lane_id,
            1,
            &root,
        );
        let artifact = runner::DeliveryAssignmentArtifact {
            schema: "autopilot.delivery_assignment.v3".to_owned(),
            workstream: recovery.workstream.clone(),
            assignment_id: recovery.assignment_id.clone(),
            lane_id: recovery.lane_id.clone().expect("recovery lane"),
            attempt: 1,
            base_commit: recovery.base_commit.clone().expect("recovery base"),
            worktree: root.display().to_string(),
            approved_commands: runner::approved_command_bindings(&[unit()]),
            ordered_units: vec![unit()],
            recovery: Some(runner::RecoveryDirective {
                schema: "autopilot.recovery_directive.v1".to_owned(),
                trigger_phase: "validation".to_owned(),
                repair_mode: ModeId("failed-test".to_owned()),
                trigger_assignment_id: Id(source_id.to_owned()),
                diagnosis_refs: vec![Ref("validation-carrier:synthetic".to_owned())],
                diagnosis_ids: vec![Id("F-synthetic".to_owned())],
                diagnosis_details: vec!["synthetic durable directive".to_owned()],
                original_gate: format!("validator:{source_id}:semantic-round-1"),
                attempt_budget: 1,
            }),
        };
        let artifact_path = root.join("recovery-assignment.json");
        let artifact_bytes = serde_json::to_vec_pretty(&artifact).expect("recovery artifact");
        fs::write(&artifact_path, &artifact_bytes).expect("write recovery artifact");
        recovery.assignment_path = Some(artifact_path.display().to_string());
        recovery.assignment_digest = Some(sha256_hex_local(&artifact_bytes));

        let mut state = CoreState::open(None).expect("core state");
        state
            .state
            .refs
            .insert(runner::binding_ref(&source).expect("source ref"), 1);
        state
            .state
            .refs
            .insert(runner::binding_ref(&recovery).expect("recovery ref"), 1);
        let selected = recovery_binding_for_resume(&state, &source, &source.assignment_id)
            .expect("canonical durable recovery selection")
            .expect("one canonical recovery binding");
        assert_eq!(selected.assignment_id.0, recovery_id);
        assert_eq!(selected.action_id.0, recovery_action);
        let _ = fs::remove_dir_all(&root);
    }
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
        &facts.assignment.legacy.ordered_units,
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
    let role_id = idv("recovery-engineer");
    let attempt = 1;
    let identity =
        runner::expected_delivery_identity(&source.workstream, &lane_id, &role_id, attempt)
            .map_err(|error| error.to_string())?;
    let session_file = PathBuf::from(format!(
        ".pi/autopilot/{}/{}.session.json",
        source.workstream.0, identity.assignment_id.0
    ));
    Ok(RunnerAssignment {
        workstream: source.workstream.clone(),
        action_id: identity.action_id,
        assignment_id: identity.assignment_id,
        role_id,
        mode: directive.repair_mode.clone(),
        run_revision,
        lane_id,
        attempt,
        base_commit,
        worktree,
        session_file,
        roster_assignment: "package-roster/reasoning".to_owned(),
        approved_units,
        recovery: Some(directive),
    })
}

fn recovery_v4_assignment(
    legacy: RunnerAssignment,
    source: runner::DeliveryAssignmentArtifactV4,
) -> runner::RunnerAssignmentV4 {
    runner::RunnerAssignmentV4 {
        workstream: legacy.workstream,
        action_id: legacy.action_id,
        assignment_id: legacy.assignment_id,
        role_id: legacy.role_id,
        mode: legacy.mode,
        run_revision: legacy.run_revision,
        lane_id: legacy.lane_id,
        attempt: legacy.attempt,
        // Recovery authority selected the current package tip.  The retained
        // materialization receipt still carries its original pinned source
        // base and identity; replay checks those separately.
        base_commit: legacy.base_commit,
        worktree: legacy.worktree,
        session_file: legacy.session_file,
        roster_assignment: legacy.roster_assignment,
        approved_units: legacy.approved_units,
        recovery: legacy.recovery,
        approved_plan_binding_path: source.approved_plan_binding_path,
        approved_plan_binding_digest: source.approved_plan_binding_digest,
        approved_image_digest: source.approved_image_digest,
        selected_vendoring: source.selected_vendoring,
        materialization: source.materialization,
    }
}

fn spawn_recovery_assignment_v4(
    id: u64,
    assignment: runner::RunnerAssignmentV4,
    state: &mut CoreState,
    event_kind: &str,
) -> Result<SeamEnvelope, AnyError> {
    if let Err(error) = ensure_workstream_unblocked(state, &assignment.workstream.0) {
        return done(id, rejection("blocked-latch", &error.to_string()));
    }
    let directive = assignment
        .recovery
        .as_ref()
        .ok_or_else(|| "recovery V4 spawn missing directive".to_owned())?;
    let trigger_assignment_id = directive.trigger_assignment_id.0.clone();
    let attempt_budget = directive.attempt_budget;
    let issue = runner::delivery_issue_v4_with_facts(
        &assignment,
        &runner::RunnerTransportFacts::from_env().map_err(|error| error.to_string())?,
    )?;
    append_runner_invocation(state, &issue)?;
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

fn delivery_assignment_v4_for_binding(
    binding: &runner::IssuedRunnerBinding,
) -> Result<Option<runner::DeliveryAssignmentArtifactV4>, String> {
    let path = binding
        .assignment_path
        .as_ref()
        .ok_or_else(|| "delivery binding missing assignment path".to_owned())?;
    let digest = binding
        .assignment_digest
        .as_ref()
        .ok_or_else(|| "delivery binding missing assignment digest".to_owned())?;
    let bytes = runner::read_bounded_file(Path::new(path), runner::DELIVERY_ASSIGNMENT_MAX_BYTES)
        .map_err(|error| error.to_string())?;
    if sha256_hex_local(&bytes) != *digest {
        return Err("delivery assignment digest drift".to_owned());
    }
    match runner::read_delivery_assignment_artifact(&bytes)? {
        runner::DeliveryAssignmentArtifactReader::V3(_) => Ok(None),
        runner::DeliveryAssignmentArtifactReader::V4(artifact) => {
            runner::materializer_v4::replay_v4_materialization(&artifact)?;
            Ok(Some(artifact))
        }
    }
}

fn spawn_recovery_assignment(
    id: u64,
    assignment: RunnerAssignment,
    state: &mut CoreState,
    event_kind: &str,
) -> Result<SeamEnvelope, AnyError> {
    if let Err(error) = ensure_workstream_unblocked(state, &assignment.workstream.0) {
        return done(id, rejection("blocked-latch", &error.to_string()));
    }
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
    append_runner_invocation(state, &issue)?;
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
    let source_v4 = delivery_assignment_v4_for_binding(binding)?;
    let assignment = recovery_runner_assignment(
        binding,
        base_commit,
        approved_units,
        directive,
        state.state.revision,
    )?;
    match source_v4 {
        Some(source) => spawn_recovery_assignment_v4(
            id,
            recovery_v4_assignment(assignment, source),
            state,
            "delivery:recovery-required",
        ),
        None => spawn_recovery_assignment(id, assignment, state, "delivery:recovery-required"),
    }
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
    let producer = strict_recovery_source_binding(state, producer_id)?;
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
    let source_v4 = delivery_assignment_v4_for_binding(&producer)?;
    let assignment = recovery_runner_assignment(
        &producer,
        Sha(result.exact_commit.0.clone()),
        approved_units,
        directive,
        state.state.revision,
    )?;
    match source_v4 {
        Some(source) => spawn_recovery_assignment_v4(
            id,
            recovery_v4_assignment(assignment, source),
            state,
            "validation:recovery-required",
        ),
        None => spawn_recovery_assignment(id, assignment, state, "validation:recovery-required"),
    }
}

fn validation_issue_for_delivery(
    binding: &runner::IssuedRunnerBinding,
    accepted: &runner::AcceptedDelivery,
    command_executions: &[runner::VerifiedCommandExecution],
    package_authority: runner::ValidationPackageAuthority,
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
    runner::validation_issue_v4(
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
            package_authority,
        },
        &runner::RunnerTransportFacts::from_env().map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn read_delivery_assignment_artifact(
    binding: &runner::IssuedRunnerBinding,
) -> Result<runner::DeliveryAssignmentArtifact, String> {
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
    let artifact = match runner::read_delivery_assignment_artifact(&bytes)? {
        runner::DeliveryAssignmentArtifactReader::V3(artifact) => artifact,
        runner::DeliveryAssignmentArtifactReader::V4(artifact) => {
            runner::materializer_v4::replay_v4_materialization(&artifact)?;
            runner::DeliveryAssignmentArtifact {
                schema: "autopilot.delivery_assignment.v3".to_owned(),
                workstream: artifact.workstream,
                assignment_id: artifact.assignment_id,
                lane_id: artifact.lane_id,
                attempt: artifact.attempt,
                base_commit: artifact.base_commit,
                worktree: artifact.worktree,
                ordered_units: artifact.ordered_units,
                approved_commands: artifact.approved_commands,
                recovery: artifact.recovery,
            }
        }
    };
    let lane_id = binding
        .lane_id
        .as_ref()
        .ok_or_else(|| "delivery binding missing lane_id".to_owned())?;
    let attempt = binding
        .attempt
        .ok_or_else(|| "delivery binding missing attempt".to_owned())?;
    let expected =
        runner::expected_delivery_identity(&binding.workstream, lane_id, &binding.role_id, attempt)
            .map_err(|error| format!("delivery binding identity: {error}"))?;
    if binding.action_id != expected.action_id
        || binding.assignment_id != expected.assignment_id
        || artifact.schema != "autopilot.delivery_assignment.v3"
        || artifact.workstream != binding.workstream
        || artifact.assignment_id != binding.assignment_id
        || artifact.lane_id != *lane_id
        || artifact.attempt != attempt
        || binding.base_commit.as_ref() != Some(&artifact.base_commit)
        || binding.worktree.as_deref() != Some(artifact.worktree.as_str())
        || artifact.ordered_units.is_empty()
    {
        return Err("delivery assignment identity drift".to_owned());
    }
    runner::validate_delivery_recovery_binding(
        &binding.role_id,
        &binding.mode,
        attempt,
        artifact.recovery.as_ref(),
    )?;
    runner::validate_approved_command_bindings(&artifact)?;
    Ok(artifact)
}

fn read_delivery_assignment_units(
    binding: &runner::IssuedRunnerBinding,
) -> Result<Vec<ApprovedUnit>, String> {
    read_delivery_assignment_artifact(binding).map(|artifact| artifact.ordered_units)
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
    advance_lifecycle_if_ready_with_finalization(workstream, request, trigger, state, None)
}

/// The fresh Validator path persists its immutable close facts before the
/// result-ref CAS. Historical lifecycle callers pass no receipt binding and
/// retain their exact behavior.
fn advance_lifecycle_if_ready_with_finalization(
    workstream: &str,
    request: Option<&ParsedCloseRequestArgs>,
    trigger: ClosureTrigger,
    state: &mut CoreState,
    validation_receipt: Option<&runner::ReceiptV1RunnerBinding>,
) -> Result<Option<String>, AnyError> {
    if let Err(error) = ensure_workstream_unblocked(state, workstream) {
        return Ok(Some(rejection("blocked-latch", &error.to_string())));
    }
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
    if let Some(binding) = validation_receipt {
        let finalization = PreparedValidationFinalizationV1 {
            schema: PREPARED_VALIDATION_FINALIZATION_SCHEMA.to_owned(),
            workstream: snapshot.workstream.clone(),
            run_id: snapshot.run_id.clone(),
            tip: snapshot.tip.clone(),
            tree: snapshot.tree.clone(),
            revision: snapshot.revision,
            final_evidence_digest: evidence.digest.clone(),
            gate_digest: qualified.gate_digest.clone(),
            result_ref: qualified.result_ref.clone(),
            close_signal: exact_close_signal(&qualified.result_ref),
        };
        persist_prepared_validation_finalization(binding, &finalization)
            .map_err(|error| format!("validation finalization intent: {error}"))?;
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
    let approved = match read_approved_plan_artifact(workstream, state) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let required_count = approved.units().len();
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
        || has_malformed_runner_binding(state)
        || has_ref_prefix(state, "unknown-job:")
        || has_ref_prefix(state, "fixer-active:")
        || has_ref_prefix(state, "validator-unknown:")
}

/// Activity accounting is fail-closed for malformed namespaced bindings and
/// recognizes the explicit receipt_v1 form instead of treating V5 work as an
/// absent legacy binding.
fn has_malformed_runner_binding(state: &CoreState) -> bool {
    state
        .state
        .refs
        .keys()
        .filter(|reference| reference.0.starts_with(runner::ISSUED_BINDING_REF_PREFIX))
        .any(|reference| runner::decode_versioned_binding_ref(&reference.0).is_err())
}

fn activity_binding(reference: &Ref) -> Option<runner::IssuedRunnerBinding> {
    match runner::decode_versioned_binding_ref(&reference.0) {
        Ok(VersionedRunnerBinding::ReplayV0(binding)) => Some(binding),
        Ok(VersionedRunnerBinding::ReceiptV1(binding)) => {
            Some(runner::receipt_v1_validator_facade(&binding))
        }
        Err(_) => None,
    }
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
        .filter_map(activity_binding)
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

fn ensure_run_main_from_current_head(
    repo: &Path,
    workstream: &str,
    execution_started: bool,
) -> Result<(), String> {
    let run_main = run_main_ref(workstream);
    match git_stdout(
        repo,
        &["rev-parse", "--verify", &format!("{run_main}^{{commit}}")],
    ) {
        Ok(_) => Ok(()),
        Err(error) if execution_started => Err(format!(
            "run-main missing after execution began: {run_main}: {error}"
        )),
        Err(_) => {
            let head = git_stdout(repo, &["rev-parse", "--verify", "HEAD^{commit}"])?;
            git_status(repo, &["update-ref", &run_main, head.trim(), ""])
                .map_err(|error| format!("run-main:create-cas:{error}"))?;
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

#[cfg(test)]
mod blocked_guard_leaf_tests {
    use super::*;

    fn degraded_state() -> CoreState {
        CoreState {
            event_path: None,
            blocked_latches: BTreeMap::new(),
            blocked_reporter_tool_calls: BTreeMap::new(),
            blocked_projection_error: Some(BLOCKED_PROJECTION_UNAVAILABLE),
            state: State::EMPTY,
            events: Vec::new(),
            event_bytes: Vec::new(),
        }
    }

    fn action() -> BackgroundAction {
        BackgroundAction {
            action_id: Id("blocked-guard-action".to_owned()),
            assignment_id: Id("blocked-guard-assignment".to_owned()),
            kind: kernel::generated::ActionKind::LaunchBackground,
            bg_run: kernel::generated::BackgroundActionBgRun {
                name: "blocked guard fixture".to_owned(),
                command: kernel::generated::Bytes("false".to_owned()),
                is_agent: true,
                timeout_seconds: Some(1),
                notify_on_completion: false,
                trigger_on_completion: false,
            },
            run_revision: 1,
            expires_at: None,
            supersession_state: kernel::generated::SupersessionState("live".to_owned()),
        }
    }

    fn assert_rejected(frame: SeamEnvelope) {
        assert_eq!(frame.kind, "done");
        assert!(
            frame.payload["status"]
                .as_str()
                .is_some_and(|status| status.starts_with("rejection:blocked-latch:"))
        );
    }

    #[test]
    fn blocked_projection_guard_rejects_every_leaf_without_a_control_or_spawn() {
        let mut state = degraded_state();
        let original_events = state.events.len();
        assert_rejected(spawn(1, action(), &state).unwrap());
        assert_rejected(spawn_wave(2, vec![action()], &state).unwrap());
        assert_rejected(controlled_spawn(3, action(), &mut state, "initial-plan").unwrap());
        assert_rejected(
            controlled_spawn_wave(4, vec![action()], &mut state, "planning-reemit").unwrap(),
        );
        assert_rejected(
            deferred_effect_envelope(
                5,
                &DeferredHostEffectV1::Spawn {
                    payload: CoreToHostSpawnPayload { action: action() },
                },
                &state,
                "ws",
            )
            .unwrap(),
        );
        assert_rejected(
            deferred_effect_envelope(
                6,
                &DeferredHostEffectV1::SpawnWave {
                    payload: CoreToHostSpawnWavePayload {
                        actions: vec![action()],
                    },
                },
                &state,
                "ws",
            )
            .unwrap(),
        );
        assert_rejected(
            route_plan(7, &["ws".to_owned(), "ignored".to_owned()], &mut state).unwrap(),
        );
        assert_rejected(route_run(8, "ws", &mut state).unwrap());
        assert_rejected(route_abort(9, "ws", &mut state).unwrap());
        assert!(
            advance_lifecycle_if_ready("ws", None, ClosureTrigger::RunCommand, &mut state)
                .unwrap()
                .is_some_and(|status| status.starts_with("rejection:blocked-latch:"))
        );
        assert_eq!(arm_watchdog_if_needed(&state, 1).unwrap(), None);
        assert_eq!(state.events.len(), original_events);
    }
}
