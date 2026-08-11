use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
#[cfg(unix)]
use std::net::Shutdown as NetShutdown;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::checkpoint::{
    AgentHandoff, CheckpointPolicy, ContextBudget, ContextPercent, ResumeOverlay,
};
use crate::runner::rpc::{
    AppendedEntry, ChildControlLaunchConfig, DeliveryPolicyLaunchConfig, RpcClient, RpcCommand,
    RpcCommandKind, RpcEvent, RpcFrame, RpcResponse, RpcSpawnConfig, ToolCarrierDetails,
    ValidationEvidenceLaunchConfig,
};

use kernel::generated::{
    AgentRunSpec, AgentRunSpecV5, CheckpointReceipt, ChildControlAcceptReceipt,
    ChildControlRuntimeEvidence, SessionContinuity, TaskDocument,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as ShaDigest, Sha256};

const DEFAULT_MAX_PI_STDERR_BYTES: usize = 256 * 1024;
pub const MAX_AGENT_RUN_SPEC_BYTES: usize = 2 << 20;
pub const MAX_RENDERED_PROMPT_BYTES: usize = 4 << 20;
pub const MAX_VALIDATION_ARTIFACT_BYTES: usize = 2 << 20;
const RUNTIME_ADDON_DIGEST_FIELD: &str = concat!("runtime_", "ext", "ension_digest");
const V5_CHECKPOINT_PROFILE_ID: &str = "autopilot.agent-handoff.v1:autopilot_checkpoint";
const V5_CHECKPOINT_TOOL_NAME: &str = "autopilot_checkpoint";
#[rustfmt::skip]
fn runtime_addon(spec: &AgentRunSpec) -> Option<(&kernel::generated::Path, &kernel::generated::Digest)> { spec.runtime_extension_path.as_ref().zip(spec.runtime_extension_digest.as_ref()) }

#[derive(Debug, Clone, Eq, PartialEq)]
struct ValueRejection {
    field: String,
    expected: String,
    got: String,
}

#[derive(Debug, Clone, PartialEq)]
struct ToolTerminal {
    tool_name: String,
    tool_call_id: String,
    details: ToolCarrierDetails,
    details_value: Value,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct ChildToolReceipt {
    entry_id: String,
    self_digest: String,
    profile_id: String,
    tool_name: String,
    boundary_id: String,
    result_contract: String,
    schema_digest: String,
    binding: String,
    active_tools: Vec<String>,
    delivery_policy: Option<ChildDeliveryPolicyReceipt>,
    validation_evidence_policy: Option<ChildValidationEvidencePolicyReceipt>,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChildToolReceiptData {
    self_digest: String,
    profile_id: String,
    tool_name: String,
    boundary_id: String,
    result_contract: String,
    schema_digest: String,
    binding: String,
    active_tools: Vec<String>,
    #[serde(default)]
    delivery_policy: Option<ChildDeliveryPolicyReceipt>,
    #[serde(default)]
    validation_evidence_policy: Option<ChildValidationEvidencePolicyReceipt>,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChildDeliveryPolicyReceipt {
    version: String,
    assignment_path: String,
    assignment_digest: String,
    worktree: String,
    cwd: String,
    policy_digest: String,
    allowed_unit_file_count: usize,
    approved_command_count: usize,
    active_overrides: Vec<String>,
    #[serde(default)]
    mutable_authored_leaf_count: Option<usize>,
    #[serde(default)]
    protected_core_leaf_count: Option<usize>,
    #[serde(default)]
    baseline_digest: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChildValidationEvidencePolicyReceipt {
    context_path: String,
    context_digest: String,
    cwd: String,
    evidence_count: usize,
    active_override: String,
}

pub(crate) const MAX_DELIVERY_POLICY_DENIALS: usize = 32;
pub(crate) const MAX_APPROVED_COMMAND_EXECUTIONS: usize = 64;

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DeliveryPolicyDenialKind {
    UnapprovedCommand,
    CwdMismatch,
    MalformedMutation,
    UnapprovedMutationPath,
    UnapprovedParentDirectory,
    OutsideWorktree,
    ReservedPath,
    TopologyRefusal,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeliveryPolicyDenial {
    pub denial_id: String,
    pub kind: DeliveryPolicyDenialKind,
    pub tool: String,
    pub request_digest: String,
    pub effected: bool,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeliveryPolicyDenialLedger {
    pub schema: String,
    pub overflowed: bool,
    pub entries: Vec<DeliveryPolicyDenial>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ApprovedCommandExecutionOutcome {
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ApprovedCommandExecution {
    pub execution_id: String,
    pub command_id: kernel::generated::Id,
    pub command_digest: String,
    pub outcome: ApprovedCommandExecutionOutcome,
    pub result_digest: String,
    pub scope_snapshot_digest: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ApprovedCommandExecutionLedger {
    pub schema: String,
    pub overflowed: bool,
    pub entries: Vec<ApprovedCommandExecution>,
}

pub(crate) fn validate_delivery_policy_denial_ledger(
    ledger: &DeliveryPolicyDenialLedger,
) -> Result<(), String> {
    if ledger.schema != "autopilot.delivery_policy_denials.v2"
        || ledger.entries.len() > MAX_DELIVERY_POLICY_DENIALS
        || (ledger.overflowed && ledger.entries.len() != MAX_DELIVERY_POLICY_DENIALS)
    {
        return Err("delivery policy denial ledger shape drift".to_owned());
    }
    for (index, entry) in ledger.entries.iter().enumerate() {
        let expected_id = format!("denial-{}", index + 1);
        if entry.denial_id != expected_id
            || entry.tool != super::APPROVED_COMMAND_TOOL
            || entry.request_digest.len() != 64
            || !entry
                .request_digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || entry.effected
        {
            return Err("delivery policy denial ledger entry drift".to_owned());
        }
    }
    Ok(())
}

pub(crate) fn validate_approved_command_execution_ledger(
    ledger: &ApprovedCommandExecutionLedger,
) -> Result<(), String> {
    if ledger.schema != "autopilot.approved_command_executions.v1"
        || ledger.entries.len() > MAX_APPROVED_COMMAND_EXECUTIONS
        || (ledger.overflowed && ledger.entries.len() != MAX_APPROVED_COMMAND_EXECUTIONS)
    {
        return Err("approved command execution ledger shape drift".to_owned());
    }
    for (index, entry) in ledger.entries.iter().enumerate() {
        if entry.execution_id != format!("execution-{}", index + 1)
            || entry.command_id.0.trim().is_empty()
            || !is_sha256_hex(&entry.command_digest)
            || !is_sha256_hex(&entry.result_digest)
            || !is_sha256_hex(&entry.scope_snapshot_digest)
        {
            return Err("approved command execution ledger entry drift".to_owned());
        }
    }
    Ok(())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Clone, PartialEq)]
enum CarrierSource {
    Tool(ToolTerminal),
}

#[derive(Debug, Clone, Eq, PartialEq)]
enum CarrierRejection {
    Identity(String),
    Value(ValueRejection),
}

#[derive(Debug)]
pub(crate) enum PreparedArtifact {
    JsonNew { path: String, value: Value },
    ExactBytes { path: PathBuf, bytes: Vec<u8> },
}

/// Fully value-admitted, but not persisted, submission material. Only the
/// Core seam may publish this material after it has staged the parent
/// transition and receipt.
#[derive(Debug)]
pub(crate) struct PreparedCarrier {
    pub(crate) carrier: Value,
    pub(crate) artifacts: Vec<PreparedArtifact>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) enum AdmissionFailure {
    Authority(String),
    Value {
        field: String,
        expected: String,
        actual: String,
    },
    PlaceholderLeaked,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) enum TerminalToolNotOfferedSource {
    PrePromptActiveTools,
    OfferedTerminalToolGuard,
    TerminalCycleOfferedTools,
}

#[cfg(test)]
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) enum TerminalMiss {
    ProseInsteadOfTerminal {
        text_len: usize,
        text_digest: [u8; 32],
        preview: String,
        tool_execution_count: u32,
    },
    EmptyStopNoTerminal {
        tool_execution_count: u32,
        last_tool_name: Option<String>,
    },
    NoTerminalFrame {
        messages_seen: u32,
        last_stop_reason: Option<String>,
    },
    TerminalToolNotOffered {
        source: TerminalToolNotOfferedSource,
        expected_tool: String,
        offered_tools: Vec<String>,
    },
    MultipleTerminals {
        count: u32,
    },
}

#[cfg(test)]
#[derive(Debug, Clone, Eq, PartialEq)]
struct OfferedTerminalTool {
    name: String,
    offered_tools: Vec<String>,
}

#[cfg(test)]
impl OfferedTerminalTool {
    fn new(spec: &AgentRunSpec) -> Result<Self, TerminalMiss> {
        let profile = super::terminal_profile_for(
            &spec.role_id.0,
            &spec.boundary_id.0,
            &spec.result_contract.0,
        )
        .map_err(|error| TerminalMiss::NoTerminalFrame {
            messages_seen: 0,
            last_stop_reason: Some(error.to_string()),
        })?;
        let mut offered_tools = spec
            .allowed_tools
            .iter()
            .map(|tool| tool.0.clone())
            .collect::<Vec<_>>();
        offered_tools.sort();
        if !offered_tools.iter().any(|tool| tool == profile.1) {
            return Err(TerminalMiss::TerminalToolNotOffered {
                source: TerminalToolNotOfferedSource::OfferedTerminalToolGuard,
                expected_tool: profile.1.to_owned(),
                offered_tools,
            });
        }
        Ok(Self {
            name: profile.1.to_owned(),
            offered_tools,
        })
    }
}

impl From<ValueRejection> for CarrierRejection {
    fn from(value: ValueRejection) -> Self {
        Self::Value(value)
    }
}

fn read_bounded_utf8(path: &Path, max_bytes: usize, label: &str) -> Result<String, String> {
    let bytes =
        super::read_bounded_file(path, max_bytes).map_err(|error| format!("{label}:{error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("{label}:utf8:{error}"))
}

pub fn main(args: &[String]) -> Result<(), String> {
    let spec_path = parse_args(args)?;
    let raw = read_bounded_utf8(&spec_path, MAX_AGENT_RUN_SPEC_BYTES, "agent-run spec read")?;
    let spec_value: Value = serde_json::from_str(&raw).map_err(|error| {
        format!("agent-run spec is malformed, incomplete, or has unknown fields: {error}")
    })?;
    if spec_value.get("admission_mode") != Some(&Value::String("receipt_v1".to_owned())) {
        return Err(
            "agent-run migration-required: replay_v0/no-admission specs are source-free readers and cannot launch Pi; issue a fresh receipt_v1 V5 assignment"
                .to_owned(),
        );
    }
    {
        let fresh: AgentRunSpecV5 = serde_json::from_value(spec_value).map_err(|error| {
            format!(
                "agent-run receipt_v1 spec is malformed, incomplete, or has unknown fields: {error}"
            )
        })?;
        let facade = super::project_v5_spec_for_shared_admission(&fresh);
        let control = super::v5_child_control_launch_config(&fresh)
            .map_err(|error| format!("agent-run V5 child-control authority drift: {error}"))?;
        validate_receipt_v1_spec(&facade, &spec_path)?;
        let checkpoint_store = validate_v5_checkpoint_startup(&fresh)?;
        let prompt_path = PathBuf::from(&facade.prompt_path.0);
        let prompt = read_bounded_utf8(
            &prompt_path,
            MAX_RENDERED_PROMPT_BYTES,
            "agent-run V5 prompt read",
        )?;
        let digest = sha256_hex(prompt.as_bytes());
        if digest != facade.prompt_digest.0 {
            return Err(format!(
                "agent-run V5 prompt digest mismatch: expected {}, got {digest}",
                facade.prompt_digest.0
            ));
        }
        let mut runner = RpcAssignment::spawn_and_configure_v5(&facade, control.clone())?;
        let result =
            run_v5_child_control_session(&mut runner, &facade, &fresh, &checkpoint_store, &prompt);
        match result {
            Ok(V5AcceptedTerminal::Submit) => runner.shutdown_v5(),
            Ok(V5AcceptedTerminal::Blocked {
                receipt_id,
                current_tool_call_id,
            }) => match observe_blocked_result(&control, receipt_id, current_tool_call_id) {
                Ok(()) => runner.shutdown_v5(),
                Err(error) => {
                    let _ = runner.shutdown_v5();
                    Err(error)
                }
            },
            Err(error) => {
                let _ = runner.shutdown_v5();
                Err(error)
            }
        }?;
        return Ok(());
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
enum V5AcceptedTerminal {
    Submit,
    Blocked {
        receipt_id: String,
        current_tool_call_id: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
enum V5AcceptedControl {
    Terminal(V5AcceptedTerminal),
    Checkpoint {
        receipt: CheckpointReceipt,
        handoff: AgentHandoff,
    },
}

#[derive(Debug, Clone)]
struct V5SuccessfulTool {
    tool_call_id: String,
    tool_name: String,
    details: Value,
    accepted: V5AcceptedControl,
    message_correlated: bool,
}

#[derive(Debug, Clone)]
struct V5ToolResultMessage {
    tool_name: String,
    details: Option<Value>,
    is_error: bool,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum V5SteerKind {
    SoftWarning,
    Checkpoint,
}

struct V5CycleState {
    prompt_id: String,
    prompt_response_seen: bool,
    agent_end_seen: bool,
    successful: Option<V5SuccessfulTool>,
    tool_result_ids: BTreeSet<String>,
    tool_result_messages: BTreeMap<String, V5ToolResultMessage>,
    pending_stats: BTreeMap<String, u64>,
    pending_steers: BTreeMap<String, V5SteerKind>,
}

#[derive(Debug, Clone, PartialEq)]
struct V5Checkpoint {
    observed_context: ContextPercent,
    resume_overlay: ResumeOverlay,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct V5CheckpointRef {
    path: String,
    digest: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct V5CheckpointStore {
    run_root: PathBuf,
    directory: PathBuf,
}

impl V5CycleState {
    fn new(prompt_id: String) -> Self {
        Self {
            prompt_id,
            prompt_response_seen: false,
            agent_end_seen: false,
            successful: None,
            tool_result_ids: BTreeSet::new(),
            tool_result_messages: BTreeMap::new(),
            pending_stats: BTreeMap::new(),
            pending_steers: BTreeMap::new(),
        }
    }

    fn has_pending_control(&self) -> bool {
        !self.pending_stats.is_empty() || !self.pending_steers.is_empty()
    }
}

/// Fresh V5 has one live Pi process and one Pi session. Core RETRY remains an
/// ordinary in-turn tool error. At observed context boundaries, only the
/// package policy may warn, request a typed checkpoint, manually compact after
/// settlement, and inject the checkpoint-derived resume overlay. There is no
/// attempt counter, deadline, replacement agent, or context-free replay.
fn run_v5_child_control_session(
    runner: &mut RpcAssignment,
    facade: &AgentRunSpec,
    fresh: &AgentRunSpecV5,
    checkpoint_store: &V5CheckpointStore,
    prompt: &str,
) -> Result<V5AcceptedTerminal, String> {
    let mut warning_sent = false;
    let mut warning_required: Option<ContextPercent> = None;
    let mut checkpoint_request: Option<ContextPercent> = None;
    let mut checkpoint_instruction_dispatched = false;
    let mut latest_budget: Option<(u64, ContextBudget)> = None;
    let mut stats_sequence = 0_u64;
    let mut terminal_accept_drain = false;
    let mut cycle = V5CycleState::new(runner.send_v5_prompt(prompt)?);

    loop {
        let frame = runner
            .client
            .next_frame()
            .map_err(|error| format!("agent-run V5 rpc stream failed: {error}"))?
            .ok_or_else(|| "agent-run V5 rpc stream ended before agent_settled".to_owned())?;
        if terminal_accept_drain {
            // A generated, current-call-correlated terminal ACCEPT locks the outcome.
            // Pi may still emit already-queued turns/tools before agent_settled; drain
            // them without letting model output overturn accepted Core authority. The
            // normal settlement path still drains outstanding telemetry responses.
            if !matches!(&frame, RpcFrame::Event(RpcEvent::AgentSettled)) {
                continue;
            }
            terminal_accept_drain = false;
        }
        match frame {
            RpcFrame::Response(response) => runner.handle_v5_runtime_response(
                facade,
                &mut cycle,
                response,
                &mut latest_budget,
                &mut warning_sent,
                &mut warning_required,
                &mut checkpoint_request,
                &mut checkpoint_instruction_dispatched,
                false,
            )?,
            RpcFrame::Event(RpcEvent::AgentStart) => {
                let retry_start = cycle.agent_end_seen;
                cycle.agent_end_seen = false;
                if checkpoint_request.is_some()
                    && (retry_start || !checkpoint_instruction_dispatched)
                {
                    let checkpoint_prompt = runner.checkpoint_prompt(facade)?;
                    runner.send_v5_steer(&mut cycle, V5SteerKind::Checkpoint, checkpoint_prompt)?;
                    checkpoint_instruction_dispatched = true;
                } else if let Some(percent) = warning_required
                    && !warning_sent
                {
                    let warning = runner.warning_prompt(facade, percent);
                    runner.send_v5_steer(&mut cycle, V5SteerKind::SoftWarning, warning)?;
                    warning_required = None;
                    warning_sent = true;
                }
            }
            RpcFrame::Event(RpcEvent::AgentEnd { .. }) => cycle.agent_end_seen = true,
            RpcFrame::Event(RpcEvent::ToolExecutionStart) => {}
            RpcFrame::Event(RpcEvent::ToolExecutionEnd {
                tool_call_id,
                tool_name,
                details,
                is_error,
                terminate,
            }) => {
                let kind = v5_child_control_tool_kind(facade, &tool_name)?;
                if kind.is_none() && terminate {
                    return Err(format!(
                        "agent-run V5 non-control tool {tool_name} attempted terminating authority"
                    ));
                }
                if cycle.successful.is_some() && kind.is_none() {
                    return Err(format!(
                        "agent-run V5 ordinary tool {tool_name} completed after a pending ACCEPT"
                    ));
                }
                if let Some(kind) = kind {
                    // A parallel RETRY may finish after a pending ACCEPT, but
                    // every later successful or malformed control candidate is
                    // a multiple-terminal protocol violation.
                    if cycle.successful.is_some() {
                        if !(is_error && !terminate) {
                            return Err(format!(
                                "agent-run V5 received multiple terminal candidates; later tool {tool_name} has isError={is_error} terminate={terminate}"
                            ));
                        }
                    } else if is_error && !terminate {
                        // Core RETRY is model-visible and stays in this session.
                    } else {
                        if is_error || !terminate {
                            return Err(format!(
                                "agent-run V5 child-control tool {tool_name} has invalid isError={is_error} terminate={terminate} outcome"
                            ));
                        }
                        if kind == V5ChildControlTool::Checkpoint
                            && (checkpoint_request.is_none() || !checkpoint_instruction_dispatched)
                        {
                            return Err(
                                "agent-run V5 checkpoint ACCEPT before a parent-observed checkpoint request or its dispatched instruction"
                                    .to_owned(),
                            );
                        }
                        let details = details.ok_or_else(|| {
                            format!(
                                "agent-run V5 child-control tool {tool_name} returned no receipt details"
                            )
                        })?;
                        let receipt: ChildControlAcceptReceipt =
                            serde_json::from_value(details.clone()).map_err(|error| {
                                format!(
                                    "agent-run V5 child-control tool {tool_name} details are not a generated ACCEPT receipt: {error}"
                                )
                            })?;
                        let accepted = verify_v5_accept_receipt(
                            runner,
                            facade,
                            fresh,
                            kind,
                            &tool_call_id,
                            &receipt,
                        )?;
                        let message_correlated =
                            if let Some(message) = cycle.tool_result_messages.get(&tool_call_id) {
                                correlate_v5_tool_result_message(
                                    &tool_call_id,
                                    &tool_name,
                                    &details,
                                    message,
                                )?;
                                true
                            } else {
                                false
                            };
                        cycle.successful = Some(V5SuccessfulTool {
                            tool_call_id,
                            tool_name,
                            details,
                            accepted,
                            message_correlated,
                        });
                    }
                }
                terminal_accept_drain = cycle.successful.as_ref().is_some_and(|accepted| {
                    accepted.message_correlated
                        && matches!(accepted.accepted, V5AcceptedControl::Terminal(_))
                });
                if cycle.successful.is_none() {
                    runner.request_v5_stats(&mut cycle, &mut stats_sequence)?;
                }
            }
            RpcFrame::Event(RpcEvent::MessageEnd { message }) if message.role == "toolResult" => {
                let tool_call_id = message
                    .tool_call_id
                    .ok_or_else(|| "agent-run V5 toolResult missing toolCallId".to_owned())?;
                let tool_name = message
                    .tool_name
                    .ok_or_else(|| "agent-run V5 toolResult missing toolName".to_owned())?;
                let is_error = message
                    .is_error
                    .ok_or_else(|| "agent-run V5 toolResult missing isError".to_owned())?;
                if !cycle.tool_result_ids.insert(tool_call_id.clone()) {
                    return Err(format!(
                        "agent-run V5 received duplicate toolResult for {tool_call_id}"
                    ));
                }
                if let Some(accepted) = cycle.successful.as_ref()
                    && accepted.tool_call_id != tool_call_id
                    && !(is_error && v5_child_control_tool_kind(facade, &tool_name)?.is_some())
                {
                    return Err(format!(
                        "agent-run V5 unrelated toolResult {tool_name}/{tool_call_id} followed a pending ACCEPT"
                    ));
                }
                let result_message = V5ToolResultMessage {
                    tool_name,
                    details: message.details,
                    is_error,
                };
                if cycle
                    .tool_result_messages
                    .insert(tool_call_id.clone(), result_message.clone())
                    .is_some()
                {
                    return Err(format!(
                        "agent-run V5 received duplicate toolResult message for {tool_call_id}"
                    ));
                }
                if let Some(accepted) = cycle
                    .successful
                    .as_mut()
                    .filter(|item| item.tool_call_id == tool_call_id)
                {
                    correlate_v5_tool_result_message(
                        &tool_call_id,
                        &accepted.tool_name,
                        &accepted.details,
                        &result_message,
                    )?;
                    accepted.message_correlated = true;
                    terminal_accept_drain =
                        matches!(accepted.accepted, V5AcceptedControl::Terminal(_));
                }
            }
            RpcFrame::Event(RpcEvent::MessageEnd { .. }) => {
                if cycle.successful.is_some() {
                    return Err(
                        "agent-run V5 non-toolResult message followed a pending checkpoint ACCEPT"
                            .to_owned(),
                    );
                }
                runner.request_v5_stats(&mut cycle, &mut stats_sequence)?;
            }
            RpcFrame::Event(RpcEvent::TurnEnd) => {
                if cycle.successful.is_none() {
                    runner.request_v5_stats(&mut cycle, &mut stats_sequence)?;
                }
            }
            RpcFrame::Event(RpcEvent::AgentSettled) => {
                if !cycle.prompt_response_seen {
                    return Err(
                        "agent-run V5 prompt response missing before agent_settled".to_owned()
                    );
                }
                if cycle.successful.is_none() {
                    runner.request_v5_stats(&mut cycle, &mut stats_sequence)?;
                }
                while cycle.has_pending_control() {
                    let pending = runner
                        .client
                        .next_frame()
                        .map_err(|error| {
                            format!("agent-run V5 rpc stream failed after settlement: {error}")
                        })?
                        .ok_or_else(|| {
                            "agent-run V5 rpc stream ended before boundary telemetry completed"
                                .to_owned()
                        })?;
                    match pending {
                        RpcFrame::Response(response) => runner.handle_v5_runtime_response(
                            facade,
                            &mut cycle,
                            response,
                            &mut latest_budget,
                            &mut warning_sent,
                            &mut warning_required,
                            &mut checkpoint_request,
                            &mut checkpoint_instruction_dispatched,
                            true,
                        )?,
                        RpcFrame::Event(event) => {
                            return Err(format!(
                                "agent-run V5 rpc event after agent_settled while awaiting control responses: {event:?}"
                            ));
                        }
                    }
                }

                if let Some(accepted) = cycle.successful.take() {
                    if !accepted.message_correlated {
                        return Err(format!(
                            "agent-run V5 terminating tool missing correlated toolResult details for {}",
                            accepted.tool_call_id
                        ));
                    }
                    match accepted.accepted {
                        V5AcceptedControl::Terminal(terminal) => return Ok(terminal),
                        V5AcceptedControl::Checkpoint { receipt, handoff } => {
                            let observed = checkpoint_request.ok_or_else(|| {
                                "agent-run V5 received checkpoint ACCEPT before a parent-observed checkpoint request".to_owned()
                            })?;
                            if !checkpoint_instruction_dispatched {
                                return Err(
                                    "agent-run V5 checkpoint ACCEPT lacked a dispatched checkpoint instruction"
                                        .to_owned(),
                                );
                            }
                            runner.verify_settled_queue_state(facade)?;
                            let checkpoint = runner.checkpoint_record(facade, observed, handoff)?;
                            let checkpoint_ref =
                                persist_v5_checkpoint(checkpoint_store, fresh, &receipt)?;
                            runner.manual_compact(&checkpoint)?;
                            runner.verify_post_compact_state(facade)?;
                            let resume = runner.resume_prompt(
                                facade,
                                &checkpoint,
                                &checkpoint_ref,
                                &receipt,
                            )?;
                            warning_sent = false;
                            warning_required = None;
                            checkpoint_request = None;
                            checkpoint_instruction_dispatched = false;
                            latest_budget = None;
                            cycle = V5CycleState::new(runner.send_v5_prompt(&resume)?);
                            continue;
                        }
                    }
                }

                let next_prompt = if checkpoint_request.is_some() {
                    checkpoint_instruction_dispatched = true;
                    runner.checkpoint_prompt(facade)?
                } else {
                    match latest_budget.map(|(_, budget)| budget) {
                        Some(ContextBudget::Known(percent)) => {
                            let continuation = runner.continuation_prompt(facade, percent)?;
                            if let Some(warning_percent) = warning_required
                                && !warning_sent
                            {
                                warning_sent = true;
                                warning_required = None;
                                format!(
                                    "{}\n\n{continuation}",
                                    runner.warning_prompt(facade, warning_percent)
                                )
                            } else {
                                continuation
                            }
                        }
                        Some(ContextBudget::Unknown) | None => {
                            return Err(
                                "agent-run V5 context usage is unknown at a clean no-ACCEPT settlement; refusing context-free continuation"
                                    .to_owned(),
                            );
                        }
                    }
                };
                runner.verify_settled_queue_state(facade)?;
                cycle = V5CycleState::new(runner.send_v5_prompt(&next_prompt)?);
            }
            RpcFrame::Event(RpcEvent::CompactionStart { reason }) => {
                return Err(format!(
                    "agent-run V5 Pi attempted automatic compaction: {reason:?}"
                ));
            }
            RpcFrame::Event(_) => {}
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum V5ChildControlTool {
    Submit,
    Checkpoint,
    Blocked,
}

fn v5_child_control_tool_kind(
    facade: &AgentRunSpec,
    tool_name: &str,
) -> Result<Option<V5ChildControlTool>, String> {
    let submit = super::terminal_profile_for(
        &facade.role_id.0,
        &facade.boundary_id.0,
        &facade.result_contract.0,
    )
    .map_err(|error| error.to_string())?;
    if tool_name == submit.1 {
        return Ok(Some(V5ChildControlTool::Submit));
    }
    let checkpoint = v5_universal_tool(V5_CHECKPOINT_PROFILE_ID, V5_CHECKPOINT_TOOL_NAME)?;
    if tool_name == checkpoint.1 {
        return Ok(Some(V5ChildControlTool::Checkpoint));
    }
    let blocked = v5_universal_tool(
        "autopilot.blocked_report.v1:autopilot_report_blocked",
        "autopilot_report_blocked",
    )?;
    if tool_name == blocked.1 {
        return Ok(Some(V5ChildControlTool::Blocked));
    }
    if kernel::generated::TERMINAL_PROFILES
        .iter()
        .any(|profile| profile.1 == tool_name)
        || kernel::generated::UNIVERSAL_CHILD_TOOLS
            .iter()
            .any(|profile| profile.1 == tool_name)
    {
        return Err(format!(
            "agent-run V5 received an unexpected terminal tool {tool_name}"
        ));
    }
    Ok(None)
}

fn v5_universal_tool(
    profile_id: &str,
    tool_name: &str,
) -> Result<
    &'static (
        &'static str,
        &'static str,
        &'static str,
        &'static str,
        &'static str,
        &'static str,
    ),
    String,
> {
    kernel::generated::UNIVERSAL_CHILD_TOOLS
        .iter()
        .find(|row| row.0 == profile_id && row.1 == tool_name)
        .ok_or_else(|| {
            format!("agent-run V5 lacks generated universal tool metadata for {profile_id}")
        })
}

fn verify_v5_accept_receipt(
    runner: &RpcAssignment,
    facade: &AgentRunSpec,
    fresh: &AgentRunSpecV5,
    kind: V5ChildControlTool,
    tool_call_id: &str,
    receipt: &ChildControlAcceptReceipt,
) -> Result<V5AcceptedControl, String> {
    let attempt = fresh
        .attempt
        .filter(|attempt| *attempt != 0)
        .ok_or_else(|| "agent-run V5 receipt lacks explicit nonzero attempt".to_owned())?;
    match (kind, receipt) {
        (V5ChildControlTool::Submit, ChildControlAcceptReceipt::Submit { schema, receipt }) => {
            let profile = super::terminal_profile_for(
                &facade.role_id.0,
                &facade.boundary_id.0,
                &facade.result_contract.0,
            )
            .map_err(|error| error.to_string())?;
            if schema.0 != "autopilot.child_control_accept_receipt.v1"
                || receipt.schema.0 != "autopilot.submit_receipt.v1"
                || receipt.run_id != fresh.run_id
                || receipt.run_revision != facade.run_revision
                || receipt.workstream != facade.workstream
                || receipt.action_id != facade.action_id
                || receipt.assignment_id != fresh.assignment_id
                || receipt.attempt != attempt
                || receipt.profile_id != profile.0
                || receipt.tool_name.0 != profile.1
                || receipt.tool_call_id.is_empty()
                || receipt.boundary_id != facade.boundary_id
                || receipt.result_contract != facade.result_contract
                || receipt.schema_digest.0 != profile.4
                || receipt.carrier_binding_digest.0 != carrier_binding(facade)
                || receipt.receipt_id.0.is_empty()
                || receipt.request_id.0.is_empty()
            {
                return Err("agent-run V5 submit receipt identity drift".to_owned());
            }
            Ok(V5AcceptedControl::Terminal(V5AcceptedTerminal::Submit))
        }
        (
            V5ChildControlTool::Checkpoint,
            ChildControlAcceptReceipt::Checkpoint { schema, receipt },
        ) => {
            let checkpoint = v5_universal_tool(V5_CHECKPOINT_PROFILE_ID, V5_CHECKPOINT_TOOL_NAME)?;
            let canonical_handoff =
                crate::evidence::canonical_json(&receipt.handoff).map_err(|error| {
                    format!("agent-run V5 checkpoint handoff canonicalization failed: {error}")
                })?;
            let handoff: AgentHandoff = serde_json::from_value(receipt.handoff.clone())
                .map_err(|error| format!("agent-run V5 checkpoint handoff malformed: {error}"))?;
            let handoff = runner
                .policy
                .validate_handoff(&facade.role_id.0, handoff)
                .map_err(|error| format!("agent-run V5 checkpoint handoff rejected: {error}"))?;
            if schema.0 != "autopilot.child_control_accept_receipt.v1"
                || receipt.schema.0 != "autopilot.checkpoint_receipt.v1"
                || receipt.run_id != fresh.run_id
                || receipt.run_revision != facade.run_revision
                || receipt.assignment_id != fresh.assignment_id
                || receipt.attempt != attempt
                || receipt.role_id != facade.role_id
                || receipt.mode != facade.mode
                || receipt.session_id != facade.session_id
                || receipt.profile_id != checkpoint.0
                || receipt.tool_name.0 != checkpoint.1
                || receipt.tool_call_id != tool_call_id
                || !is_uuid_v7(&receipt.receipt_id.0)
                || receipt.handoff_digest.0 != sha256_hex(&canonical_handoff)
            {
                return Err("agent-run V5 checkpoint receipt identity drift".to_owned());
            }
            Ok(V5AcceptedControl::Checkpoint {
                receipt: receipt.clone(),
                handoff,
            })
        }
        (V5ChildControlTool::Blocked, ChildControlAcceptReceipt::Blocked { schema, receipt }) => {
            let blocked = v5_universal_tool(
                "autopilot.blocked_report.v1:autopilot_report_blocked",
                "autopilot_report_blocked",
            )?;
            if schema.0 != "autopilot.child_control_accept_receipt.v1"
                || receipt.schema.0 != "autopilot.blocked_receipt.v1"
                || receipt.run_id != fresh.run_id
                || receipt.run_revision != facade.run_revision
                || receipt.workstream != facade.workstream
                || receipt.action_id != facade.action_id
                || receipt.assignment_id != fresh.assignment_id
                || receipt.attempt != attempt
                || receipt.profile_id != blocked.0
                || receipt.tool_name.0 != blocked.1
                || receipt.tool_call_id.is_empty()
                || receipt.receipt_id.0.is_empty()
                || receipt.request_id.0.is_empty()
            {
                return Err("agent-run V5 blocked receipt identity drift".to_owned());
            }
            Ok(V5AcceptedControl::Terminal(V5AcceptedTerminal::Blocked {
                receipt_id: receipt.receipt_id.0.clone(),
                current_tool_call_id: tool_call_id.to_owned(),
            }))
        }
        _ => Err("agent-run V5 child-control receipt/tool kind drift".to_owned()),
    }
}

fn correlate_v5_tool_result_message(
    tool_call_id: &str,
    tool_name: &str,
    details: &Value,
    message: &V5ToolResultMessage,
) -> Result<(), String> {
    if message.tool_name != tool_name || message.is_error {
        return Err(format!(
            "agent-run V5 toolResult identity/error drift for {tool_call_id}: expected {tool_name}/isError=false, got {}/isError={}",
            message.tool_name, message.is_error
        ));
    }
    let message_details = message.details.as_ref().ok_or_else(|| {
        format!("agent-run V5 terminating toolResult missing details for {tool_call_id}")
    })?;
    if canonical_detail_bytes(details)? != canonical_detail_bytes(message_details)? {
        return Err(format!(
            "agent-run V5 tool details drift between tool_execution_end and toolResult for {tool_call_id}"
        ));
    }
    Ok(())
}

fn canonical_detail_bytes(value: &Value) -> Result<Vec<u8>, String> {
    crate::evidence::canonical_json(value)
        .map_err(|error| format!("agent-run V5 receipt canonicalization failed: {error}"))
}

fn validate_v5_compaction_response(response: &RpcResponse) -> Result<(), String> {
    let data = response
        .data
        .as_ref()
        .ok_or_else(|| "agent-run V5 manual compaction response missing data".to_owned())?;
    let value: Value = serde_json::from_str(data)
        .map_err(|error| format!("agent-run V5 manual compaction response malformed: {error}"))?;
    let summary = value
        .get("summary")
        .and_then(Value::as_str)
        .ok_or_else(|| "agent-run V5 manual compaction response missing summary".to_owned())?;
    let first_kept = value
        .get("firstKeptEntryId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "agent-run V5 manual compaction response missing firstKeptEntryId".to_owned()
        })?;
    let tokens_before = value
        .get("tokensBefore")
        .and_then(Value::as_u64)
        .ok_or_else(|| "agent-run V5 manual compaction response missing tokensBefore".to_owned())?;
    let estimated_after = value
        .get("estimatedTokensAfter")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            "agent-run V5 manual compaction response missing estimatedTokensAfter".to_owned()
        })?;
    if summary.trim().is_empty()
        || first_kept.trim().is_empty()
        || tokens_before == 0
        || estimated_after >= tokens_before
    {
        return Err(
            "agent-run V5 manual compaction response did not prove context reduction".to_owned(),
        );
    }
    Ok(())
}

fn v5_state_value(response: &RpcResponse) -> Result<Value, String> {
    let data = response
        .data
        .as_ref()
        .ok_or_else(|| "agent-run V5 get_state missing data".to_owned())?;
    serde_json::from_str(data)
        .map_err(|error| format!("agent-run V5 get_state malformed data: {error}"))
}

fn context_budget_from_stats(
    response: &RpcResponse,
    expected_session: &str,
) -> Result<ContextBudget, String> {
    let data = response
        .data
        .as_ref()
        .ok_or_else(|| "agent-run V5 get_session_stats missing data".to_owned())?;
    let value: Value = serde_json::from_str(data)
        .map_err(|error| format!("agent-run V5 get_session_stats malformed data: {error}"))?;
    let session = value
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "agent-run V5 get_session_stats missing sessionId".to_owned())?;
    if session != expected_session {
        return Err(format!(
            "agent-run V5 session continuity lost in context telemetry: expected {expected_session}, got {session}"
        ));
    }
    let Some(context) = value.get("contextUsage") else {
        return Ok(ContextBudget::Unknown);
    };
    if context.is_null() {
        return Ok(ContextBudget::Unknown);
    }
    let context = context
        .as_object()
        .ok_or_else(|| "agent-run V5 contextUsage has wrong type".to_owned())?;
    match context.get("percent") {
        Some(Value::Null) | None => Ok(ContextBudget::Unknown),
        Some(Value::Number(number)) => ContextBudget::known(
            number
                .as_f64()
                .ok_or_else(|| "agent-run V5 context percent was not finite f64".to_owned())?,
        )
        .map_err(|error| format!("agent-run V5 context percent invalid: {error:?}")),
        _ => Err("agent-run V5 context percent has wrong type".to_owned()),
    }
}

fn validate_v5_checkpoint_startup(spec: &AgentRunSpecV5) -> Result<V5CheckpointStore, String> {
    let session_path = Path::new(&spec.session_dir.0);
    validate_v5_session_path(session_path)?;
    let session_parent = session_path
        .parent()
        .ok_or_else(|| "agent-run V5 checkpoint session directory has no run root".to_owned())?;
    super::reject_link_components_for_path(session_parent).map_err(|error| error.to_string())?;
    let run_root = fs::canonicalize(session_parent).map_err(|error| {
        format!(
            "agent-run V5 checkpoint run root unavailable at {}: {error}",
            session_parent.display()
        )
    })?;
    let directory = run_root.join("checkpoints");
    let store = V5CheckpointStore {
        run_root,
        directory: directory.clone(),
    };
    ensure_v5_checkpoint_root(&store)?;
    if !v5_checkpoint_root_contains_assignment_authority(&directory, spec)? {
        return Ok(store);
    }
    let continuity = match &spec.session_continuity {
        SessionContinuity::Fresh => "fresh",
        SessionContinuity::Resume => "resume",
    };
    Err(format!(
        "agent-run V5 {continuity} startup found prior checkpoint authority for this assignment; refusing original-prompt replay and requiring an explicit checkpoint-derived recovery path"
    ))
}

fn ensure_v5_checkpoint_root(store: &V5CheckpointStore) -> Result<(), String> {
    let directory = &store.directory;
    super::reject_link_components_for_path(directory).map_err(|error| error.to_string())?;
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => {
            return Err(format!(
                "agent-run V5 checkpoint root is not a directory: {}",
                directory.display()
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            builder.mode(0o700);
            match builder.create(directory) {
                Ok(()) => {}
                Err(create_error) if create_error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(create_error) => {
                    return Err(format!(
                        "agent-run V5 checkpoint root create failed {}: {create_error}",
                        directory.display()
                    ));
                }
            }
        }
        Err(error) => {
            return Err(format!(
                "agent-run V5 checkpoint root metadata failed {}: {error}",
                directory.display()
            ));
        }
    }
    super::reject_link_components_for_path(directory).map_err(|error| error.to_string())?;
    let metadata = fs::symlink_metadata(directory).map_err(|error| {
        format!(
            "agent-run V5 checkpoint root verification failed {}: {error}",
            directory.display()
        )
    })?;
    if !metadata.file_type().is_dir() {
        return Err(format!(
            "agent-run V5 checkpoint root is not a directory: {}",
            directory.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!(
                "agent-run V5 checkpoint root private mode failed {}: {error}",
                directory.display()
            )
        })?;
    }
    fs::File::open(&store.run_root)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            format!(
                "agent-run V5 checkpoint run-root fsync failed {}: {error}",
                store.run_root.display()
            )
        })
}

fn validate_v5_session_path(session_path: &Path) -> Result<(), String> {
    super::reject_link_components_for_path(session_path).map_err(|error| error.to_string())?;
    match fs::symlink_metadata(session_path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(format!(
            "agent-run V5 session path is not a directory: {}",
            session_path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = session_path
                .parent()
                .ok_or_else(|| "agent-run V5 session path has no parent".to_owned())?;
            super::reject_link_components_for_path(parent).map_err(|error| error.to_string())?;
            let metadata = fs::symlink_metadata(parent).map_err(|parent_error| {
                format!(
                    "agent-run V5 session parent unavailable at {}: {parent_error}",
                    parent.display()
                )
            })?;
            if metadata.file_type().is_dir() {
                Ok(())
            } else {
                Err(format!(
                    "agent-run V5 session parent is not a directory: {}",
                    parent.display()
                ))
            }
        }
        Err(error) => Err(format!(
            "agent-run V5 session path metadata failed {}: {error}",
            session_path.display()
        )),
    }
}

fn v5_checkpoint_assignment_scope_digest(spec: &AgentRunSpecV5) -> String {
    sha256_hex(format!("{}\0{}", spec.run_id.0, spec.assignment_id.0).as_bytes())
}

fn v5_checkpoint_pending_scope(file_name: &str) -> Option<&str> {
    let value = file_name.strip_prefix(".pending-")?.strip_suffix(".json")?;
    let (scope, receipt_id) = value.split_once('-')?;
    (scope.len() == 64
        && scope
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        && is_uuid_v7(receipt_id))
    .then_some(scope)
}

fn v5_checkpoint_root_contains_assignment_authority(
    directory: &Path,
    spec: &AgentRunSpecV5,
) -> Result<bool, String> {
    'rescan: loop {
        let entries = fs::read_dir(directory).map_err(|error| {
            format!(
                "agent-run V5 checkpoint root read failed {}: {error}",
                directory.display()
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!(
                    "agent-run V5 checkpoint root entry failed {}: {error}",
                    directory.display()
                )
            })?;
            let path = entry.path();
            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| {
                    format!(
                        "agent-run V5 checkpoint root contains a non-UTF-8 entry: {}",
                        path.display()
                    )
                })?;
            let pending_scope = v5_checkpoint_pending_scope(file_name);
            super::reject_link_components_for_path(&path).map_err(|error| error.to_string())?;
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound && pending_scope.is_some() =>
                {
                    continue 'rescan;
                }
                Err(error) => {
                    return Err(format!(
                        "agent-run V5 checkpoint entry metadata failed {}: {error}",
                        path.display()
                    ));
                }
            };
            if !metadata.file_type().is_file() {
                return Err(format!(
                    "agent-run V5 checkpoint root contains a non-file entry: {}",
                    path.display()
                ));
            }
            if let Some(scope) = pending_scope {
                if scope == v5_checkpoint_assignment_scope_digest(spec) {
                    return Ok(true);
                }
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                return Err(format!(
                    "agent-run V5 checkpoint root contains an invalid entry: {}",
                    path.display()
                ));
            }
            let bytes = super::read_bounded_file(&path, 128 * 1024).map_err(|error| {
                format!(
                    "agent-run V5 checkpoint authority read failed {}: {error}",
                    path.display()
                )
            })?;
            let receipt: CheckpointReceipt = serde_json::from_slice(&bytes).map_err(|error| {
                format!(
                    "agent-run V5 checkpoint authority malformed {}: {error}",
                    path.display()
                )
            })?;
            let canonical = crate::evidence::canonical_json(&receipt).map_err(|error| {
                format!(
                    "agent-run V5 checkpoint authority canonicalization failed {}: {error}",
                    path.display()
                )
            })?;
            let expected_name = format!("{}.json", receipt.receipt_id.0);
            let canonical_handoff =
                crate::evidence::canonical_json(&receipt.handoff).map_err(|error| {
                    format!(
                        "agent-run V5 checkpoint handoff canonicalization failed {}: {error}",
                        path.display()
                    )
                })?;
            if bytes != canonical
                || file_name != expected_name
                || receipt.schema.0 != "autopilot.checkpoint_receipt.v1"
                || !is_uuid_v7(&receipt.receipt_id.0)
                || receipt.run_id != spec.run_id
                || receipt.attempt == 0
                || receipt.handoff_digest.0 != sha256_hex(&canonical_handoff)
            {
                return Err(format!(
                    "agent-run V5 checkpoint authority identity drift: {}",
                    path.display()
                ));
            }
            if receipt.assignment_id == spec.assignment_id || receipt.session_id == spec.session_id
            {
                return Ok(true);
            }
        }
        return Ok(false);
    }
}

fn persist_v5_checkpoint(
    store: &V5CheckpointStore,
    spec: &AgentRunSpecV5,
    receipt: &CheckpointReceipt,
) -> Result<V5CheckpointRef, String> {
    if !is_uuid_v7(&receipt.receipt_id.0) {
        return Err("agent-run V5 checkpoint persistence requires a UUIDv7 receipt".to_owned());
    }
    let bytes = crate::evidence::canonical_json(receipt)
        .map_err(|error| format!("agent-run V5 checkpoint canonicalization failed: {error}"))?;
    let digest = sha256_hex(&bytes);
    let directory = &store.directory;
    super::reject_link_components_for_path(directory).map_err(|error| error.to_string())?;
    let metadata = fs::symlink_metadata(directory).map_err(|error| {
        format!(
            "agent-run V5 checkpoint root disappeared after durable startup {}: {error}",
            directory.display()
        )
    })?;
    if !metadata.file_type().is_dir() {
        return Err(format!(
            "agent-run V5 checkpoint root changed after durable startup: {}",
            directory.display()
        ));
    }
    let path = directory.join(format!("{}.json", receipt.receipt_id.0));
    let pending_path = directory.join(format!(
        ".pending-{}-{}.json",
        v5_checkpoint_assignment_scope_digest(spec),
        receipt.receipt_id.0
    ));
    super::reject_link_components_for_path(&path).map_err(|error| error.to_string())?;
    super::reject_link_components_for_path(&pending_path).map_err(|error| error.to_string())?;
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(format!(
                "agent-run V5 checkpoint final path already exists: {}",
                path.display()
            ));
        }
        Err(error) => {
            return Err(format!(
                "agent-run V5 checkpoint final metadata failed {}: {error}",
                path.display()
            ));
        }
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&pending_path).map_err(|error| {
        format!(
            "agent-run V5 checkpoint pending create failed {}: {error}",
            pending_path.display()
        )
    })?;
    fs::File::open(&directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            format!(
                "agent-run V5 checkpoint pending-entry fsync failed {}: {error}",
                directory.display()
            )
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| {
                format!(
                    "agent-run V5 checkpoint private mode failed {}: {error}",
                    pending_path.display()
                )
            })?;
    }
    file.write_all(&bytes).map_err(|error| {
        format!(
            "agent-run V5 checkpoint pending write failed {}: {error}",
            pending_path.display()
        )
    })?;
    file.sync_all().map_err(|error| {
        format!(
            "agent-run V5 checkpoint pending fsync failed {}: {error}",
            pending_path.display()
        )
    })?;
    drop(file);
    fs::rename(&pending_path, &path).map_err(|error| {
        format!(
            "agent-run V5 checkpoint atomic publish failed {} -> {}: {error}",
            pending_path.display(),
            path.display()
        )
    })?;
    fs::File::open(&directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            format!(
                "agent-run V5 checkpoint publication fsync failed {}: {error}",
                directory.display()
            )
        })?;
    let reread = super::read_bounded_file(&path, 128 * 1024)
        .map_err(|error| format!("agent-run V5 checkpoint verification read failed: {error}"))?;
    if reread != bytes {
        return Err("agent-run V5 checkpoint verification byte drift".to_owned());
    }
    Ok(V5CheckpointRef {
        path: path.display().to_string(),
        digest,
    })
}

fn is_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23]
            .into_iter()
            .all(|index| bytes[index] == b'-')
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index) || byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
        })
}

fn observe_blocked_result(
    control: &ChildControlLaunchConfig,
    receipt_id: String,
    tool_call_id: String,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        let request = serde_json::json!({
            "schema": "autopilot.blocked_result_observed.v1",
            "token": control.token,
            "run_id": control.run_id,
            "assignment_id": control.assignment_id,
            "attempt": control.attempt.get(),
            "receipt_id": receipt_id,
            "tool_call_id": tool_call_id,
        });
        let bytes = serde_json::to_vec(&request)
            .map_err(|error| format!("agent-run blocked observation serialize failed: {error}"))?;
        let limit = crate::generated::pi_rpc::DEFAULT_MAX_TERMINAL_BYTES;
        if bytes.is_empty() || bytes.len() > limit {
            return Err("agent-run blocked observation frame exceeds the hard ceiling".to_owned());
        }
        let mut stream = UnixStream::connect(&control.socket_path).map_err(|error| {
            format!("agent-run blocked observation transport unavailable: {error}")
        })?;
        let length = u32::try_from(bytes.len())
            .map_err(|_| "agent-run blocked observation frame length overflow".to_owned())?;
        stream
            .write_all(&length.to_be_bytes())
            .and_then(|()| stream.write_all(&bytes))
            .and_then(|()| stream.flush())
            .and_then(|()| stream.shutdown(NetShutdown::Write))
            .map_err(|error| format!("agent-run blocked observation write failed: {error}"))?;
        // The generated observation acknowledgment is private Core→Host
        // authority. The reporter observes only peer completion: clean EOF.
        let mut payload = [0_u8; 1];
        match stream.read(&mut payload) {
            Ok(0) => Ok(()),
            Ok(_) => Err(
                "agent-run blocked observation carried child-visible protocol payload".to_owned(),
            ),
            Err(error) => Err(format!(
                "agent-run blocked observation completion read failed: {error}"
            )),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (control, receipt_id, tool_call_id);
        Err("agent-run blocked observation requires AF_UNIX".to_owned())
    }
}

struct RpcAssignment {
    client: RpcClient,
    next_command: u64,
    policy: CheckpointPolicy,
    bootstrap_entry: Option<AppendedEntry>,
}

fn normalize_child_tool_receipt(entry: &Value) -> Result<ChildToolReceipt, String> {
    if entry.get("type").and_then(Value::as_str) != Some("custom") {
        return Err("agent-run child add-on receipt is not a custom entry".to_owned());
    }
    if entry.get("customType").and_then(Value::as_str) != Some("pi-autopilot:child-tools") {
        return Err("agent-run child add-on receipt has the wrong custom type".to_owned());
    }
    let entry_id = entry
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "agent-run child add-on receipt missing entry id".to_owned())?;
    let data = entry
        .get("data")
        .cloned()
        .ok_or_else(|| "agent-run child add-on receipt missing data".to_owned())?;
    normalize_child_tool_receipt_data(entry_id, data)
}

fn validate_delivery_policy_receipt(
    spec: &AgentRunSpec,
    receipt: Option<&ChildDeliveryPolicyReceipt>,
) -> Result<(), String> {
    if !matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Delivery
    ) {
        if receipt.is_some() {
            return Err("agent-run delivery policy receipt on non-delivery profile".to_owned());
        }
        return Ok(());
    }
    let receipt = receipt.ok_or_else(|| "agent-run missing delivery policy receipt".to_owned())?;
    let assignment_path = spec
        .assignment_path
        .as_ref()
        .ok_or_else(|| "agent-run delivery missing assignment_path".to_owned())?;
    let assignment_digest = spec
        .assignment_digest
        .as_ref()
        .ok_or_else(|| "agent-run delivery missing assignment_digest".to_owned())?;
    let worktree = spec
        .worktree
        .as_ref()
        .ok_or_else(|| "agent-run delivery missing worktree".to_owned())?;
    let bytes = super::read_bounded_file(
        Path::new(&assignment_path.0),
        super::DELIVERY_ASSIGNMENT_MAX_BYTES,
    )
    .map_err(|error| format!("agent-run delivery policy assignment read: {error}"))?;
    if sha256_hex(&bytes) != assignment_digest.0 {
        return Err("agent-run delivery policy assignment digest drift".to_owned());
    }
    let common = receipt.assignment_path == assignment_path.0
        && receipt.assignment_digest == assignment_digest.0
        && receipt.worktree == worktree.0
        && receipt.cwd == spec.cwd.0
        && receipt.active_overrides
            == vec![
                super::APPROVED_COMMAND_TOOL.to_owned(),
                "edit".to_owned(),
                "write".to_owned(),
            ];
    match super::read_delivery_assignment_artifact(&bytes)? {
        super::DeliveryAssignmentArtifactReader::V3(artifact) => {
            let count = artifact
                .ordered_units
                .iter()
                .flat_map(|unit| unit.files.iter())
                .collect::<BTreeSet<_>>()
                .len();
            super::validate_approved_command_bindings(&artifact)?;
            if !common
                || receipt.version != super::DELIVERY_POLICY_VERSION
                || receipt.policy_digest
                    != super::delivery_policy_digest(
                        &assignment_path.0,
                        &assignment_digest.0,
                        &worktree.0,
                        &spec.cwd.0,
                    )
                || receipt.allowed_unit_file_count != count
                || receipt.approved_command_count != artifact.approved_commands.len()
                || receipt.mutable_authored_leaf_count.is_some()
                || receipt.protected_core_leaf_count.is_some()
                || receipt.baseline_digest.is_some()
                || count == 0
                || artifact.approved_commands.is_empty()
            {
                return Err("agent-run delivery policy receipt drift".to_owned());
            }
        }
        super::DeliveryAssignmentArtifactReader::V4(artifact) => {
            super::materializer_v4::replay_v4_materialization(&artifact)?;
            let files = artifact
                .ordered_units
                .iter()
                .flat_map(|unit| unit.files.iter().map(|path| path.0.as_str()))
                .collect::<BTreeSet<_>>();
            let protected = artifact
                .materialization
                .baseline
                .iter()
                .map(|leaf| leaf.destination.0.as_str())
                .collect::<BTreeSet<_>>();
            if !protected.is_subset(&files)
                || protected.len() != artifact.materialization.baseline.len()
            {
                return Err("agent-run V4 protected baseline drift".to_owned());
            }
            let mutable = files.len() - protected.len();
            if !common
                || receipt.version != super::DELIVERY_POLICY_V5_VERSION
                || receipt.policy_digest
                    != super::delivery_policy_digest_v5(
                        &assignment_path.0,
                        &assignment_digest.0,
                        &worktree.0,
                        &spec.cwd.0,
                    )
                || receipt.allowed_unit_file_count != files.len()
                || receipt.approved_command_count != artifact.approved_commands.len()
                || receipt.mutable_authored_leaf_count != Some(mutable)
                || receipt.protected_core_leaf_count != Some(protected.len())
                || receipt.baseline_digest.as_deref()
                    != Some(&artifact.materialization.receipt_digest)
                || mutable == 0
                || artifact.approved_commands.is_empty()
            {
                return Err("agent-run delivery V4/V5 policy receipt authority drift".to_owned());
            }
        }
    }
    Ok(())
}

fn validate_validation_evidence_policy_receipt(
    spec: &AgentRunSpec,
    receipt: Option<&ChildValidationEvidencePolicyReceipt>,
) -> Result<(), String> {
    if spec.boundary_id.0 != "autopilot.validation_submission.v3" {
        return if receipt.is_none() {
            Ok(())
        } else {
            Err("agent-run validation evidence policy receipt on non-v3 profile".to_owned())
        };
    }
    let receipt =
        receipt.ok_or_else(|| "agent-run missing validation evidence policy receipt".to_owned())?;
    let context_path = spec
        .context_manifest_path
        .as_ref()
        .ok_or_else(|| "agent-run v3 validation missing context_manifest_path".to_owned())?;
    let context_digest = spec
        .context_manifest_digest
        .as_ref()
        .ok_or_else(|| "agent-run v3 validation missing context_manifest_digest".to_owned())?;
    let bytes = super::read_bounded_file(
        Path::new(&context_path.0),
        kernel::generated::VALIDATION_CONTEXT_V3_MAX_BYTES,
    )
    .map_err(|error| format!("agent-run validation evidence context read: {error}"))?;
    let context: kernel::generated::ValidationContextV3 = serde_json::from_slice(&bytes)
        .map_err(|error| format!("agent-run validation evidence context json: {error}"))?;
    if receipt.context_path != context_path.0
        || receipt.context_digest != context_digest.0
        || receipt.cwd != spec.cwd.0
        || receipt.active_override != "read"
        || receipt.evidence_count != context.citation_records.len()
        || receipt.evidence_count == 0
        || sha256_hex(&bytes) != context_digest.0
        || context.citation_records.iter().any(|record| {
            crate::runner::validation_authority::is_receipt_ref(&record.evidence_ref.0)
                || (record.source_path.is_some() == record.diff_path.is_some())
        })
    {
        return Err("agent-run validation evidence policy receipt drift".to_owned());
    }
    Ok(())
}

fn normalize_streamed_child_tool_receipt(
    entry: &AppendedEntry,
) -> Result<ChildToolReceipt, String> {
    if entry.custom_type != "pi-autopilot:child-tools" {
        return Err(format!(
            "agent-run unexpected bootstrap entry type {}",
            entry.custom_type
        ));
    }
    normalize_child_tool_receipt_data(&entry.id, entry.data.clone())
}

fn normalize_child_tool_receipt_data(
    entry_id: &str,
    data: Value,
) -> Result<ChildToolReceipt, String> {
    let ChildToolReceiptData {
        self_digest,
        profile_id,
        tool_name,
        boundary_id,
        result_contract,
        schema_digest,
        binding,
        mut active_tools,
        delivery_policy,
        validation_evidence_policy,
    } = serde_json::from_value(data)
        .map_err(|error| format!("agent-run child add-on receipt data malformed: {error}"))?;
    active_tools.sort();
    Ok(ChildToolReceipt {
        entry_id: entry_id.to_owned(),
        self_digest,
        profile_id,
        tool_name,
        boundary_id,
        result_contract,
        schema_digest,
        binding,
        active_tools,
        delivery_policy,
        validation_evidence_policy,
    })
}

impl RpcAssignment {
    fn spawn_and_configure_v5(
        spec: &AgentRunSpec,
        child_control: ChildControlLaunchConfig,
    ) -> Result<Self, String> {
        let policy = CheckpointPolicy::parse()
            .map_err(|error| format!("agent-run checkpoint policy: {error}"))?;
        policy
            .role(&spec.role_id.0)
            .map_err(|error| format!("agent-run checkpoint role policy: {error}"))?;
        let tools = spec
            .allowed_tools
            .iter()
            .map(|tool| tool.0.clone())
            .collect::<Vec<_>>();
        let stderr_limit = bounded_stderr_limit(env_usize(
            "AUTOPILOT_AGENT_RUN_MAX_STDERR_BYTES",
            DEFAULT_MAX_PI_STDERR_BYTES,
        )?)?;
        let mut config = RpcSpawnConfig::new(
            PathBuf::from(&spec.cwd.0),
            spec.provider.clone(),
            spec.model.clone(),
            spec.thinking.0.clone(),
            spec.session_id.0.clone(),
            PathBuf::from(&spec.session_dir.0),
            tools,
        );
        config.stderr_tail_bytes = stderr_limit;
        // The terminal payload budget bounds the child's structured WORK PRODUCT (a
        // `message_end` / `tool_execution_end` frame), which is a different concept from
        // the raw-stdout ceiling. Deriving it from AUTOPILOT_AGENT_RUN_MAX_STDOUT_BYTES
        // silently discarded the declared 2 MiB terminal budget and pinned the effective
        // limit at the 1 MiB stdout default, so a legitimate 1,062,182-byte plan review
        // hard-failed an entire LIVE run 1.3% over a limit that was never intended to
        // apply. The terminal budget now has its own knob and its own default; the
        // stdout knob no longer influences it at all: verified that the three tests
        // setting AUTOPILOT_AGENT_RUN_MAX_STDOUT_BYTES to 1024/4096 were ALREADY no-ops
        // at HEAD, because the old `.max(DEFAULT_MAX_PI_STDOUT_BYTES)` floor swallowed
        // any value below 1 MiB. Keeping a floor here would only re-couple the budgets.
        let terminal_limit = env_usize(
            "AUTOPILOT_AGENT_RUN_MAX_TERMINAL_BYTES",
            crate::generated::pi_rpc::DEFAULT_MAX_TERMINAL_BYTES,
        )?;
        config.max_terminal_bytes = bounded_terminal_limit(terminal_limit)?;
        config.child_control = Some(child_control);
        if let Some((path, _)) = runtime_addon(spec) {
            config.runtime_addon = Some(PathBuf::from(&path.0));
            config.terminal_profile = spec.terminal_profile_id.clone();
            config.carrier_binding = Some(carrier_binding(spec));
            if matches!(
                spec.assignment_kind,
                kernel::generated::ValidationAssignmentKind::Delivery
            ) {
                let assignment_path = spec
                    .assignment_path
                    .as_ref()
                    .ok_or_else(|| "agent-run delivery missing assignment_path".to_owned())?;
                let assignment_digest = spec
                    .assignment_digest
                    .as_ref()
                    .ok_or_else(|| "agent-run delivery missing assignment_digest".to_owned())?;
                let worktree = spec
                    .worktree
                    .as_ref()
                    .ok_or_else(|| "agent-run delivery missing worktree".to_owned())?;
                let lane_id = spec
                    .lane_id
                    .as_ref()
                    .ok_or_else(|| "agent-run delivery missing lane_id".to_owned())?;
                let attempt = spec
                    .attempt
                    .ok_or_else(|| "agent-run delivery missing attempt".to_owned())?;
                let base_commit = spec
                    .base_commit
                    .as_ref()
                    .ok_or_else(|| "agent-run delivery missing base_commit".to_owned())?;
                config.delivery_policy = Some(DeliveryPolicyLaunchConfig {
                    assignment_path: assignment_path.0.clone(),
                    assignment_digest: assignment_digest.0.clone(),
                    worktree: worktree.0.clone(),
                    cwd: spec.cwd.0.clone(),
                    assignment_id: spec.assignment_id.0.clone(),
                    workstream: spec.workstream.0.clone(),
                    lane_id: lane_id.0.clone(),
                    attempt,
                    base_commit: base_commit.0.clone(),
                    policy_digest: match super::read_delivery_assignment_artifact(
                        &super::read_bounded_file(
                            Path::new(&assignment_path.0),
                            super::DELIVERY_ASSIGNMENT_MAX_BYTES,
                        )
                        .map_err(|error| format!("agent-run delivery assignment read: {error}"))?,
                    )? {
                        super::DeliveryAssignmentArtifactReader::V3(_) => {
                            super::delivery_policy_digest(
                                &assignment_path.0,
                                &assignment_digest.0,
                                &worktree.0,
                                &spec.cwd.0,
                            )
                        }
                        super::DeliveryAssignmentArtifactReader::V4(_) => {
                            super::delivery_policy_digest_v5(
                                &assignment_path.0,
                                &assignment_digest.0,
                                &worktree.0,
                                &spec.cwd.0,
                            )
                        }
                    },
                });
            }
            if spec.boundary_id.0 == "autopilot.validation_submission.v3" {
                let context_path = spec.context_manifest_path.as_ref().ok_or_else(|| {
                    "agent-run v3 validation missing context_manifest_path".to_owned()
                })?;
                let context_digest = spec.context_manifest_digest.as_ref().ok_or_else(|| {
                    "agent-run v3 validation missing context_manifest_digest".to_owned()
                })?;
                config.validation_evidence = Some(ValidationEvidenceLaunchConfig {
                    context_path: context_path.0.clone(),
                    context_digest: context_digest.0.clone(),
                    cwd: spec.cwd.0.clone(),
                });
            }
        }
        let startup_stagger = SubscriptionStartupStaggerPolicy::parse()
            .map_err(|error| format!("agent-run subscription startup policy: {error}"))?;
        if let Some(delay) = subscription_startup_delay(startup_stagger, spec) {
            std::thread::sleep(delay);
        }
        validate_v5_session_path(Path::new(&spec.session_dir.0))?;
        let client = RpcClient::spawn(config).map_err(|error| error.to_string())?;
        let mut runner = Self {
            client,
            next_command: 0,
            policy,
            bootstrap_entry: None,
        };
        let configuration = (|| -> Result<(), String> {
            let auto_id = runner.next_id("auto-off");
            let response =
                runner.command_response(RpcCommand::set_auto_compaction(auto_id, false))?;
            if !response.success {
                return Err("agent-run set_auto_compaction returned success:false".to_owned());
            }
            let state_id = runner.next_id("state");
            let state = runner.command_response(RpcCommand::get_state(state_id))?;
            runner.validate_state_v5(spec, &state)?;
            if runtime_addon(spec).is_some() {
                let entries_id = runner.next_id("entries");
                let entries = runner.command_response(RpcCommand::get_entries(entries_id))?;
                runner.validate_child_receipt(spec, &entries)?;
            } else if runner.bootstrap_entry.is_some() {
                return Err(
                    "agent-run child emitted a registration entry without a runtime add-on"
                        .to_owned(),
                );
            }
            runner.client.complete_bootstrap();
            runner.bootstrap_entry = None;
            Ok(())
        })();
        if let Err(error) = configuration {
            return match runner.shutdown_v5() {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!(
                    "{error}; agent-run V5 bootstrap cleanup failed: {cleanup}"
                )),
            };
        }
        Ok(runner)
    }

    fn send_v5_prompt(&mut self, message: &str) -> Result<String, String> {
        let id = self.next_id("v5-prompt");
        self.client
            .send_command(RpcCommand::prompt(id.clone(), message.to_owned()))
            .map_err(|error| format!("agent-run V5 rpc prompt failed: {error}"))?;
        Ok(id)
    }

    fn request_v5_stats(
        &mut self,
        cycle: &mut V5CycleState,
        sequence: &mut u64,
    ) -> Result<(), String> {
        *sequence = sequence
            .checked_add(1)
            .ok_or_else(|| "agent-run V5 context telemetry sequence overflow".to_owned())?;
        let id = self.next_id("v5-stats");
        self.client
            .send_command(RpcCommand::get_session_stats(id.clone()))
            .map_err(|error| format!("agent-run V5 context telemetry request failed: {error}"))?;
        if cycle.pending_stats.insert(id, *sequence).is_some() {
            return Err("agent-run V5 duplicate context telemetry request id".to_owned());
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_v5_runtime_response(
        &mut self,
        spec: &AgentRunSpec,
        cycle: &mut V5CycleState,
        response: RpcResponse,
        latest_budget: &mut Option<(u64, ContextBudget)>,
        warning_sent: &mut bool,
        warning_required: &mut Option<ContextPercent>,
        checkpoint_request: &mut Option<ContextPercent>,
        checkpoint_instruction_dispatched: &mut bool,
        settled: bool,
    ) -> Result<(), String> {
        if response.id == cycle.prompt_id {
            if response.command != RpcCommandKind::Prompt || !response.success {
                return Err("agent-run V5 prompt response drift".to_owned());
            }
            if cycle.prompt_response_seen {
                return Err("agent-run V5 duplicate prompt response".to_owned());
            }
            cycle.prompt_response_seen = true;
            return Ok(());
        }
        if let Some(sequence) = cycle.pending_stats.remove(&response.id) {
            if response.command != RpcCommandKind::GetSessionStats || !response.success {
                return Err("agent-run V5 context telemetry response drift".to_owned());
            }
            let budget = context_budget_from_stats(&response, &spec.session_id.0)?;
            if latest_budget.is_none_or(|(latest, _)| sequence > latest) {
                *latest_budget = Some((sequence, budget));
            }
            let ContextBudget::Known(percent) = budget else {
                return Ok(());
            };
            let checkpoint_threshold = self.context_threshold("checkpoint")?;
            if percent.as_f64() >= checkpoint_threshold {
                let interruptible = self
                    .policy
                    .role(&spec.role_id.0)
                    .map_err(|error| format!("agent-run checkpoint role policy: {error}"))?
                    .interruptible;
                if !interruptible {
                    return Err(format!(
                        "agent-run role `{}` is not interruptible at observed context {:.2}%; checkpoint refused",
                        spec.role_id.0,
                        percent.as_f64()
                    ));
                }
                if checkpoint_request.is_none_or(|observed| percent.as_f64() > observed.as_f64()) {
                    *checkpoint_request = Some(percent);
                }
                *warning_required = None;
                if !*checkpoint_instruction_dispatched && !settled && !cycle.agent_end_seen {
                    let prompt = self.checkpoint_prompt(spec)?;
                    self.send_v5_steer(cycle, V5SteerKind::Checkpoint, prompt)?;
                    *checkpoint_instruction_dispatched = true;
                }
                return Ok(());
            }
            if percent.as_f64() >= self.context_threshold("arm")? && !*warning_sent {
                if warning_required.is_none_or(|observed| percent.as_f64() > observed.as_f64()) {
                    *warning_required = Some(percent);
                }
                if !settled && !cycle.agent_end_seen {
                    let warning = self.warning_prompt(spec, percent);
                    self.send_v5_steer(cycle, V5SteerKind::SoftWarning, warning)?;
                    *warning_required = None;
                    *warning_sent = true;
                }
            }
            return Ok(());
        }
        if let Some(_kind) = cycle.pending_steers.remove(&response.id) {
            if response.command != RpcCommandKind::Steer
                || !response.success
                || !response.queued_not_delivered
            {
                return Err("agent-run V5 steer response drift".to_owned());
            }
            return Ok(());
        }
        Err(format!(
            "agent-run V5 unexpected rpc response id {} during child-control session",
            response.id
        ))
    }

    fn send_v5_steer(
        &mut self,
        cycle: &mut V5CycleState,
        kind: V5SteerKind,
        message: String,
    ) -> Result<(), String> {
        let id = self.next_id(match kind {
            V5SteerKind::SoftWarning => "v5-warning",
            V5SteerKind::Checkpoint => "v5-checkpoint",
        });
        self.client
            .send_command(RpcCommand::steer(id.clone(), message))
            .map_err(|error| format!("agent-run V5 steer failed: {error}"))?;
        if cycle.pending_steers.insert(id, kind).is_some() {
            return Err("agent-run V5 duplicate steer request id".to_owned());
        }
        Ok(())
    }

    fn context_threshold(&self, name: &str) -> Result<f64, String> {
        self.policy
            .thresholds
            .get(name)
            .copied()
            .map(|value| value as f64)
            .ok_or_else(|| format!("agent-run checkpoint policy missing {name} threshold"))
    }

    fn warning_prompt(&self, spec: &AgentRunSpec, percent: ContextPercent) -> String {
        format!(
            "Autopilot context warning for assignment {} in session {}: observed usage is {:.2}%. Finish the nearest atomic action, avoid broad new exploration, and prepare a coherent role-complete checkpoint if the parent requests one. Continue the current assignment; this warning is not completion.",
            spec.assignment_id.0,
            spec.session_id.0,
            percent.as_f64()
        )
    }

    fn checkpoint_prompt(&self, spec: &AgentRunSpec) -> Result<String, String> {
        let slots = self.policy.required_slot_names(&spec.role_id.0)?;
        Ok(format!(
            "Autopilot context checkpoint is now required for assignment {} in this same session. Finish only the nearest atomic action, then call {} with one {} payload. critical_state must include these role-required slots: {}. ACCEPT pauses for parent-controlled manual compaction and is not assignment completion. RETRY means correct the handoff and call {} again; do not return the handoff as prose.",
            spec.assignment_id.0,
            V5_CHECKPOINT_TOOL_NAME,
            self.policy.handoff_contract,
            slots.join(", "),
            V5_CHECKPOINT_TOOL_NAME,
        ))
    }

    fn continuation_prompt(
        &self,
        spec: &AgentRunSpec,
        percent: ContextPercent,
    ) -> Result<String, String> {
        if percent.as_f64() >= self.context_threshold("checkpoint")? {
            return Err(
                "agent-run V5 refused a below-threshold continuation at checkpoint usage"
                    .to_owned(),
            );
        }
        Ok(format!(
            "Continue the current assignment {} in the same role, mode, worktree, and Pi session. Parent-observed context usage at the last settled boundary was {:.2}%, below the package checkpoint threshold. Do not reread or infer authority. Completion still requires a generated receipt-backed submit ACCEPT; BLOCKED retains its universal whole-workstream semantics.",
            spec.assignment_id.0,
            percent.as_f64(),
        ))
    }

    /// Pi 0.84 `abort` waits for idle but does not clear steering/follow-up
    /// queues. Exact `pendingMessageCount == 0` is therefore the only
    /// fail-closed authority before another prompt or manual compaction.
    fn verify_settled_queue_state(&mut self, spec: &AgentRunSpec) -> Result<(), String> {
        let id = self.next_id("v5-settled-state");
        let response = self.command_response(RpcCommand::get_state(id))?;
        self.validate_state_identity_v5(spec, &response)
            .map_err(|error| format!("agent-run V5 settled queue verification failed: {error}"))
    }

    fn checkpoint_record(
        &self,
        spec: &AgentRunSpec,
        context_percent: ContextPercent,
        handoff: AgentHandoff,
    ) -> Result<V5Checkpoint, String> {
        // Conversation checkpoint authority is deliberately repository-free.
        // Execution worktree/edit/test facts remain role-required typed handoff
        // slots; this runner neither invents a planning identity for execution
        // nor inspects Git while deriving the same-session resume overlay.
        Ok(V5Checkpoint {
            observed_context: context_percent,
            resume_overlay: ResumeOverlay {
                assignment_id: spec.assignment_id.clone(),
                session_ref: kernel::generated::Ref(format!("session:{}", spec.session_id.0)),
                run_revision: spec.run_revision,
                handoff,
            },
        })
    }

    fn manual_compact(&mut self, checkpoint: &V5Checkpoint) -> Result<(), String> {
        let slots = self
            .policy
            .required_slot_names_from_handoff(&checkpoint.resume_overlay.handoff)?;
        let instructions = format!(
            "Manual parent-controlled Autopilot checkpoint compaction for assignment {}. Preserve the accepted handoff exactly, especially role-required critical_state slots: {}. Do not infer completed work absent from the handoff.",
            checkpoint.resume_overlay.assignment_id.0,
            slots.join(", ")
        );
        let id = self.next_id("v5-compact");
        self.client
            .send_command(RpcCommand::compact(id.clone(), instructions))
            .map_err(|error| format!("agent-run V5 manual compaction command failed: {error}"))?;
        let mut saw_start = false;
        let mut saw_end = false;
        let mut saw_response = false;
        while !(saw_start && saw_end && saw_response) {
            let frame = self
                .client
                .next_frame()
                .map_err(|error| format!("agent-run V5 manual compaction stream failed: {error}"))?
                .ok_or_else(|| {
                    "agent-run V5 rpc stream ended during manual compaction".to_owned()
                })?;
            match frame {
                RpcFrame::Response(response) if response.id == id => {
                    if saw_response
                        || response.command != RpcCommandKind::Compact
                        || !response.success
                    {
                        return Err("agent-run V5 manual compaction response drift".to_owned());
                    }
                    validate_v5_compaction_response(&response)?;
                    saw_response = true;
                }
                RpcFrame::Response(response) => {
                    return Err(format!(
                        "agent-run V5 unexpected response during manual compaction: {}",
                        response.id
                    ));
                }
                RpcFrame::Event(RpcEvent::CompactionStart {
                    reason: crate::runner::rpc::CompactionReason::Manual,
                }) if !saw_start && !saw_end => saw_start = true,
                RpcFrame::Event(RpcEvent::CompactionEnd {
                    reason: crate::runner::rpc::CompactionReason::Manual,
                    aborted: false,
                    will_retry: false,
                }) if saw_start && !saw_end => saw_end = true,
                RpcFrame::Event(RpcEvent::CompactionEnd { aborted: true, .. }) => {
                    return Err("agent-run V5 manual compaction aborted".to_owned());
                }
                RpcFrame::Event(event) => {
                    return Err(format!(
                        "agent-run V5 unexpected rpc event during manual compaction: {event:?}"
                    ));
                }
            }
        }
        Ok(())
    }

    fn verify_post_compact_state(&mut self, spec: &AgentRunSpec) -> Result<(), String> {
        let id = self.next_id("v5-post-compact-state");
        let response = self.command_response(RpcCommand::get_state(id))?;
        self.validate_state_identity_v5(spec, &response)
            .map_err(|error| format!("agent-run V5 post-compaction verification failed: {error}"))
    }

    fn resume_prompt(
        &self,
        spec: &AgentRunSpec,
        checkpoint: &V5Checkpoint,
        checkpoint_ref: &V5CheckpointRef,
        receipt: &CheckpointReceipt,
    ) -> Result<String, String> {
        let overlay = &checkpoint.resume_overlay;
        let packet = serde_json::json!({
            "run_id": receipt.run_id,
            "workstream": spec.workstream,
            "action_id": spec.action_id,
            "assignment_id": overlay.assignment_id,
            "attempt": receipt.attempt,
            "run_revision": overlay.run_revision,
            "role_id": receipt.role_id,
            "mode": receipt.mode,
            "session_id": receipt.session_id,
            "session_ref": overlay.session_ref,
            "boundary_id": spec.boundary_id,
            "result_contract": spec.result_contract,
            "prompt_digest": spec.prompt_digest,
            "context_digest": spec.context_digest,
            "observed_context_percent": checkpoint.observed_context.as_f64(),
            "checkpoint_receipt_id": receipt.receipt_id,
            "checkpoint_receipt_path": checkpoint_ref.path,
            "checkpoint_receipt_digest": checkpoint_ref.digest,
            "handoff": overlay.handoff,
        });
        let bytes = crate::evidence::canonical_json(&packet).map_err(|error| {
            format!("agent-run V5 resume packet canonicalization failed: {error}")
        })?;
        let packet = String::from_utf8(bytes)
            .map_err(|error| format!("agent-run V5 resume packet UTF-8 failed: {error}"))?;
        Ok(format!(
            "Resume the same assignment from this package-authored checkpoint packet after verified manual compaction of this same Pi session. The original role, mode, assignment, and prompt authority remain unchanged. Treat only the referenced canonical checkpoint receipt and this derived packet as retained state; do not invent completed work or reread completed authority. Continue with handoff.next_action. A checkpoint is not delivery, validation, integration, closure, or assignment completion. Resume packet JSON: {packet}"
        ))
    }

    fn command_response(&mut self, command: RpcCommand) -> Result<RpcResponse, String> {
        let expected = command.id.clone();
        self.client
            .send_command(command)
            .map_err(|error| error.to_string())?;
        loop {
            let frame = self
                .client
                .next_frame()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "agent-run rpc stream ended before command response".to_owned())?;
            match frame {
                RpcFrame::Response(response) if response.id == expected => return Ok(response),
                RpcFrame::Response(response) => {
                    return Err(format!(
                        "agent-run unexpected rpc response id {}; expected {expected}",
                        response.id
                    ));
                }
                RpcFrame::Event(RpcEvent::EntryAppended { entry }) => {
                    if self.bootstrap_entry.replace(entry).is_some() {
                        return Err(
                            "agent-run received duplicate child registration entry".to_owned()
                        );
                    }
                }
                RpcFrame::Event(event) => {
                    return Err(format!(
                        "agent-run unexpected rpc event before configuration completed: {event:?}"
                    ));
                }
            }
        }
    }

    fn validate_child_receipt(
        &self,
        spec: &AgentRunSpec,
        response: &RpcResponse,
    ) -> Result<(), String> {
        let (_, expected_digest) = runtime_addon(spec)
            .ok_or_else(|| "agent-run child add-on receipt without expected digest".to_owned())?;
        let data = response
            .data
            .as_ref()
            .ok_or_else(|| "agent-run get_entries missing data".to_owned())?;
        let value: Value = serde_json::from_str(data)
            .map_err(|error| format!("agent-run get_entries malformed data: {error}"))?;
        let entries = value
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| "agent-run get_entries missing entries".to_owned())?;
        let receipts = entries
            .iter()
            .filter(|entry| {
                entry.get("customType").and_then(Value::as_str) == Some("pi-autopilot:child-tools")
            })
            .collect::<Vec<_>>();
        if receipts.len() != 1 {
            return Err(format!(
                "agent-run child add-on registration receipt count was {}; expected exactly one",
                receipts.len()
            ));
        }
        let durable = normalize_child_tool_receipt(receipts[0])?;
        if let Some(streamed) = &self.bootstrap_entry {
            let streamed = normalize_streamed_child_tool_receipt(streamed)?;
            if streamed != durable {
                return Err(format!(
                    "agent-run streamed child registration entry drift: expected {durable:?}, got {streamed:?}"
                ));
            }
        }
        if durable.self_digest != expected_digest.0 {
            return Err(format!(
                "agent-run child add-on digest mismatch: expected {}, got {}",
                expected_digest.0, durable.self_digest
            ));
        }
        let expected_binding = carrier_binding(spec);
        if durable.binding != expected_binding {
            return Err(format!(
                "agent-run child add-on binding receipt mismatch: expected {expected_binding}, got {}",
                durable.binding
            ));
        }
        let profile_id = spec
            .terminal_profile_id
            .as_deref()
            .ok_or_else(|| "agent-run spec missing terminal profile".to_owned())?;
        let profile = super::terminal_profile_for(
            &spec.role_id.0,
            &spec.boundary_id.0,
            &spec.result_contract.0,
        )
        .map_err(|error| error.to_string())?;
        if durable.profile_id != profile_id
            || profile.0 != profile_id
            || durable.tool_name != profile.1
            || durable.boundary_id != profile.2
            || durable.result_contract != profile.3
            || durable.schema_digest != profile.4
        {
            return Err(format!(
                "agent-run child terminal profile receipt drift: expected {profile:?}, got {durable:?}"
            ));
        }
        let mut active = durable.active_tools;
        active.sort();
        let mut expected = spec
            .allowed_tools
            .iter()
            .map(|tool| tool.0.clone())
            .collect::<Vec<_>>();
        expected.sort();
        if !active.iter().any(|tool| tool == profile.1) {
            return Err(format!(
                "agent-run V5 child-control submit tool is not active: expected {} in {active:?}",
                profile.1
            ));
        }
        if active != expected {
            return Err(format!(
                "agent-run active tools drift before prompt: expected {expected:?}, got {active:?}"
            ));
        }
        validate_delivery_policy_receipt(spec, durable.delivery_policy.as_ref())?;
        validate_validation_evidence_policy_receipt(
            spec,
            durable.validation_evidence_policy.as_ref(),
        )?;
        Ok(())
    }

    /// Fresh V5 validates the same observed Pi identity without creating the
    /// historical startup marker. Receipt admission, not a runner artifact,
    /// owns fresh V5 persistence.
    fn validate_state_v5(&self, spec: &AgentRunSpec, response: &RpcResponse) -> Result<(), String> {
        let value = v5_state_value(response)?;
        Self::validate_session_history(spec, &value)?;
        self.validate_state_identity_value_v5(spec, &value)
    }

    fn validate_state_identity_v5(
        &self,
        spec: &AgentRunSpec,
        response: &RpcResponse,
    ) -> Result<(), String> {
        let value = v5_state_value(response)?;
        self.validate_state_identity_value_v5(spec, &value)
    }

    fn validate_state_identity_value_v5(
        &self,
        spec: &AgentRunSpec,
        value: &Value,
    ) -> Result<(), String> {
        let session = value.get("sessionId").and_then(Value::as_str);
        let thinking = value.get("thinkingLevel").and_then(Value::as_str);
        let auto = value.get("autoCompactionEnabled").and_then(Value::as_bool);
        let streaming = value.get("isStreaming").and_then(Value::as_bool);
        let compacting = value.get("isCompacting").and_then(Value::as_bool);
        let model = value
            .get("model")
            .and_then(Value::as_object)
            .ok_or_else(|| "agent-run V5 get_state missing model".to_owned())?;
        let provider = model.get("provider").and_then(Value::as_str);
        let model_id = model.get("id").and_then(Value::as_str);
        if session != Some(spec.session_id.0.as_str())
            || provider != Some(spec.provider.as_str())
            || model_id != Some(spec.model.as_str())
            || thinking != Some(spec.thinking.0.as_str())
            || auto != Some(false)
        {
            return Err("agent-run V5 get_state identity drift".to_owned());
        }
        if streaming != Some(false) || compacting != Some(false) {
            return Err("agent-run V5 get_state runtime is not idle".to_owned());
        }
        let pending = value
            .get("pendingMessageCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| "agent-run V5 get_state missing pendingMessageCount".to_owned())?;
        if pending != 0 {
            return Err(format!(
                "agent-run V5 get_state retained {pending} queued message(s); refusing stale steer continuation"
            ));
        }
        Ok(())
    }

    /// Fence the child's inherited conversation length against the assignment's
    /// durable continuity class.
    ///
    /// A genuinely fresh assignment must open an empty Pi session. Any prior
    /// message on the active branch means the child inherited another run's
    /// context, which is unobservable in the produced carrier and therefore
    /// must fail loudly here rather than silently bias the model.
    fn validate_session_history(spec: &AgentRunSpec, state: &Value) -> Result<(), String> {
        let message_count = state
            .get("messageCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| "agent-run get_state missing messageCount".to_owned())?;
        match spec.session_continuity {
            SessionContinuity::Fresh if message_count != 0 => Err(format!(
                "agent-run stale child session: assignment {} is fresh (attempt 1, no checkpoint) but session {} already holds {message_count} message(s); expected 0",
                spec.assignment_id.0, spec.session_id.0
            )),
            SessionContinuity::Fresh => Ok(()),
            SessionContinuity::Resume if message_count == 0 => Err(format!(
                "agent-run resume without history: assignment {} authorizes resume but session {} is empty",
                spec.assignment_id.0, spec.session_id.0
            )),
            SessionContinuity::Resume => Ok(()),
        }
    }

    fn next_id(&mut self, prefix: &str) -> String {
        self.next_command = self.next_command.saturating_add(1);
        format!("{prefix}-{}", self.next_command)
    }

    /// V5 success must wait for the same exact process/stderr lifecycle, but
    /// must not create the historical optional runner diagnostics artifact.
    fn shutdown_v5(&mut self) -> Result<(), String> {
        let shutdown = self
            .client
            .shutdown(Duration::from_millis(250))
            .map_err(|error| error.to_string())?;
        match self.client.next_frame() {
            Ok(None) => {}
            Ok(Some(frame)) => {
                return Err(format!(
                    "agent-run V5 received a trailing rpc frame after terminal settlement: {frame:?}"
                ));
            }
            Err(error) => {
                return Err(format!(
                    "agent-run V5 terminal protocol EOF validation failed: {error}"
                ));
            }
        }
        if shutdown.escalated {
            // The verified ACCEPT is already the semantic terminal. A successful
            // shutdown result proves process-group cleanup, reaping, and stderr
            // completion even when cleanup had to signal Pi.
            return Ok(());
        }
        validate_rpc_shutdown(shutdown)
    }
}

fn validate_rpc_shutdown(shutdown: crate::runner::rpc::RpcShutdown) -> Result<(), String> {
    if shutdown.escalated {
        return Err("agent-run rpc shutdown escalated after stdin close".to_owned());
    }
    match shutdown.status {
        Some(status) if !status.success() => {
            Err(format!("agent-run pi exited nonzero status={status}"))
        }
        _ => Ok(()),
    }
}

/// Deterministic startup spread for fresh subscription-backed V5 children.
/// It is launch pacing only; it never retries, repairs, or changes a session.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) struct SubscriptionStartupStaggerPolicy {
    pub buckets: u64,
    pub step_ms: u64,
    pub max_delay_ms: u64,
}

impl SubscriptionStartupStaggerPolicy {
    pub(crate) fn parse() -> Result<Self, String> {
        Self::parse_source(include_str!("../../../data/recovery.kdl"))
    }

    pub(crate) fn parse_source(source: &str) -> Result<Self, String> {
        let line = source
            .lines()
            .map(str::trim)
            .find_map(|line| line.strip_prefix("subscription_startup_stagger "))
            .ok_or_else(|| "recovery policy missing subscription_startup_stagger".to_owned())?;
        if !line.contains("scope=\"agent-run\"") {
            return Err("subscription_startup_stagger has unsupported scope".to_owned());
        }
        let field = |key: &str| -> Result<u64, String> {
            let start = line
                .find(key)
                .ok_or_else(|| format!("subscription_startup_stagger missing {key}"))?
                + key.len();
            let rest = &line[start..];
            let end = rest
                .find(|character: char| !character.is_ascii_digit())
                .unwrap_or(rest.len());
            rest[..end]
                .parse::<u64>()
                .map_err(|_| format!("subscription_startup_stagger {key} is not a number"))
        };
        let policy = Self {
            buckets: field("buckets=")?,
            step_ms: field("step_ms=")?,
            max_delay_ms: field("max_delay_ms=")?,
        };
        if policy.buckets < 2
            || policy.step_ms == 0
            || policy
                .step_ms
                .saturating_mul(policy.buckets.saturating_sub(1))
                > policy.max_delay_ms
        {
            return Err("subscription_startup_stagger bounds are incoherent".to_owned());
        }
        Ok(policy)
    }

    pub(crate) fn delay(
        self,
        workstream: &str,
        assignment_id: &str,
        lane_id: Option<&str>,
    ) -> Duration {
        let ordinal_source = lane_id.unwrap_or(assignment_id);
        let ordinal_digits = ordinal_source
            .chars()
            .rev()
            .take_while(|character| character.is_ascii_digit())
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>();
        let ordinal = ordinal_digits.parse::<u64>().unwrap_or_else(|_| {
            let digest = Sha256::digest(ordinal_source.as_bytes());
            let mut prefix = [0_u8; 8];
            prefix.copy_from_slice(&digest[..8]);
            u64::from_be_bytes(prefix)
        });
        let workstream_digest = Sha256::digest(workstream.as_bytes());
        let mut workstream_prefix = [0_u8; 8];
        workstream_prefix.copy_from_slice(&workstream_digest[..8]);
        let offset = u64::from_be_bytes(workstream_prefix);
        let bucket = offset.wrapping_add(ordinal.saturating_sub(1)) % self.buckets;
        Duration::from_millis(self.step_ms.saturating_mul(bucket).min(self.max_delay_ms))
    }
}

fn subscription_startup_delay(
    policy: SubscriptionStartupStaggerPolicy,
    spec: &AgentRunSpec,
) -> Option<Duration> {
    (spec.route == "subscription" && spec.session_continuity == SessionContinuity::Fresh).then(
        || {
            policy.delay(
                &spec.workstream.0,
                &spec.assignment_id.0,
                spec.lane_id.as_ref().map(|lane| lane.0.as_str()),
            )
        },
    )
}

fn parse_args(args: &[String]) -> Result<PathBuf, String> {
    if args.len() != 2 || args[0] != "--spec" {
        return Err("usage: autopilot-core agent-run --spec <absolute-spec.json>".to_owned());
    }
    let path = PathBuf::from(&args[1]);
    if !path.is_absolute() {
        return Err(format!("agent-run spec path must be absolute: {:?}", path));
    }
    Ok(path)
}

/// Fresh V5 launches retain the V4 facade only for shared transport checks.
/// Validation assignment selection is explicit: receipt_v1 V3 uses only
/// ValidationAssignmentV4; replay_v0 remains a parent evidence reader.
fn validate_receipt_v1_spec(strict: &AgentRunSpec, spec_path: &Path) -> Result<(), String> {
    if strict.schema.0 != "autopilot.agent_run_spec.v4" {
        return Err(format!(
            "unsupported agent-run spec schema: {}",
            strict.schema.0
        ));
    }
    for (label, value) in [
        ("action_id", strict.action_id.0.as_str()),
        ("assignment_id", strict.assignment_id.0.as_str()),
        ("workstream", strict.workstream.0.as_str()),
        ("role_id", strict.role_id.0.as_str()),
        ("mode", strict.mode.0.as_str()),
        ("session_id", strict.session_id.0.as_str()),
    ] {
        validate_id(label, value)?;
    }
    validate_route_and_role(strict)?;
    validate_paths(strict, spec_path)?;
    validate_runtime_addon(strict)?;
    validate_digests(strict)?;
    validate_session_identity(strict)?;
    validate_terminal_route(strict)?;
    validate_delivery_identity(strict)?;
    validate_planning_documents(strict)?;
    validate_planning_atom_bindings(strict)?;
    Ok(())
}

fn validate_session_identity(strict: &AgentRunSpec) -> Result<(), String> {
    // run_id is read from the spec rather than re-derived here. Recomputing it
    // in the child would recreate the very conflation this fix removes: the
    // parent owns run identity, the child only verifies the value it was given.
    let expected = super::session_id_for(
        &strict.run_id,
        &strict.workstream,
        &strict.assignment_id,
        &strict.role_id,
        &strict.mode,
        &strict.boundary_id,
    );
    if strict.session_id != expected {
        return Err(format!(
            "agent-run session_id drift: expected {}, got {}",
            expected.0, strict.session_id.0
        ));
    }
    Ok(())
}

fn validate_route_and_role(strict: &AgentRunSpec) -> Result<(), String> {
    let role = super::role_runtime(&strict.role_id.0)
        .map_err(|error| format!("role/roster validation failed: {error}"))?;
    if !role.modes.iter().any(|mode| mode == &strict.mode.0) {
        return Err(format!(
            "agent-run role/mode drift: {}/{}",
            strict.role_id.0, strict.mode.0
        ));
    }
    if strict.route != role.route
        || strict.route != "subscription"
        || strict.provider != role.provider
        || strict.model != role.model
        || strict.thinking.0 != role.thinking
    {
        return Err(format!(
            "agent-run roster drift: expected {}/{}/{} via {}, got {}/{}/{} via {}",
            role.provider,
            role.model,
            role.thinking,
            role.route,
            strict.provider,
            strict.model,
            strict.thinking.0,
            strict.route
        ));
    }
    if strict.provider.to_ascii_lowercase().contains("openrouter")
        || strict.route.to_ascii_lowercase().contains("api")
        || strict.route.to_ascii_lowercase().contains("openrouter")
    {
        return Err("agent-run refuses OpenRouter/API-key route substitution".to_owned());
    }
    let profile_id = strict
        .terminal_profile_id
        .as_deref()
        .ok_or_else(|| "agent-run missing terminal_profile_id".to_owned())?;
    let profile = super::terminal_profile_for(
        &strict.role_id.0,
        &strict.boundary_id.0,
        &strict.result_contract.0,
    )
    .map_err(|error| error.to_string())?;
    if profile.0 != profile_id {
        return Err(format!(
            "agent-run terminal profile drift: expected {}, got {profile_id}",
            profile.0
        ));
    }
    let mut resolved = super::resolve_role_tools(&strict.role_id.0, profile_id)
        .map_err(|error| error.to_string())?;
    for (_, tool_name, _, _, _, _) in kernel::generated::UNIVERSAL_CHILD_TOOLS {
        if !resolved.active.iter().any(|active| active == tool_name) {
            resolved.active.push(tool_name.to_owned());
        }
    }
    let actual_tools = strict
        .allowed_tools
        .iter()
        .map(|tool| tool.0.clone())
        .collect::<Vec<_>>();
    let unavailable = strict
        .unavailable_tools
        .as_ref()
        .map(|tools| tools.iter().map(|tool| tool.0.clone()).collect::<Vec<_>>())
        .unwrap_or_default();
    if actual_tools != resolved.active || unavailable != resolved.unavailable {
        return Err(format!(
            "agent-run capability drift: expected active={:?} unavailable={:?}, got active={actual_tools:?} unavailable={unavailable:?}",
            resolved.active, resolved.unavailable
        ));
    }
    match strict.assignment_kind {
        kernel::generated::ValidationAssignmentKind::PlanningReview
            if strict.boundary_id.0.starts_with("planning.") => {}
        kernel::generated::ValidationAssignmentKind::Delivery
            if strict.boundary_id.0 == "autopilot.delivery_submission.v2"
                && strict.result_contract.0 == "autopilot.delivery_result.v2" => {}
        kernel::generated::ValidationAssignmentKind::Validation
            if (strict.boundary_id.0 == "autopilot.validation_submission.v2"
                && strict.result_contract.0 == "autopilot.validation_result.v2")
                || (strict.boundary_id.0 == "autopilot.validation_submission.v3"
                    && strict.result_contract.0 == "autopilot.validation_result.v3") => {}
        _ => {
            return Err(format!(
                "agent-run assignment kind/boundary/result drift: {:?}/{}/{}",
                strict.assignment_kind, strict.boundary_id.0, strict.result_contract.0
            ));
        }
    }
    Ok(())
}

fn validate_terminal_route(strict: &AgentRunSpec) -> Result<(), String> {
    let planning = matches!(
        strict.assignment_kind,
        kernel::generated::ValidationAssignmentKind::PlanningReview
    );
    if !planning {
        return if strict.terminal_route.is_none() {
            Ok(())
        } else {
            Err("agent-run non-planning spec has a terminal route record".to_owned())
        };
    }
    let Some(route) = strict.terminal_route.as_ref() else {
        return if strict.boundary_id.0 == "planning.work-map.v2" {
            Err("agent-run V2 planning spec missing terminal route record".to_owned())
        } else {
            // A known legacy V1 spec is read only through its explicit
            // historical authority path; missing routing metadata never
            // selects V2 or infers a new route.
            Ok(())
        };
    };
    let expected = super::terminal_route_for(
        &strict.role_id.0,
        &strict.boundary_id.0,
        &strict.result_contract.0,
    )
    .map_err(|error| error.to_string())?;
    if route != &expected
        || route.profile_id != strict.terminal_profile_id.as_deref().unwrap_or_default()
        || route.boundary_id != strict.boundary_id
        || route.result_contract != strict.result_contract
    {
        return Err("agent-run terminal route tuple drift".to_owned());
    }
    if strict.boundary_id.0 == "planning.work-map.v2"
        && (route.version != "v2"
            || strict.atom_registry_path.is_none()
            || strict.atom_registry_digest.is_none())
    {
        return Err(
            "agent-run V2 work-map route lacks exact route or authority binding".to_owned(),
        );
    }
    Ok(())
}

fn validate_paths(strict: &AgentRunSpec, spec_path: &Path) -> Result<(), String> {
    let cwd = path_value("cwd", &strict.cwd.0)?;
    let declared_spec = path_value("spec_path", &strict.spec_path.0)?;
    let prompt = path_value("prompt_path", &strict.prompt_path.0)?;
    let carrier = path_value("carrier_path", &strict.carrier_path.0)?;
    super::reject_link_components_for_path(&cwd).map_err(|error| error.to_string())?;
    super::reject_link_components_for_path(&declared_spec).map_err(|error| error.to_string())?;
    super::reject_link_components_for_path(&prompt).map_err(|error| error.to_string())?;
    super::reject_link_components_for_path(&carrier).map_err(|error| error.to_string())?;
    let expected_paths = match strict.assignment_kind {
        kernel::generated::ValidationAssignmentKind::PlanningReview => {
            super::planning_paths(&cwd, &strict.workstream.0, &strict.assignment_id)
        }
        kernel::generated::ValidationAssignmentKind::Delivery => {
            super::delivery_paths(&cwd, &strict.assignment_id)
        }
        kernel::generated::ValidationAssignmentKind::Validation => {
            super::validation_paths(&cwd, &strict.workstream.0, &strict.assignment_id)
        }
    };
    compare_path("spec_path", spec_path, &expected_paths.spec_path)?;
    compare_path(
        "declared_spec_path",
        &declared_spec,
        &expected_paths.spec_path,
    )?;
    compare_path("prompt_path", &prompt, &expected_paths.prompt_path)?;
    compare_path("carrier_path", &carrier, &expected_paths.carrier_path)?;
    Ok(())
}

fn validate_runtime_addon(strict: &AgentRunSpec) -> Result<(), String> {
    match runtime_addon(strict) {
        Some((path, expected)) => {
            let path = path_value("runtime_addon_path", &path.0)?;
            let actual = super::child_addon_digest_for_path(&path)
                .map_err(|error| format!("agent-run child add-on read failed: {error}"))?;
            if expected.0 != kernel::generated::CHILD_ADDON_DIGEST {
                return Err(format!(
                    "agent-run child add-on authority digest drift: expected {}, got {}",
                    kernel::generated::CHILD_ADDON_DIGEST,
                    expected.0
                ));
            }
            if actual != expected.0 {
                return Err(format!(
                    "agent-run child add-on digest mismatch: expected {}, got {actual}",
                    expected.0
                ));
            }
            Ok(())
        }
        None => Err("agent-run spec requires child add-on path and digest".to_owned()),
    }
}

pub fn carrier_binding(spec: &AgentRunSpec) -> String {
    sha256_hex(
        format!(
            "autopilot.tool-carrier.v2\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
            spec.run_id.0,
            spec.action_id.0,
            spec.assignment_id.0,
            spec.run_revision,
            spec.boundary_id.0,
            spec.result_contract.0,
            spec.terminal_profile_id.as_deref().unwrap_or("<missing>"),
            runtime_addon(spec).map_or("<missing>", |(_, digest)| digest.0.as_str()),
            spec.prompt_digest.0
        )
        .as_bytes(),
    )
}

fn validate_digests(strict: &AgentRunSpec) -> Result<(), String> {
    let route = super::route_for_role(&strict.role_id.0).map_err(|error| error.to_string())?;
    let expected_boundary =
        super::contract_digest(&strict.boundary_id.0).map_err(|error| error.to_string())?;
    let expected_result =
        super::contract_digest(&strict.result_contract.0).map_err(|error| error.to_string())?;
    let expected_subscription = super::subscription_digest(&route);
    if strict.boundary_digest.0 != expected_boundary
        || strict.result_contract_digest.0 != expected_result
        || strict.settings_digest.0 != super::settings_digest(runtime_addon(strict).is_some())
        || strict.skills_digest.0 != super::skills_digest()
        || strict.subscription_digest.0 != expected_subscription
    {
        return Err("agent-run authority/settings/subscription digest drift".to_owned());
    }
    let context_digest = match &strict.assignment_kind {
        // Delivery context is schema-versioned assignment authority. Its one
        // producer/consumer owner runs only after the digest-bound assignment
        // has selected the exact V3 or V4 parser in validate_delivery_identity.
        kernel::generated::ValidationAssignmentKind::Delivery => return Ok(()),
        kernel::generated::ValidationAssignmentKind::PlanningReview => {
            let authority_set_id = strict
                .authority_set_id
                .as_deref()
                .ok_or_else(|| "agent-run missing authority_set_id".to_owned())?;
            let authority_documents = strict
                .authority_documents
                .as_ref()
                .ok_or_else(|| "agent-run missing authority documents".to_owned())?;
            let context_documents = strict
                .context_documents
                .as_ref()
                .ok_or_else(|| "agent-run missing context_documents".to_owned())?;
            super::planning_context_digest(authority_set_id, authority_documents, context_documents)
                .map_err(|error| error.to_string())?
        }
        kernel::generated::ValidationAssignmentKind::Validation => sha_json(&serde_json::json!({
            "assignment_path": strict.assignment_path,
            "assignment_digest": strict.assignment_digest,
            "context_manifest_path": strict.context_manifest_path,
            "context_manifest_digest": strict.context_manifest_digest,
            "producer_assignment_ids": strict.producer_assignment_ids,
            "validation_id": strict.validation_id,
            "validation_attempt": strict.validation_attempt,
            "semantic_round": strict.semantic_round,
        }))?,
    };
    if strict.context_digest.0 != context_digest {
        return Err("agent-run context digest drift".to_owned());
    }
    Ok(())
}

fn validate_delivery_identity(strict: &AgentRunSpec) -> Result<(), String> {
    if matches!(
        strict.assignment_kind,
        kernel::generated::ValidationAssignmentKind::PlanningReview
    ) {
        let prefix = format!("planning-{}-{}-", strict.workstream.0, strict.role_id.0);
        if strict.assignment_id.0.strip_prefix(&prefix).is_none() {
            return Err(format!(
                "agent-run planning assignment path drift: {}",
                strict.assignment_id.0
            ));
        }
        let expected_action = format!("action-{}", strict.assignment_id.0);
        if strict.action_id.0 != expected_action {
            return Err(format!(
                "agent-run planning action drift: expected {expected_action}, got {}",
                strict.action_id.0
            ));
        }
        if strict.lane_id.is_some()
            || strict.attempt.is_some()
            || strict.base_commit.is_some()
            || strict.worktree.is_some()
            || strict.required_focused_evidence.is_some()
        {
            return Err("agent-run planning spec contains delivery identity fields".to_owned());
        }
        return Ok(());
    }
    if matches!(
        strict.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Validation
    ) {
        return validate_validation_spec_identity_for_receipt_v1(strict);
    }
    let lane_id = strict
        .lane_id
        .as_ref()
        .ok_or_else(|| "agent-run missing lane_id".to_owned())?;
    let attempt = strict
        .attempt
        .ok_or_else(|| "agent-run missing attempt".to_owned())?;
    let base_commit = strict
        .base_commit
        .as_ref()
        .ok_or_else(|| "agent-run missing base_commit".to_owned())?;
    let worktree = strict
        .worktree
        .as_ref()
        .ok_or_else(|| "agent-run missing worktree".to_owned())?;
    let required = strict
        .required_focused_evidence
        .ok_or_else(|| "agent-run missing focused evidence requirement".to_owned())?;
    let assignment_path = strict
        .assignment_path
        .as_ref()
        .ok_or_else(|| "agent-run delivery missing assignment_path".to_owned())?;
    let assignment_digest = strict
        .assignment_digest
        .as_ref()
        .ok_or_else(|| "agent-run delivery missing assignment_digest".to_owned())?;
    if attempt == 0 || base_commit.0.trim().is_empty() || required == 0 {
        return Err("agent-run delivery lane/attempt/base requirement drift".to_owned());
    }
    if worktree.0 != strict.cwd.0 {
        return Err(format!(
            "agent-run worktree/cwd drift: worktree={} cwd={}",
            worktree.0, strict.cwd.0
        ));
    }
    let expected =
        super::expected_delivery_identity(&strict.workstream, lane_id, &strict.role_id, attempt)
            .map_err(|error| error.to_string())?;
    if strict.assignment_id != expected.assignment_id || strict.action_id != expected.action_id {
        return Err(format!(
            "agent-run delivery action/assignment drift: expected {}/{}, got {}/{}",
            expected.action_id.0,
            expected.assignment_id.0,
            strict.action_id.0,
            strict.assignment_id.0
        ));
    }
    let bytes = super::read_bounded_file(
        Path::new(&assignment_path.0),
        super::DELIVERY_ASSIGNMENT_MAX_BYTES,
    )
    .map_err(|error| format!("agent-run delivery assignment read: {error}"))?;
    if sha256_hex(&bytes) != assignment_digest.0 {
        return Err("agent-run delivery assignment digest drift".to_owned());
    }
    let artifact = super::read_delivery_assignment_artifact(&bytes)?;
    validate_delivery_context_digest(
        &strict.context_digest.0,
        &artifact,
        required,
        &assignment_path.0,
        &assignment_digest.0,
    )?;
    match artifact {
        super::DeliveryAssignmentArtifactReader::V3(artifact) => {
            validate_delivery_assignment_artifact(
                strict,
                &artifact,
                lane_id,
                attempt,
                base_commit,
                worktree,
            )?
        }
        super::DeliveryAssignmentArtifactReader::V4(artifact) => {
            if artifact.workstream != strict.workstream
                || artifact.assignment_id != strict.assignment_id
                || artifact.lane_id != *lane_id
                || artifact.attempt != attempt
                || artifact.base_commit != *base_commit
                || artifact.worktree != worktree.0
                || artifact.ordered_units.is_empty()
            {
                return Err("agent-run V4 delivery assignment authority drift".to_owned());
            }
            super::validate_delivery_recovery_binding(
                &strict.role_id,
                &strict.mode,
                attempt,
                artifact.recovery.as_ref(),
            )?;
            super::materializer_v4::replay_v4_materialization(&artifact)?;
        }
    }
    Ok(())
}

fn validate_delivery_context_digest(
    actual: &str,
    artifact: &super::DeliveryAssignmentArtifactReader,
    required_focused_evidence: u32,
    assignment_path: &str,
    assignment_digest: &str,
) -> Result<(), String> {
    let (version, expected) = match artifact {
        super::DeliveryAssignmentArtifactReader::V3(artifact) => (
            "V3",
            super::delivery_context_digest_v3(
                artifact,
                required_focused_evidence,
                assignment_path,
                assignment_digest,
            )
            .map_err(|error| error.to_string())?,
        ),
        super::DeliveryAssignmentArtifactReader::V4(artifact) => (
            "V4",
            super::delivery_context_digest_v4(artifact, assignment_path, assignment_digest)
                .map_err(|error| error.to_string())?,
        ),
    };
    if actual != expected {
        return Err(format!("agent-run {version} delivery context digest drift"));
    }
    Ok(())
}

fn validate_delivery_assignment_artifact(
    strict: &AgentRunSpec,
    artifact: &super::DeliveryAssignmentArtifact,
    lane_id: &kernel::generated::Id,
    attempt: u32,
    base_commit: &kernel::generated::Sha,
    worktree: &kernel::generated::Path,
) -> Result<(), String> {
    if artifact.schema != "autopilot.delivery_assignment.v3"
        || artifact.workstream != strict.workstream
        || artifact.assignment_id != strict.assignment_id
        || artifact.lane_id != *lane_id
        || artifact.attempt != attempt
        || artifact.base_commit != *base_commit
        || artifact.worktree != worktree.0
        || artifact.ordered_units.is_empty()
    {
        return Err("agent-run delivery assignment authority drift".to_owned());
    }
    super::validate_delivery_recovery_binding(
        &strict.role_id,
        &strict.mode,
        attempt,
        artifact.recovery.as_ref(),
    )?;
    super::validate_approved_command_bindings(artifact)?;
    let mut previous = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for unit in &artifact.ordered_units {
        if !ids.insert(unit.id.clone()) {
            return Err(format!("agent-run delivery duplicate unit: {}", unit.id.0));
        }
        if unit.kind != kernel::generated::PlanUnitKind::Implementation
            || unit.objective.trim().is_empty()
            || unit.criteria.is_empty()
            || unit.criterion_text.is_empty()
            || unit.files.is_empty()
            || unit.commands.is_empty()
        {
            return Err(format!(
                "agent-run delivery unit authority incomplete: {}",
                unit.id.0
            ));
        }
        crate::allocation::validate_exact_unit_file_authority(&unit.files).map_err(|error| {
            format!(
                "agent-run delivery unit has invalid exact file authority: {}: {error}",
                unit.id.0
            )
        })?;
        let criterion_ids = unit
            .criterion_text
            .iter()
            .map(|criterion| criterion.id.clone())
            .collect::<Vec<_>>();
        if criterion_ids != unit.criteria {
            return Err(format!("agent-run delivery criteria drift: {}", unit.id.0));
        }
        let mut criteria = BTreeSet::new();
        for criterion in &unit.criterion_text {
            if criterion.text.trim().is_empty() || !criteria.insert(criterion.id.clone()) {
                return Err(format!(
                    "agent-run delivery malformed criterion {}:{}",
                    unit.id.0, criterion.id.0
                ));
            }
        }
        for dep in &unit.dependencies {
            if dep == &unit.id {
                return Err(format!("agent-run delivery self dependency: {}", unit.id.0));
            }
            if artifact
                .ordered_units
                .iter()
                .any(|candidate| candidate.id == *dep)
                && !previous.contains(dep)
            {
                return Err(format!(
                    "agent-run delivery unit {} precedes dependency {}",
                    unit.id.0, dep.0
                ));
            }
        }
        for command in &unit.commands {
            crate::allocation::validate_plan_unit_command_effect_authority(command).map_err(
                |error| {
                    format!(
                        "agent-run delivery malformed command authority: {}: {error}",
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
                "agent-run delivery malformed package-check authority: {}: {error}",
                unit.id.0
            )
        })?;
        previous.insert(unit.id.clone());
    }
    crate::allocation::validate_exact_plan_file_union(
        artifact
            .ordered_units
            .iter()
            .flat_map(|unit| unit.files.iter()),
    )
    .map_err(|error| format!("agent-run delivery plan file authority drift: {error}"))?;
    Ok(())
}

fn validate_validation_spec_identity_for_receipt_v1(strict: &AgentRunSpec) -> Result<(), String> {
    if strict.boundary_id.0 == "autopilot.validation_submission.v3"
        && strict.result_contract.0 == "autopilot.validation_result.v3"
    {
        return validate_validation_spec_identity_v3_receipt(strict);
    }
    match (
        strict.boundary_id.0.as_str(),
        strict.result_contract.0.as_str(),
    ) {
        ("autopilot.validation_submission.v2", "autopilot.validation_result.v2") => {
            validate_validation_spec_identity_v2(strict)
        }
        _ => Err("agent-run validation issued boundary/result tuple is unknown".to_owned()),
    }
}

fn validate_validation_spec_identity_v2(strict: &AgentRunSpec) -> Result<(), String> {
    let assignment_path = strict
        .assignment_path
        .as_ref()
        .ok_or_else(|| "agent-run validation missing assignment_path".to_owned())?;
    let assignment_digest = strict
        .assignment_digest
        .as_ref()
        .ok_or_else(|| "agent-run validation missing assignment_digest".to_owned())?;
    let context_path = strict
        .context_manifest_path
        .as_ref()
        .ok_or_else(|| "agent-run validation missing context_manifest_path".to_owned())?;
    let context_digest = strict
        .context_manifest_digest
        .as_ref()
        .ok_or_else(|| "agent-run validation missing context_manifest_digest".to_owned())?;
    let model_submission_path = strict
        .model_submission_path
        .as_ref()
        .ok_or_else(|| "agent-run validation missing model_submission_path".to_owned())?;
    let expected_submission = Path::new(&assignment_path.0)
        .parent()
        .ok_or_else(|| "agent-run validation assignment path has no parent".to_owned())?
        .join("model-submission.json");
    if Path::new(&model_submission_path.0) != expected_submission {
        return Err("agent-run validation model submission path drift".to_owned());
    }
    for path in [
        PathBuf::from(&model_submission_path.0),
        PathBuf::from(&strict.carrier_path.0).with_extension("tool-audit.json"),
    ] {
        super::reject_link_components_for_path(&path).map_err(|error| error.to_string())?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => {
                return Err(format!(
                    "agent-run validation stale package output refused at {}",
                    path.display()
                ));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let assignment_bytes =
        super::read_bounded_file(Path::new(&assignment_path.0), MAX_VALIDATION_ARTIFACT_BYTES)
            .map_err(|error| format!("agent-run validation assignment read failed: {error}"))?;
    let context_bytes =
        super::read_bounded_file(Path::new(&context_path.0), MAX_VALIDATION_ARTIFACT_BYTES)
            .map_err(|error| format!("agent-run validation context read failed: {error}"))?;
    if sha256_hex(&assignment_bytes) != assignment_digest.0 {
        return Err("agent-run validation assignment digest drift".to_owned());
    }
    if sha256_hex(&context_bytes) != context_digest.0 {
        return Err("agent-run validation context digest drift".to_owned());
    }
    if strict
        .producer_assignment_ids
        .as_ref()
        .is_none_or(Vec::is_empty)
        || strict
            .validation_id
            .as_ref()
            .is_none_or(|id| id.0.trim().is_empty())
        || strict.validation_attempt.is_none_or(|attempt| attempt == 0)
        || strict.semantic_round.is_none_or(|round| round == 0)
    {
        return Err("agent-run validation identity fields are incomplete".to_owned());
    }
    let assignment: kernel::generated::ValidationAssignmentV2 =
        serde_json::from_slice(&assignment_bytes)
            .map_err(|error| format!("agent-run validation assignment malformed: {error}"))?;
    let context: kernel::generated::ValidationContextV2 = serde_json::from_slice(&context_bytes)
        .map_err(|error| format!("agent-run validation context malformed: {error}"))?;
    validate_validation_context_command_authority(&context).map_err(|error| {
        format!("agent-run validation context malformed command authority: {error}")
    })?;
    if assignment.action_id != strict.action_id
        || assignment.assignment_id != strict.assignment_id
        || assignment.workstream != strict.workstream
        || assignment.run_revision != strict.run_revision
        || assignment.role_id != strict.role_id
        || assignment.mode != strict.mode
        || Some(&assignment.validation_id) != strict.validation_id.as_ref()
        || Some(assignment.validation_attempt) != strict.validation_attempt
        || Some(assignment.semantic_round) != strict.semantic_round
        || Some(&assignment.producer_assignment_ids) != strict.producer_assignment_ids.as_ref()
        || assignment.candidate_root.0 != strict.cwd.0
        || context.validation_id != assignment.validation_id
        || context.assignment_id != assignment.assignment_id
        || context.exact_commit != assignment.exact_commit
        || context.exact_tree != assignment.exact_tree
        || context.candidate.source_root != assignment.candidate_root
    {
        return Err("agent-run validation assignment/context identity drift".to_owned());
    }
    let candidate = Path::new(&strict.cwd.0);
    let head = super::git_stdout_checked(candidate, &["rev-parse", "--verify", "HEAD^{commit}"])
        .map_err(|error| format!("agent-run validation candidate HEAD: {error}"))?;
    let tree = super::git_stdout_checked(candidate, &["rev-parse", "--verify", "HEAD^{tree}"])
        .map_err(|error| format!("agent-run validation candidate tree: {error}"))?;
    if head.trim() != assignment.exact_commit.0 || tree.trim() != assignment.exact_tree.0 {
        return Err("agent-run validation candidate commit/tree drift before prompt".to_owned());
    }
    Ok(())
}

/// Receipt_v1 V3 validation has a closed V4 assignment with no historical
/// `max_value_attempts` field. Do not route this through the V3 reader: that
/// would silently make a legacy repair-loop policy fresh authority.
fn validate_validation_spec_identity_v3_receipt(strict: &AgentRunSpec) -> Result<(), String> {
    let assignment_path = strict
        .assignment_path
        .as_ref()
        .ok_or_else(|| "agent-run receipt_v1 v3 validation missing assignment_path".to_owned())?;
    let assignment_digest = strict
        .assignment_digest
        .as_ref()
        .ok_or_else(|| "agent-run receipt_v1 v3 validation missing assignment_digest".to_owned())?;
    let context_path = strict.context_manifest_path.as_ref().ok_or_else(|| {
        "agent-run receipt_v1 v3 validation missing context_manifest_path".to_owned()
    })?;
    let context_digest = strict.context_manifest_digest.as_ref().ok_or_else(|| {
        "agent-run receipt_v1 v3 validation missing context_manifest_digest".to_owned()
    })?;
    let model_submission_path = strict.model_submission_path.as_ref().ok_or_else(|| {
        "agent-run receipt_v1 v3 validation missing model_submission_path".to_owned()
    })?;
    let artifact_root = Path::new(&assignment_path.0)
        .parent()
        .ok_or_else(|| "agent-run receipt_v1 v3 assignment path has no parent".to_owned())?;
    let expected_assignment = artifact_root.join("assignment.v4.json");
    let expected_context = artifact_root.join("context.v3.json");
    let expected_authority = artifact_root.join("authority.v3.json");
    let expected_submission = artifact_root.join("model-submission.v3.json");
    if Path::new(&assignment_path.0) != expected_assignment
        || Path::new(&context_path.0) != expected_context
        || Path::new(&model_submission_path.0) != expected_submission
    {
        return Err("agent-run receipt_v1 v3 validation artifact path drift".to_owned());
    }
    for path in [
        PathBuf::from(&model_submission_path.0),
        PathBuf::from(&strict.carrier_path.0).with_extension("tool-audit.json"),
    ] {
        super::reject_link_components_for_path(&path).map_err(|error| error.to_string())?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => {
                return Err(format!(
                    "agent-run receipt_v1 v3 stale package output refused at {}",
                    path.display()
                ));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let assignment_bytes = super::read_bounded_file(
        Path::new(&assignment_path.0),
        kernel::generated::VALIDATION_ASSIGNMENT_V4_MAX_BYTES,
    )
    .map_err(|error| format!("agent-run receipt_v1 V4 assignment read: {error}"))?;
    let context_bytes = super::read_bounded_file(
        Path::new(&context_path.0),
        kernel::generated::VALIDATION_CONTEXT_V3_MAX_BYTES,
    )
    .map_err(|error| format!("agent-run receipt_v1 V3 context read: {error}"))?;
    if sha256_hex(&assignment_bytes) != assignment_digest.0
        || sha256_hex(&context_bytes) != context_digest.0
    {
        return Err("agent-run receipt_v1 v3 assignment/context digest drift".to_owned());
    }
    let assignment: kernel::generated::ValidationAssignmentV4 =
        serde_json::from_slice(&assignment_bytes)
            .map_err(|error| format!("agent-run receipt_v1 V4 assignment JSON: {error}"))?;
    let context: kernel::generated::ValidationContextV3 = serde_json::from_slice(&context_bytes)
        .map_err(|error| format!("agent-run receipt_v1 V3 context JSON: {error}"))?;
    if serde_json::to_vec_pretty(&assignment).map_err(|error| error.to_string())?
        != assignment_bytes
        || serde_json::to_vec_pretty(&context).map_err(|error| error.to_string())? != context_bytes
    {
        return Err(
            "agent-run receipt_v1 v3 validation artifacts are not canonical bytes".to_owned(),
        );
    }
    let validation_id = strict
        .validation_id
        .as_ref()
        .ok_or_else(|| "agent-run receipt_v1 v3 validation missing validation_id".to_owned())?;
    let producer_ids = strict
        .producer_assignment_ids
        .as_ref()
        .ok_or_else(|| "agent-run receipt_v1 v3 validation missing producer ids".to_owned())?;
    let base_commit = strict
        .base_commit
        .as_ref()
        .ok_or_else(|| "agent-run receipt_v1 v3 validation missing base commit".to_owned())?;
    if assignment.schema.0 != "autopilot.validation_assignment.v4"
        || assignment.admission_mode != kernel::generated::AdmissionMode::ReceiptV1
        || assignment.action_id != strict.action_id
        || assignment.assignment_id != strict.assignment_id
        || assignment.workstream != strict.workstream
        || assignment.run_revision != strict.run_revision
        || assignment.role_id != strict.role_id
        || assignment.mode != strict.mode
        || assignment.validation_id != *validation_id
        || Some(assignment.validation_attempt) != strict.validation_attempt
        || Some(assignment.semantic_round) != strict.semantic_round
        || assignment.producer_assignment_ids != *producer_ids
        || assignment.producer_assignment_ids.is_empty()
        || assignment.base_commit.0 != base_commit.0
        || assignment.candidate_root.0 != strict.cwd.0
        || strict.worktree.as_ref().map(|path| path.0.as_str()) != Some(strict.cwd.0.as_str())
        || assignment.context_path != *context_path
        || assignment.context_digest != *context_digest
        || Path::new(&assignment.authority_path.0) != expected_authority
        || strict.validation_attempt.is_none_or(|attempt| attempt == 0)
        || strict.semantic_round.is_none_or(|round| round == 0)
        || strict.lane_id.is_none()
        || strict.attempt.is_none_or(|attempt| attempt == 0)
        || strict.required_focused_evidence != Some(1)
    {
        return Err(
            "agent-run receipt_v1 V4 assignment/spec identity or authority drift".to_owned(),
        );
    }
    let expected_key = sha256_hex(
        format!(
            "validation.v3\0{}\0{}\0{}",
            assignment.validation_id.0, assignment.exact_commit.0, assignment.exact_tree.0
        )
        .as_bytes(),
    );
    if assignment.validation_key.0 != expected_key {
        return Err("agent-run receipt_v1 v3 validation key drift".to_owned());
    }
    let expectation = crate::runner::validation_authority::ValidationAuthorityExpectation {
        validation_id: &assignment.validation_id,
        assignment_id: &assignment.assignment_id,
        base_commit: &assignment.base_commit,
        exact_commit: &assignment.exact_commit,
        exact_tree: &assignment.exact_tree,
        candidate_root: Path::new(&strict.cwd.0),
    };
    let index = crate::runner::validation_authority::ValidationAuthorityIndex::load_for(
        Path::new(&assignment.authority_path.0),
        &assignment.authority_digest.0,
        &expectation,
    )
    .map_err(validation_failure_text)?;
    if index.context_projection() != context
        || context.validation_id != assignment.validation_id
        || context.assignment_id != assignment.assignment_id
        || context.authority_digest != assignment.authority_digest
    {
        return Err(
            "agent-run receipt_v1 V3 context is not the exact authority projection".to_owned(),
        );
    }
    Ok(())
}

fn validation_failure_text(
    failure: crate::runner::validation_authority::AdmissionFailure,
) -> String {
    match failure.canonical_bytes() {
        Ok(bytes) => String::from_utf8(bytes)
            .unwrap_or_else(|error| format!("non-UTF-8 validation diagnostic: {error}")),
        Err(error) => format!("validation diagnostic invariant failed: {error}"),
    }
}

fn validate_planning_documents(strict: &AgentRunSpec) -> Result<(), String> {
    if !matches!(
        strict.assignment_kind,
        kernel::generated::ValidationAssignmentKind::PlanningReview
    ) {
        if strict.authority_set_id.is_some()
            || strict.authority_documents.is_some()
            || strict.context_document.is_some()
            || strict.context_documents.is_some()
        {
            return Err(
                "agent-run non-planning spec contains planning document bindings".to_owned(),
            );
        }
        return Ok(());
    }
    let authority_set_id = strict
        .authority_set_id
        .as_ref()
        .ok_or_else(|| "agent-run missing authority_set_id".to_owned())?;
    if authority_set_id.trim().is_empty() {
        return Err("agent-run empty authority_set_id".to_owned());
    }
    let docs = strict
        .authority_documents
        .as_ref()
        .ok_or_else(|| "agent-run missing authority documents".to_owned())?;
    if docs.is_empty() {
        return Err("agent-run missing authority documents".to_owned());
    }
    for doc in docs {
        validate_doc(doc, "authority", authority_set_id)?;
    }
    let context = strict
        .context_document
        .as_ref()
        .ok_or_else(|| "agent-run missing context document".to_owned())?;
    validate_doc(context, "context/non-authority", authority_set_id)?;
    let context_documents = strict
        .context_documents
        .as_ref()
        .ok_or_else(|| "agent-run missing context documents".to_owned())?;
    if context_documents.is_empty() {
        return Err("agent-run missing context documents".to_owned());
    }
    if context_documents.first() != Some(context) {
        return Err("agent-run context_document alias drift".to_owned());
    }
    for document in context_documents {
        validate_doc(document, "context/non-authority", authority_set_id)?;
    }
    Ok(())
}

fn validate_planning_atom_bindings(strict: &AgentRunSpec) -> Result<(), String> {
    if !matches!(
        strict.assignment_kind,
        kernel::generated::ValidationAssignmentKind::PlanningReview
    ) {
        if strict.atom_id_prefix.is_some()
            || strict.atom_registry_path.is_some()
            || strict.atom_registry_digest.is_some()
        {
            return Err("agent-run non-planning spec contains atom bindings".to_owned());
        }
        return Ok(());
    }
    match strict.boundary_id.0.as_str() {
        "planning.task-atoms.v1" => {
            let prefix = strict
                .atom_id_prefix
                .as_deref()
                .ok_or_else(|| "agent-run task atoms missing atom_id_prefix".to_owned())?;
            if prefix.trim().is_empty() {
                return Err("agent-run task atoms empty atom_id_prefix".to_owned());
            }
            if strict.atom_registry_path.is_some() || strict.atom_registry_digest.is_some() {
                return Err("agent-run task atoms cannot bind atom registry".to_owned());
            }
        }
        "planning.work-map.v1" | "planning.work-map.v2" => {
            if strict.atom_id_prefix.is_some() {
                return Err("agent-run work-map cannot bind atom_id_prefix".to_owned());
            }
            let (path, digest) = atom_registry_binding_for_spec(strict)?;
            crate::planning::load_atom_registry_ids(Path::new(path), digest)
                .map_err(|error| format!("agent-run work-map atom registry invalid: {error:?}"))?;
        }
        _ => {
            if strict.atom_id_prefix.is_some()
                || strict.atom_registry_path.is_some()
                || strict.atom_registry_digest.is_some()
            {
                return Err(
                    "agent-run non atom/work-map planning spec has atom bindings".to_owned(),
                );
            }
        }
    }
    Ok(())
}

fn atom_registry_binding_for_spec(spec: &AgentRunSpec) -> Result<(&str, &str), String> {
    let path = spec
        .atom_registry_path
        .as_ref()
        .map(|path| path.0.as_str())
        .ok_or_else(|| "agent-run work-map missing atom_registry_path".to_owned())?;
    let digest = spec
        .atom_registry_digest
        .as_ref()
        .map(|digest| digest.0.as_str())
        .ok_or_else(|| "agent-run work-map missing atom_registry_digest".to_owned())?;
    if path.trim().is_empty() || digest.trim().is_empty() {
        return Err("agent-run work-map empty atom registry binding".to_owned());
    }
    Ok((path, digest))
}

fn validate_doc(
    doc: &TaskDocument,
    expected_class: &str,
    authority_set_id: &str,
) -> Result<(), String> {
    if doc.class.0 != expected_class
        || doc.path.0.trim().is_empty()
        || doc.digest.0.trim().is_empty()
        || doc.body.trim().is_empty()
    {
        return Err(format!(
            "agent-run task document drift for class {expected_class}"
        ));
    }
    let digest = sha256_hex(doc.body.as_bytes());
    if digest != doc.body_digest.0 {
        return Err(format!(
            "agent-run task document body digest drift for {}",
            doc.path.0
        ));
    }
    let file_digest = task_document_digest(expected_class, authority_set_id, &doc.body);
    if file_digest != doc.digest.0 {
        return Err(format!(
            "agent-run task document file digest drift for {}",
            doc.path.0
        ));
    }
    Ok(())
}

fn task_document_digest(class: &str, authority_set_id: &str, body: &str) -> String {
    let marker = match class {
        "authority" => "[authority]",
        "context/non-authority" => "[context/non-authority]",
        other => other,
    };
    sha256_hex(format!("{marker}\nauthority_set_id: {authority_set_id}\n\n{body}").as_bytes())
}

fn sha_json(value: &impl serde::Serialize) -> Result<String, String> {
    serde_json::to_vec(value)
        .map(|data| sha256_hex(&data))
        .map_err(|error| error.to_string())
}

fn value_rejection(
    field: impl Into<String>,
    expected: impl Into<String>,
    got: impl Into<String>,
) -> ValueRejection {
    ValueRejection {
        field: field.into(),
        expected: expected.into(),
        got: got.into(),
    }
}

/// Reusable Core-side V5 child admission. The Host supplies the untouched
/// raw pre-schema JSON tree and separate generated runtime evidence; all
/// profile, boundary, schema, and carrier-binding facts are derived from the
/// authenticated V5 spec facade. This never writes a carrier, audit, model
/// submission, or receipt.
#[allow(dead_code)]
pub(crate) fn admit_submission(
    spec_path: &Path,
    spec_bytes: &str,
    spec_digest: &str,
    spec: &AgentRunSpec,
    required_pi_version: &str,
    raw_payload: Value,
    runtime_evidence: ChildControlRuntimeEvidence,
    tool_call_id: String,
) -> Result<PreparedCarrier, AdmissionFailure> {
    admit_submission_with_admission(
        spec_path,
        spec_bytes,
        spec_digest,
        spec,
        required_pi_version,
        raw_payload,
        runtime_evidence,
        tool_call_id,
    )
}

/// Fresh ChildControl is explicitly receipt_v1. Keeping this separate from
/// the historical entry prevents a V4 validator assignment from ever being
/// read by the replay_v0 V3 admission/diagnostic path.
pub(crate) fn admit_receipt_v1_submission(
    spec_path: &Path,
    spec_bytes: &str,
    spec_digest: &str,
    spec: &AgentRunSpec,
    required_pi_version: &str,
    raw_payload: Value,
    runtime_evidence: ChildControlRuntimeEvidence,
    tool_call_id: String,
) -> Result<PreparedCarrier, AdmissionFailure> {
    admit_submission_with_admission(
        spec_path,
        spec_bytes,
        spec_digest,
        spec,
        required_pi_version,
        raw_payload,
        runtime_evidence,
        tool_call_id,
    )
}

fn admit_submission_with_admission(
    spec_path: &Path,
    spec_bytes: &str,
    spec_digest: &str,
    spec: &AgentRunSpec,
    required_pi_version: &str,
    raw_payload: Value,
    runtime_evidence: ChildControlRuntimeEvidence,
    tool_call_id: String,
) -> Result<PreparedCarrier, AdmissionFailure> {
    if contains_placeholder_sentinel(&raw_payload) {
        return Err(AdmissionFailure::PlaceholderLeaked);
    }
    let profile = super::terminal_profile_for(
        &spec.role_id.0,
        &spec.boundary_id.0,
        &spec.result_contract.0,
    )
    .map_err(|error| AdmissionFailure::Authority(error.to_string()))?;
    let (delivery_policy_denials, approved_command_executions) =
        map_runtime_evidence_into_tool_details(spec, runtime_evidence)?;
    let terminal = ToolTerminal {
        tool_name: profile.1.to_owned(),
        tool_call_id,
        details: ToolCarrierDetails {
            profile_id: profile.0.to_owned(),
            tool_name: profile.1.to_owned(),
            boundary_id: profile.2.to_owned(),
            result_contract: profile.3.to_owned(),
            schema_digest: profile.4.to_owned(),
            binding: carrier_binding(spec),
            payload: raw_payload.clone(),
            // Runtime evidence is a generated closed carrier beside the raw
            // model payload. It is never merged into or inferred from it.
            delivery_policy_denials,
            approved_command_executions,
        },
        details_value: raw_payload,
    };
    let mut prepared = prepare_carrier(
        spec_path,
        spec_bytes,
        spec_digest,
        spec,
        &CarrierSource::Tool(terminal),
    )
    .map_err(|error| match error {
        CarrierRejection::Identity(detail) => AdmissionFailure::Authority(detail),
        CarrierRejection::Value(value) => AdmissionFailure::Value {
            field: value.field,
            expected: value.expected,
            actual: value.got,
        },
    })?;
    // Planning carriers retain their pre-existing package-observed Pi field.
    // Delivery/Validator generated result contracts are closed and do not
    // admit that field; their V5 spec is the exact receipt-bound Pi authority.
    if matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::PlanningReview
    ) {
        let carrier = prepared.carrier.as_object_mut().ok_or_else(|| {
            AdmissionFailure::Authority("prepared receipt carrier is not an object".to_owned())
        })?;
        carrier.insert(
            "pi_version".to_owned(),
            serde_json::Value::String(required_pi_version.to_owned()),
        );
    }
    Ok(prepared)
}

fn map_runtime_evidence_into_tool_details(
    spec: &AgentRunSpec,
    runtime_evidence: ChildControlRuntimeEvidence,
) -> Result<(Option<Value>, Option<Value>), AdmissionFailure> {
    if runtime_evidence.schema.0 != "autopilot.child_control_runtime_evidence.v1" {
        return Err(AdmissionFailure::Authority(
            "child-control runtime evidence schema drift".to_owned(),
        ));
    }
    let is_delivery = matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Delivery
    );
    match (
        runtime_evidence.delivery_policy_denials.0,
        runtime_evidence.approved_command_executions.0,
        is_delivery,
    ) {
        (None, None, false) => Ok((None, None)),
        (Some(_), _, false) | (_, Some(_), false) => Err(AdmissionFailure::Authority(
            "child-control runtime evidence must use explicit null delivery ledgers outside delivery"
                .to_owned(),
        )),
        (Some(denials), Some(executions), true) => {
            let denials = serde_json::to_value(denials).map_err(|error| {
                AdmissionFailure::Authority(format!(
                    "child-control runtime denial ledger serialization failed: {error}"
                ))
            })?;
            let executions = serde_json::to_value(executions).map_err(|error| {
                AdmissionFailure::Authority(format!(
                    "child-control runtime execution ledger serialization failed: {error}"
                ))
            })?;
            Ok((Some(denials), Some(executions)))
        }
        (None, _, true) | (_, None, true) => Err(AdmissionFailure::Value {
            field: "runtime_evidence".to_owned(),
            expected: "both delivery runtime ledgers".to_owned(),
            actual: "missing explicit delivery ledger".to_owned(),
        }),
    }
}

fn contains_placeholder_sentinel(value: &Value) -> bool {
    const SENTINEL: &str = "__autopilot_child_control_placeholder__:";
    match value {
        Value::String(text) => text.starts_with(SENTINEL),
        Value::Array(items) => items.iter().any(contains_placeholder_sentinel),
        Value::Object(items) => items.values().any(contains_placeholder_sentinel),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn prepare_carrier(
    spec_path: &Path,
    spec_bytes: &str,
    spec_digest: &str,
    spec: &AgentRunSpec,
    source: &CarrierSource,
) -> Result<PreparedCarrier, CarrierRejection> {
    let CarrierSource::Tool(terminal) = source;
    let profile = super::terminal_profile_for(
        &spec.role_id.0,
        &spec.boundary_id.0,
        &spec.result_contract.0,
    )
    .map_err(|error| CarrierRejection::Identity(error.to_string()))?;
    let expected_binding = carrier_binding(spec);
    if spec.terminal_profile_id.as_deref() != Some(profile.0)
        || terminal.tool_name != profile.1
        || terminal.details.profile_id != profile.0
        || terminal.details.tool_name != profile.1
        || terminal.details.boundary_id != profile.2
        || terminal.details.result_contract != profile.3
        || terminal.details.schema_digest != profile.4
        || terminal.details.binding != expected_binding
    {
        return Err(CarrierRejection::Identity(format!(
            "terminal profile identity drift: expected {profile:?}/{expected_binding}, got {terminal:?}"
        )));
    }
    let raw_bytes =
        crate::evidence::canonical_json(&terminal.details.payload).map_err(|error| {
            CarrierRejection::Value(value_rejection(
                "payload",
                "canonical JSON tool payload",
                error.to_string(),
            ))
        })?;
    let raw_output = String::from_utf8(raw_bytes).map_err(|error| {
        CarrierRejection::Identity(format!("canonical JSON payload UTF-8: {error}"))
    })?;
    if matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Delivery
    ) {
        let submission: kernel::generated::DeliverySubmissionV2 =
            serde_json::from_value(terminal.details.payload.clone()).map_err(|error| {
                value_rejection(
                    "payload",
                    "closed autopilot.delivery_submission.v2",
                    error.to_string(),
                )
            })?;
        validate_delivery_submission(spec, &submission)?;
        return package_tool_result(
            spec_path,
            spec_bytes,
            spec_digest,
            spec,
            terminal,
            serde_json::to_value(&submission).map_err(|error| {
                value_rejection(
                    "payload",
                    "serializable delivery submission",
                    error.to_string(),
                )
            })?,
            "autopilot.delivery_result.v2",
            false,
        )
        .map_err(Into::into);
    }
    if matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Validation
    ) {
        if spec.boundary_id.0 == "autopilot.validation_submission.v2" {
            let submission: kernel::generated::ValidationSubmissionV2 =
                serde_json::from_value(terminal.details.payload.clone()).map_err(|error| {
                    value_rejection(
                        "payload",
                        "closed autopilot.validation_submission.v2",
                        error.to_string(),
                    )
                })?;
            validate_validation_submission(spec, &submission)?;
            return package_tool_result(
                spec_path,
                spec_bytes,
                spec_digest,
                spec,
                terminal,
                serde_json::to_value(&submission).map_err(|error| {
                    value_rejection(
                        "payload",
                        "serializable validation submission",
                        error.to_string(),
                    )
                })?,
                "autopilot.validation_result.v2",
                false,
            )
            .map_err(Into::into);
        }
        if spec.boundary_id.0 == "autopilot.validation_submission.v3" {
            let validation_attempt = spec.validation_attempt.ok_or_else(|| {
                CarrierRejection::Identity(
                    "receipt_v1 V3 validation lacks an issued validation_attempt".to_owned(),
                )
            })?;
            let (submission, admitted) = match admit_validation_submission_v3_receipt(
                spec,
                &terminal.details.payload,
                validation_attempt,
            ) {
                Ok(value) => value,
                Err(ValidationV3AdmissionError::Value(rejection)) => {
                    return Err(rejection.into());
                }
                Err(ValidationV3AdmissionError::Fatal(detail)) => {
                    return Err(CarrierRejection::Identity(detail));
                }
            };
            let canonical_submission = serde_json::to_value(&submission).map_err(|error| {
                CarrierRejection::Identity(format!(
                    "canonical v3 submission serialization failed: {error}"
                ))
            })?;
            let mut prepared = package_tool_result(
                spec_path,
                spec_bytes,
                spec_digest,
                spec,
                terminal,
                canonical_submission,
                "autopilot.validation_result.v3",
                true,
            )
            .map_err(|rejection| {
                CarrierRejection::Identity(format!(
                    "v3 carrier/audit persistence or provenance failure: field={} expected={} got={}",
                    rejection.field, rejection.expected, rejection.got
                ))
            })?;
            let object = prepared
                .carrier
                .as_object_mut()
                .expect("v3 validation carrier object");
            object.insert(
                "verdict_digest".to_owned(),
                serde_json::json!(sha256_hex(&admitted.verdict_bytes)),
            );
            object.insert(
                "verdict".to_owned(),
                serde_json::to_value(admitted.verdict).map_err(|error| {
                    CarrierRejection::Identity(format!(
                        "normalized v3 verdict serialization failed: {error}"
                    ))
                })?,
            );
            let _: kernel::generated::ValidationResultV3 =
                serde_json::from_value(prepared.carrier.clone()).map_err(|error| {
                    CarrierRejection::Identity(format!(
                        "generated closed v3 carrier rejected package output: {error}"
                    ))
                })?;
            return Ok(prepared);
        }
        return Err(value_rejection(
            "boundary_id",
            "issued v2 or v3 validation boundary",
            spec.boundary_id.0.clone(),
        )
        .into());
    }
    crate::runner::validate_child_boundary_for_carrier(spec, &raw_output).map_err(|error| {
        match error {
            crate::runner::ChildBoundaryValidationError::Identity(detail) => {
                CarrierRejection::Identity(detail)
            }
            crate::runner::ChildBoundaryValidationError::Value(error) => value_rejection(
                "payload",
                format!("{} admitted value", error.boundary_id()),
                error.actual().to_owned(),
            )
            .into(),
        }
    })?;
    let v2_route = spec
        .terminal_route
        .as_ref()
        .filter(|route| route.version == "v2");
    if spec.boundary_id.0 == "planning.work-map.v2" && v2_route.is_none() {
        return Err(CarrierRejection::Identity(
            "V2 work-map carrier lacks its issued exact route".to_owned(),
        ));
    }
    let carrier_schema = if v2_route.is_some() {
        "autopilot.planning_carrier.v2"
    } else {
        "autopilot.planning_carrier.v1"
    };
    let mut carrier = serde_json::json!({
        "schema": carrier_schema,
        "action_id": spec.action_id.0,
        "assignment_id": spec.assignment_id.0,
        "run_revision": spec.run_revision,
        "workstream": spec.workstream.0,
        "role_id": spec.role_id.0,
        "mode": spec.mode.0,
        "boundary_id": spec.boundary_id.0,
        "result_contract": spec.result_contract.0,
        "prompt_path": spec.prompt_path.0,
        "prompt_digest": spec.prompt_digest.0,
        "boundary_digest": spec.boundary_digest.0,
        "result_contract_digest": spec.result_contract_digest.0,
        "settings_digest": spec.settings_digest.0,
        "context_digest": spec.context_digest.0,
        "skills_digest": spec.skills_digest.0,
        "subscription_digest": spec.subscription_digest.0,
        (RUNTIME_ADDON_DIGEST_FIELD): runtime_addon(spec).map(|(_, value)| &value.0),
        "spec_digest": spec_digest,
        "spec_path": super::path_to_string(spec_path).map_err(|error| {
            value_rejection("spec_path", "absolute runner spec path", error.to_string())
        })?,
        "carrier_path": spec.carrier_path.0,
        "carrier_channel": "tool",
        "tool_name": terminal.tool_name,
        "tool_schema_digest": terminal.details.schema_digest,
        "carrier_binding": terminal.details.binding,
        "raw_output": raw_output,
    });
    if let Some(route) = v2_route {
        let atom_registry_path = spec.atom_registry_path.as_ref().ok_or_else(|| {
            CarrierRejection::Identity("V2 work-map carrier missing atom registry path".to_owned())
        })?;
        let atom_registry_digest = spec.atom_registry_digest.as_ref().ok_or_else(|| {
            CarrierRejection::Identity(
                "V2 work-map carrier missing atom registry digest".to_owned(),
            )
        })?;
        let object = carrier.as_object_mut().expect("planning carrier object");
        object.insert(
            "terminal_route".to_owned(),
            serde_json::to_value(route).map_err(|error| {
                CarrierRejection::Identity(format!(
                    "V2 terminal route serialization failed: {error}"
                ))
            })?,
        );
        object.insert(
            "atom_registry_path".to_owned(),
            serde_json::json!(atom_registry_path.0),
        );
        object.insert(
            "atom_registry_digest".to_owned(),
            serde_json::json!(atom_registry_digest.0),
        );
    }
    Ok(PreparedCarrier {
        carrier,
        artifacts: Vec::new(),
    })
}

fn validate_delivery_submission(
    spec: &AgentRunSpec,
    submission: &kernel::generated::DeliverySubmissionV2,
) -> Result<(), ValueRejection> {
    let required = spec.required_focused_evidence.unwrap_or(0) as usize;
    let assignment_path = spec.assignment_path.as_ref().ok_or_else(|| {
        value_rejection(
            "assignment_path",
            "delivery assignment authority",
            "missing",
        )
    })?;
    let assignment_digest = spec.assignment_digest.as_ref().ok_or_else(|| {
        value_rejection(
            "assignment_digest",
            "delivery assignment digest authority",
            "missing",
        )
    })?;
    let bytes = super::read_bounded_file(
        Path::new(&assignment_path.0),
        super::DELIVERY_ASSIGNMENT_MAX_BYTES,
    )
    .map_err(|error| {
        value_rejection(
            "assignment_path",
            "bounded regular delivery assignment",
            error.to_string(),
        )
    })?;
    if sha256_hex(&bytes) != assignment_digest.0 {
        return Err(value_rejection(
            "assignment_digest",
            "spec-bound delivery assignment digest",
            "digest drift",
        ));
    }
    match super::read_delivery_assignment_artifact(&bytes).map_err(|error| {
        value_rejection("assignment", "schema-selected delivery assignment", error)
    })? {
        super::DeliveryAssignmentArtifactReader::V3(assignment) => {
            super::admit_delivery_submission_with_assignment(submission, &assignment, required)
        }
        super::DeliveryAssignmentArtifactReader::V4(assignment) => {
            super::materializer_v4::admit_delivery_submission_v4(submission, &assignment, required)
        }
    }
    .map_err(|error| {
        value_rejection(
            "delivery_submission",
            "closed succeeded/blocked delivery admission shape",
            error,
        )
    })?;
    Ok(())
}

pub fn admit_validation_submission(
    spec: &AgentRunSpec,
    submission: &kernel::generated::ValidationSubmissionV2,
) -> Result<(), String> {
    validate_validation_submission(spec, submission).map_err(format_value_rejection)
}

pub fn admit_validation_submission_with_authority(
    submission: &kernel::generated::ValidationSubmissionV2,
    assignment: &kernel::generated::ValidationAssignmentV2,
    context: &kernel::generated::ValidationContextV2,
) -> Result<(), String> {
    validate_validation_submission_against(submission, assignment, context)
        .map_err(format_value_rejection)
}

pub fn canonical_validation_submission_v3(
    assignment: &kernel::generated::ValidationAssignmentV3,
    context: &kernel::generated::ValidationContextV3,
    submission: &kernel::generated::ValidationSubmissionV3,
    value_attempt: u32,
) -> Result<(kernel::generated::ValidationSubmissionV3, Vec<u8>), String> {
    let expectation = crate::runner::validation_authority::ValidationAuthorityExpectation {
        validation_id: &assignment.validation_id,
        assignment_id: &assignment.assignment_id,
        base_commit: &assignment.base_commit,
        exact_commit: &assignment.exact_commit,
        exact_tree: &assignment.exact_tree,
        candidate_root: Path::new(&assignment.candidate_root.0),
    };
    let index = crate::runner::validation_authority::ValidationAuthorityIndex::load_for(
        Path::new(&assignment.authority_path.0),
        &assignment.authority_digest.0,
        &expectation,
    )
    .map_err(validation_failure_text)?;
    if index.context_projection() != *context {
        return Err("v3 context is not the exact authority projection".to_owned());
    }
    let admitted = index
        .admit(submission, value_attempt)
        .map_err(validation_failure_text)?;
    let bytes = serde_json::to_vec(&admitted.submission).map_err(|error| error.to_string())?;
    Ok((admitted.submission, bytes))
}

pub fn normalize_validation_submission_v3(
    assignment: &kernel::generated::ValidationAssignmentV3,
    context: &kernel::generated::ValidationContextV3,
    submission: &kernel::generated::ValidationSubmissionV3,
    value_attempt: u32,
) -> Result<(kernel::generated::ValidationVerdictV3, Vec<u8>), String> {
    let expectation = crate::runner::validation_authority::ValidationAuthorityExpectation {
        validation_id: &assignment.validation_id,
        assignment_id: &assignment.assignment_id,
        base_commit: &assignment.base_commit,
        exact_commit: &assignment.exact_commit,
        exact_tree: &assignment.exact_tree,
        candidate_root: Path::new(&assignment.candidate_root.0),
    };
    let index = crate::runner::validation_authority::ValidationAuthorityIndex::load_for(
        Path::new(&assignment.authority_path.0),
        &assignment.authority_digest.0,
        &expectation,
    )
    .map_err(validation_failure_text)?;
    if index.context_projection() != *context {
        return Err("v3 context is not the exact authority projection".to_owned());
    }
    let admitted = index
        .admit(submission, value_attempt)
        .map_err(validation_failure_text)?;
    Ok((admitted.verdict, admitted.verdict_bytes))
}

fn format_value_rejection(rejection: ValueRejection) -> String {
    format!(
        "field={} expected={} got={}",
        rejection.field, rejection.expected, rejection.got
    )
}

fn validate_validation_submission(
    spec: &AgentRunSpec,
    submission: &kernel::generated::ValidationSubmissionV2,
) -> Result<(), ValueRejection> {
    let assignment_path = spec
        .assignment_path
        .as_ref()
        .ok_or_else(|| value_rejection("assignment_path", "validation assignment", "missing"))?;
    let context_path = spec
        .context_manifest_path
        .as_ref()
        .ok_or_else(|| value_rejection("context_manifest_path", "validation context", "missing"))?;
    let assignment_digest = spec.assignment_digest.as_ref().ok_or_else(|| {
        value_rejection(
            "assignment_digest",
            "validation assignment digest",
            "missing",
        )
    })?;
    let context_digest = spec.context_manifest_digest.as_ref().ok_or_else(|| {
        value_rejection(
            "context_manifest_digest",
            "validation context digest",
            "missing",
        )
    })?;
    let assignment_bytes =
        super::read_bounded_file(Path::new(&assignment_path.0), MAX_VALIDATION_ARTIFACT_BYTES)
            .map_err(|error| {
                value_rejection(
                    "assignment_path",
                    "bounded regular assignment",
                    error.to_string(),
                )
            })?;
    let context_bytes =
        super::read_bounded_file(Path::new(&context_path.0), MAX_VALIDATION_ARTIFACT_BYTES)
            .map_err(|error| {
                value_rejection(
                    "context_manifest_path",
                    "bounded regular context",
                    error.to_string(),
                )
            })?;
    if sha256_hex(&assignment_bytes) != assignment_digest.0
        || sha256_hex(&context_bytes) != context_digest.0
    {
        return Err(value_rejection(
            "validation_artifact_digest",
            "spec-bound assignment and context digests",
            "digest drift",
        ));
    }
    let assignment: kernel::generated::ValidationAssignmentV2 =
        serde_json::from_slice(&assignment_bytes).map_err(|error| {
            value_rejection("assignment", "valid assignment", error.to_string())
        })?;
    let context: kernel::generated::ValidationContextV2 = serde_json::from_slice(&context_bytes)
        .map_err(|error| {
            value_rejection("context", "valid validation context", error.to_string())
        })?;
    validate_validation_submission_against(submission, &assignment, &context)
}

fn validate_validation_context_command_authority(
    context: &kernel::generated::ValidationContextV2,
) -> Result<(), String> {
    let evidence = context
        .evidence
        .iter()
        .map(|item| (item.evidence_ref.clone(), item))
        .collect::<BTreeMap<_, _>>();
    if evidence.len() != context.evidence.len() {
        return Err("validation context duplicates evidence refs".to_owned());
    }
    let mut command_ids = BTreeSet::new();
    let mut package_check_ids = BTreeSet::new();
    for criterion in &context.criteria {
        for command in &criterion.commands {
            crate::allocation::validate_validation_context_command_effect_authority(command)
                .map_err(|error| {
                    format!(
                        "criterion {} command {}: {error}",
                        criterion.criterion_id.0, command.command_id.0
                    )
                })?;
            let Some(receipt) = evidence.get(&command.evidence_ref) else {
                return Err(format!(
                    "criterion {} command {} has no issued evidence",
                    criterion.criterion_id.0, command.command_id.0
                ));
            };
            let expected_evidence_ref = format!(
                "approved-command-receipt:{}:{}",
                command.command_id.0, receipt.digest.0
            );
            if receipt.command_id.as_ref() != Some(&command.command_id)
                || receipt.package_check_id.is_some()
                || receipt.kind != "delivery-approved-command"
                || receipt.evidence_ref.0 != expected_evidence_ref
                || receipt.exact_commit != context.exact_commit
                || receipt.exact_tree != context.exact_tree
            {
                return Err(format!(
                    "criterion {} command {} evidence drift",
                    criterion.criterion_id.0, command.command_id.0
                ));
            }
            command_ids.insert(command.command_id.clone());
        }
        for check in &criterion.package_checks {
            if check.check_id.0.trim().is_empty()
                || check.expected.trim().is_empty()
                || check.evidence_ref.0.trim().is_empty()
            {
                return Err(format!(
                    "criterion {} has incomplete package check",
                    criterion.criterion_id.0
                ));
            }
            match check.kind {
                kernel::generated::PackageCheckKind::CleanExactPackageTip => {}
            }
            let Some(receipt) = evidence.get(&check.evidence_ref) else {
                return Err(format!(
                    "criterion {} package check {} has no issued evidence",
                    criterion.criterion_id.0, check.check_id.0
                ));
            };
            let expected_evidence_ref = format!(
                "package-check-receipt:{}:{}",
                check.check_id.0, receipt.digest.0
            );
            if receipt.package_check_id.as_ref() != Some(&check.check_id)
                || receipt.command_id.is_some()
                || receipt.kind != "delivery-package-check"
                || receipt.evidence_ref.0 != expected_evidence_ref
                || receipt.exact_commit != context.exact_commit
                || receipt.exact_tree != context.exact_tree
            {
                return Err(format!(
                    "criterion {} package check {} evidence drift",
                    criterion.criterion_id.0, check.check_id.0
                ));
            }
            package_check_ids.insert(check.check_id.clone());
        }
    }
    if context.evidence.iter().any(|item| {
        (item.kind == "delivery-package-check") != item.package_check_id.is_some()
            || (item.kind == "delivery-approved-command") != item.command_id.is_some()
            || (item.command_id.is_some() && item.package_check_id.is_some())
    }) {
        return Err("validation typed evidence kind/id drift".to_owned());
    }
    let evidence_command_id_list = context
        .evidence
        .iter()
        .filter_map(|item| item.command_id.clone())
        .collect::<Vec<_>>();
    let evidence_command_ids = evidence_command_id_list
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if evidence_command_ids.len() != evidence_command_id_list.len()
        || evidence_command_ids != command_ids
    {
        return Err("validation approved-command evidence set drift".to_owned());
    }
    let evidence_check_id_list = context
        .evidence
        .iter()
        .filter_map(|item| item.package_check_id.clone())
        .collect::<Vec<_>>();
    let evidence_check_ids = evidence_check_id_list
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if evidence_check_ids.len() != evidence_check_id_list.len()
        || evidence_check_ids != package_check_ids
    {
        return Err("validation package-check evidence set drift".to_owned());
    }
    Ok(())
}

fn validate_validation_submission_against(
    submission: &kernel::generated::ValidationSubmissionV2,
    assignment: &kernel::generated::ValidationAssignmentV2,
    context: &kernel::generated::ValidationContextV2,
) -> Result<(), ValueRejection> {
    validate_validation_context_command_authority(context).map_err(|error| {
        value_rejection(
            "validation_context.commands",
            "valid typed command-effect authority",
            error,
        )
    })?;
    if submission.validation_id != assignment.validation_id
        || submission.assignment_id != assignment.assignment_id
        || submission.scope != assignment.scope
        || submission.exact_commit != assignment.exact_commit
        || submission.exact_tree != assignment.exact_tree
        || context.validation_id != assignment.validation_id
        || context.assignment_id != assignment.assignment_id
        || context.exact_commit != assignment.exact_commit
        || context.exact_tree != assignment.exact_tree
    {
        return Err(value_rejection(
            "validation_identity",
            "assignment/context-bound validation identity",
            "identity drift",
        ));
    }
    let required = context
        .criteria
        .iter()
        .map(|criterion| criterion.criterion_id.clone())
        .collect::<BTreeSet<_>>();
    let actual = submission
        .criterion_results
        .iter()
        .map(|result| result.criterion_id.clone())
        .collect::<BTreeSet<_>>();
    if required.len() != context.criteria.len()
        || actual.len() != submission.criterion_results.len()
        || actual != required
    {
        return Err(value_rejection(
            "criterion_results",
            "every issued criterion exactly once",
            "missing, duplicate, or unknown criterion",
        ));
    }
    let evidence = context
        .evidence
        .iter()
        .map(|item| item.evidence_ref.clone())
        .collect::<BTreeSet<_>>();
    let command_evidence = context
        .evidence
        .iter()
        .filter(|item| item.command_id.is_some())
        .map(|item| &item.evidence_ref)
        .collect::<BTreeSet<_>>();
    let package_evidence = context
        .evidence
        .iter()
        .filter(|item| item.package_check_id.is_some())
        .map(|item| &item.evidence_ref)
        .collect::<BTreeSet<_>>();
    let mut blocked = false;
    for result in &submission.criterion_results {
        if result.evidence_refs.is_empty()
            || result
                .evidence_refs
                .iter()
                .any(|reference| !evidence.contains(reference))
        {
            return Err(value_rejection(
                "criterion_results.evidence_refs",
                "nonempty issued evidence refs",
                result.criterion_id.0.clone(),
            ));
        }
        let criterion = context
            .criteria
            .iter()
            .find(|criterion| criterion.criterion_id == result.criterion_id)
            .expect("criterion sets were proven equal");
        let cited_evidence = result.evidence_refs.iter().collect::<BTreeSet<_>>();
        let required_command_evidence = criterion
            .commands
            .iter()
            .map(|command| &command.evidence_ref)
            .collect::<BTreeSet<_>>();
        let cited_command_evidence = cited_evidence
            .intersection(&command_evidence)
            .copied()
            .collect::<BTreeSet<_>>();
        if cited_command_evidence != required_command_evidence {
            return Err(value_rejection(
                "criterion_results.evidence_refs",
                "exact Core-owned approved-command receipts assigned to the criterion",
                result.criterion_id.0.clone(),
            ));
        }
        let required_package_evidence = criterion
            .package_checks
            .iter()
            .map(|check| &check.evidence_ref)
            .collect::<BTreeSet<_>>();
        let cited_package_evidence = cited_evidence
            .intersection(&package_evidence)
            .copied()
            .collect::<BTreeSet<_>>();
        if cited_package_evidence != required_package_evidence {
            return Err(value_rejection(
                "criterion_results.evidence_refs",
                "exact Core-owned package-check receipts assigned to the criterion",
                result.criterion_id.0.clone(),
            ));
        }
        let issued_paths = criterion.covered_paths.iter().collect::<BTreeSet<_>>();
        let actual_paths = result.covered_paths.iter().collect::<BTreeSet<_>>();
        let issued_surfaces = criterion
            .semantic_surface_ids
            .iter()
            .collect::<BTreeSet<_>>();
        let actual_surfaces = result.semantic_surface_ids.iter().collect::<BTreeSet<_>>();
        let issued_edges = criterion.forward_edge_ids.iter().collect::<BTreeSet<_>>();
        let actual_edges = result.forward_edge_ids.iter().collect::<BTreeSet<_>>();
        if issued_paths.len() != criterion.covered_paths.len()
            || actual_paths.len() != result.covered_paths.len()
            || actual_paths != issued_paths
            || issued_surfaces.len() != criterion.semantic_surface_ids.len()
            || actual_surfaces.len() != result.semantic_surface_ids.len()
            || actual_surfaces != issued_surfaces
            || issued_edges.len() != criterion.forward_edge_ids.len()
            || actual_edges.len() != result.forward_edge_ids.len()
            || actual_edges != issued_edges
        {
            return Err(value_rejection(
                "criterion_results.coverage",
                "exact issued criterion paths, surfaces, and forward edges without duplicates",
                result.criterion_id.0.clone(),
            ));
        }
        blocked |= result.verdict != kernel::generated::CriterionVerdict::PASS;
    }
    let issued_paths = context
        .criteria
        .iter()
        .flat_map(|criterion| criterion.covered_paths.iter().cloned())
        .collect::<BTreeSet<_>>();
    let issued_surfaces = context
        .criteria
        .iter()
        .flat_map(|criterion| criterion.semantic_surface_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    let issued_edges = context
        .criteria
        .iter()
        .flat_map(|criterion| criterion.forward_edge_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    let mut findings = BTreeMap::new();
    for finding in &submission.findings {
        let criterion_ids = finding
            .criterion_ids
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let edge_ids = finding.edge_ids.iter().cloned().collect::<BTreeSet<_>>();
        let finding_evidence = finding
            .evidence_refs
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let covered_paths = finding
            .covered_paths
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let surfaces = finding
            .semantic_surface_ids
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        if finding.finding_id.0.trim().is_empty()
            || finding.summary.trim().is_empty()
            || finding.detail.trim().is_empty()
            || criterion_ids.is_empty()
            || criterion_ids.len() != finding.criterion_ids.len()
            || !criterion_ids.is_subset(&required)
            || edge_ids.is_empty()
            || edge_ids.len() != finding.edge_ids.len()
            || !edge_ids.is_subset(&issued_edges)
            || finding_evidence.is_empty()
            || finding_evidence.len() != finding.evidence_refs.len()
            || !finding_evidence.is_subset(&evidence)
            || covered_paths.is_empty()
            || covered_paths.len() != finding.covered_paths.len()
            || !covered_paths.is_subset(&issued_paths)
            || surfaces.len() != finding.semantic_surface_ids.len()
            || !surfaces.is_subset(&issued_surfaces)
            || findings
                .insert(finding.finding_id.clone(), finding)
                .is_some()
        {
            return Err(value_rejection(
                "findings",
                "unique nonempty findings bound only to issued criteria, edges, evidence, paths, and surfaces",
                finding.finding_id.0.clone(),
            ));
        }
    }
    for result in &submission.criterion_results {
        let mut result_findings = BTreeSet::new();
        for finding_id in &result.finding_ids {
            let finding = findings.get(finding_id).ok_or_else(|| {
                value_rejection(
                    "criterion_results.finding_ids",
                    "issued embedded finding id",
                    finding_id.0.clone(),
                )
            })?;
            if !result_findings.insert(finding_id.clone())
                || !finding.criterion_ids.contains(&result.criterion_id)
            {
                return Err(value_rejection(
                    "criterion_results.finding_ids",
                    "unique finding ids tied to this criterion",
                    finding_id.0.clone(),
                ));
            }
        }
    }
    for finding in submission.findings.iter() {
        for criterion_id in &finding.criterion_ids {
            let result = submission
                .criterion_results
                .iter()
                .find(|result| result.criterion_id == *criterion_id)
                .expect("finding criteria were proven to be issued");
            if !result.finding_ids.contains(&finding.finding_id)
                || (finding.effect == kernel::generated::FindingEffect::ForwardBlocking
                    && result.verdict == kernel::generated::CriterionVerdict::PASS)
            {
                return Err(value_rejection(
                    "findings.criterion_ids",
                    "bidirectional finding link with blocking verdict coherence",
                    finding.finding_id.0.clone(),
                ));
            }
        }
    }
    blocked |= submission
        .findings
        .iter()
        .any(|finding| finding.effect == kernel::generated::FindingEffect::ForwardBlocking);
    let ready = submission.outcome == kernel::generated::ValidationOutcomeV2::FORWARDREADY;
    if ready == blocked {
        return Err(value_rejection(
            "outcome",
            "FORWARD_READY iff no criterion or finding blocks",
            format!("{:?}", submission.outcome),
        ));
    }
    Ok(())
}

enum ValidationV3AdmissionError {
    Fatal(String),
    Value(ValueRejection),
}

/// Fresh receipt_v1 V3 admission intentionally never persists a diagnostic.
/// Core returns the exact canonical diagnostic as RETRY; only the fully staged
/// accepted carrier/audit/submission become durable after receipt commit.
fn admit_validation_submission_v3_receipt(
    spec: &AgentRunSpec,
    payload: &Value,
    value_attempt: u32,
) -> Result<
    (
        kernel::generated::ValidationSubmissionV3,
        crate::runner::validation_authority::AdmittedValidationV3,
    ),
    ValidationV3AdmissionError,
> {
    let assignment_path = spec.assignment_path.as_ref().ok_or_else(|| {
        ValidationV3AdmissionError::Fatal(
            "missing receipt_v1 V4 validation assignment path".to_owned(),
        )
    })?;
    let assignment_digest = spec.assignment_digest.as_ref().ok_or_else(|| {
        ValidationV3AdmissionError::Fatal(
            "missing receipt_v1 V4 validation assignment digest".to_owned(),
        )
    })?;
    let context_path = spec.context_manifest_path.as_ref().ok_or_else(|| {
        ValidationV3AdmissionError::Fatal(
            "missing receipt_v1 V3 validation context path".to_owned(),
        )
    })?;
    let context_digest = spec.context_manifest_digest.as_ref().ok_or_else(|| {
        ValidationV3AdmissionError::Fatal(
            "missing receipt_v1 V3 validation context digest".to_owned(),
        )
    })?;
    let assignment_bytes = super::read_bounded_file(
        Path::new(&assignment_path.0),
        kernel::generated::VALIDATION_ASSIGNMENT_V4_MAX_BYTES,
    )
    .map_err(|error| {
        ValidationV3AdmissionError::Fatal(format!("receipt_v1 V4 assignment read: {error}"))
    })?;
    let context_bytes = super::read_bounded_file(
        Path::new(&context_path.0),
        kernel::generated::VALIDATION_CONTEXT_V3_MAX_BYTES,
    )
    .map_err(|error| {
        ValidationV3AdmissionError::Fatal(format!("receipt_v1 V3 context read: {error}"))
    })?;
    if sha256_hex(&assignment_bytes) != assignment_digest.0
        || sha256_hex(&context_bytes) != context_digest.0
    {
        return Err(ValidationV3AdmissionError::Fatal(
            "receipt_v1 V4 assignment/context digest drift".to_owned(),
        ));
    }
    let assignment: kernel::generated::ValidationAssignmentV4 =
        serde_json::from_slice(&assignment_bytes).map_err(|error| {
            ValidationV3AdmissionError::Fatal(format!("receipt_v1 V4 assignment parse: {error}"))
        })?;
    let context: kernel::generated::ValidationContextV3 = serde_json::from_slice(&context_bytes)
        .map_err(|error| {
            ValidationV3AdmissionError::Fatal(format!("receipt_v1 V3 context parse: {error}"))
        })?;
    if serde_json::to_vec_pretty(&assignment)
        .map_err(|error| ValidationV3AdmissionError::Fatal(error.to_string()))?
        != assignment_bytes
        || serde_json::to_vec_pretty(&context)
            .map_err(|error| ValidationV3AdmissionError::Fatal(error.to_string()))?
            != context_bytes
    {
        return Err(ValidationV3AdmissionError::Fatal(
            "receipt_v1 V4 assignment/context canonical bytes drift".to_owned(),
        ));
    }
    let validation_id = spec.validation_id.as_ref().ok_or_else(|| {
        ValidationV3AdmissionError::Fatal("missing receipt_v1 spec-bound validation id".to_owned())
    })?;
    let producer_assignment_ids = spec.producer_assignment_ids.as_ref().ok_or_else(|| {
        ValidationV3AdmissionError::Fatal("missing receipt_v1 spec-bound producer ids".to_owned())
    })?;
    let validation_attempt = spec.validation_attempt.ok_or_else(|| {
        ValidationV3AdmissionError::Fatal(
            "missing receipt_v1 spec-bound validation attempt".to_owned(),
        )
    })?;
    let semantic_round = spec.semantic_round.ok_or_else(|| {
        ValidationV3AdmissionError::Fatal("missing receipt_v1 spec-bound semantic round".to_owned())
    })?;
    let base_commit = spec.base_commit.as_ref().ok_or_else(|| {
        ValidationV3AdmissionError::Fatal("missing receipt_v1 spec-bound base commit".to_owned())
    })?;
    if assignment.schema.0 != "autopilot.validation_assignment.v4"
        || assignment.admission_mode != kernel::generated::AdmissionMode::ReceiptV1
        || assignment.validation_id != *validation_id
        || assignment.assignment_id != spec.assignment_id
        || assignment.action_id != spec.action_id
        || assignment.workstream != spec.workstream
        || assignment.run_revision != spec.run_revision
        || assignment.role_id != spec.role_id
        || assignment.mode != spec.mode
        || assignment.producer_assignment_ids != *producer_assignment_ids
        || assignment.validation_attempt != validation_attempt
        || assignment.semantic_round != semantic_round
        || assignment.base_commit.0 != base_commit.0
        || assignment.candidate_root.0 != spec.cwd.0
        || assignment.context_path != *context_path
        || assignment.context_digest != *context_digest
    {
        return Err(ValidationV3AdmissionError::Fatal(
            "receipt_v1 V4 assignment/spec identity or authority drift".to_owned(),
        ));
    }
    let expectation = crate::runner::validation_authority::ValidationAuthorityExpectation {
        validation_id: &assignment.validation_id,
        assignment_id: &assignment.assignment_id,
        base_commit: &assignment.base_commit,
        exact_commit: &assignment.exact_commit,
        exact_tree: &assignment.exact_tree,
        candidate_root: Path::new(&spec.cwd.0),
    };
    let authority_bytes = super::read_bounded_file(
        Path::new(&assignment.authority_path.0),
        kernel::generated::VALIDATION_EVIDENCE_AUTHORITY_MAX_BYTES,
    )
    .map_err(|error| {
        ValidationV3AdmissionError::Fatal(format!("receipt_v1 V3 authority read: {error}"))
    })?;
    let index = crate::runner::validation_authority::ValidationAuthorityIndex::load_staged_bytes(
        Path::new(&assignment.authority_path.0),
        &authority_bytes,
        &assignment.authority_digest.0,
        &expectation,
    )
    .map_err(|failure| ValidationV3AdmissionError::Fatal(validation_failure_text(failure)))?;
    if index.context_projection() != context {
        return Err(ValidationV3AdmissionError::Fatal(
            "receipt_v1 V3 context is not the exact authority projection".to_owned(),
        ));
    }
    match index.admit_raw(payload, value_attempt) {
        Ok(admitted) => Ok((admitted.submission.clone(), admitted)),
        Err(failure) if failure.fatal_authority => Err(ValidationV3AdmissionError::Fatal(
            validation_failure_text(failure),
        )),
        Err(failure) => Err(ValidationV3AdmissionError::Value(ValueRejection {
            field: "validation_admission_diagnostic".to_owned(),
            expected: "complete canonical V3 authority-confinement diagnostic".to_owned(),
            got: validation_failure_text(failure),
        })),
    }
}

fn terminal_delivery_denial_ledger(
    spec: &AgentRunSpec,
    terminal: &ToolTerminal,
) -> Result<Option<DeliveryPolicyDenialLedger>, ValueRejection> {
    let is_delivery = matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Delivery
    );
    match (&terminal.details.delivery_policy_denials, is_delivery) {
        (Some(value), true) => {
            let ledger: DeliveryPolicyDenialLedger = serde_json::from_value(value.clone())
                .map_err(|error| {
                    value_rejection(
                        "delivery_policy_denials",
                        "closed package policy denial ledger",
                        error.to_string(),
                    )
                })?;
            validate_delivery_policy_denial_ledger(&ledger).map_err(|error| {
                value_rejection(
                    "delivery_policy_denials",
                    "valid pre-effect denial ledger",
                    error,
                )
            })?;
            Ok(Some(ledger))
        }
        (None, true) => Err(value_rejection(
            "delivery_policy_denials",
            "required delivery policy denial ledger",
            "missing",
        )),
        (Some(_), false) => Err(value_rejection(
            "delivery_policy_denials",
            "absent outside delivery",
            "present",
        )),
        (None, false) => Ok(None),
    }
}

fn terminal_approved_command_execution_ledger(
    spec: &AgentRunSpec,
    terminal: &ToolTerminal,
) -> Result<Option<ApprovedCommandExecutionLedger>, ValueRejection> {
    let is_delivery = matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Delivery
    );
    match (&terminal.details.approved_command_executions, is_delivery) {
        (Some(value), true) => {
            let ledger: ApprovedCommandExecutionLedger = serde_json::from_value(value.clone())
                .map_err(|error| {
                    value_rejection(
                        "approved_command_executions",
                        "closed package command execution ledger",
                        error.to_string(),
                    )
                })?;
            validate_approved_command_execution_ledger(&ledger).map_err(|error| {
                value_rejection(
                    "approved_command_executions",
                    "valid bounded command execution ledger",
                    error,
                )
            })?;
            Ok(Some(ledger))
        }
        (None, true) => Err(value_rejection(
            "approved_command_executions",
            "required delivery command execution ledger",
            "missing",
        )),
        (Some(_), false) => Err(value_rejection(
            "approved_command_executions",
            "absent outside delivery",
            "present",
        )),
        (None, false) => Ok(None),
    }
}

fn insert_serialized<T: serde::Serialize>(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
    value: &T,
) -> Result<(), ValueRejection> {
    let value = serde_json::to_value(value).map_err(|error| {
        value_rejection(
            "assignment",
            "serializable typed validation assignment",
            error.to_string(),
        )
    })?;
    object.insert(key.to_owned(), value);
    Ok(())
}

fn package_tool_result(
    spec_path: &Path,
    spec_bytes: &str,
    spec_digest: &str,
    spec: &AgentRunSpec,
    terminal: &ToolTerminal,
    submission: Value,
    schema: &str,
    receipt_v1_validation_v3: bool,
) -> Result<PreparedCarrier, ValueRejection> {
    let (_, runtime_digest) = runtime_addon(spec)
        .ok_or_else(|| value_rejection(RUNTIME_ADDON_DIGEST_FIELD, "digest", "missing"))?;
    let denial_ledger = terminal_delivery_denial_ledger(spec, terminal)?;
    let execution_ledger = terminal_approved_command_execution_ledger(spec, terminal)?;
    let submission_bytes = serde_json::to_vec(&submission)
        .map_err(|error| value_rejection("submission", "serializable", error.to_string()))?;
    let submission_digest = sha256_hex(&submission_bytes);
    let mut artifacts = Vec::new();
    if matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Validation
    ) {
        let path = spec.model_submission_path.as_ref().ok_or_else(|| {
            value_rejection(
                "model_submission_path",
                "validation submission path",
                "missing",
            )
        })?;
        if spec.boundary_id.0 == "autopilot.validation_submission.v3" {
            ensure_exact_artifact_admissible(Path::new(&path.0), &submission_bytes).map_err(
                |error| {
                    value_rejection(
                        "model_submission_path",
                        "create-once canonical raw v3 model submission",
                        error,
                    )
                },
            )?;
            artifacts.push(PreparedArtifact::ExactBytes {
                path: PathBuf::from(&path.0),
                bytes: submission_bytes.clone(),
            });
        } else {
            ensure_carrier_clear(Path::new(&path.0)).map_err(|error| {
                value_rejection(
                    "model_submission_path",
                    "create-once model submission",
                    error,
                )
            })?;
            artifacts.push(PreparedArtifact::JsonNew {
                path: path.0.clone(),
                value: submission.clone(),
            });
        }
    }
    let audit_schema = if matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Delivery
    ) {
        "autopilot.tool_audit.v2"
    } else {
        "autopilot.tool_audit.v1"
    };
    let mut audit = serde_json::json!({
        "schema": audit_schema,
        "tool_call_id": terminal.tool_call_id,
        "profile_id": terminal.details.profile_id,
        "tool_name": terminal.tool_name,
        "boundary_id": terminal.details.boundary_id,
        "result_contract": terminal.details.result_contract,
        "schema_digest": terminal.details.schema_digest,
        "binding": terminal.details.binding,
        "submission_digest": submission_digest,
    });
    if matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Delivery
    ) {
        let assignment_path = spec
            .assignment_path
            .as_ref()
            .expect("validated delivery assignment path");
        let assignment_digest = spec
            .assignment_digest
            .as_ref()
            .expect("validated delivery assignment digest");
        let worktree = spec.worktree.as_ref().expect("validated delivery worktree");
        let bytes = super::read_bounded_file(
            Path::new(&assignment_path.0),
            super::DELIVERY_ASSIGNMENT_MAX_BYTES,
        )
        .expect("validated delivery assignment bytes");
        let (version, policy_digest) = match super::read_delivery_assignment_artifact(&bytes)
            .expect("validated schema-selected delivery assignment")
        {
            super::DeliveryAssignmentArtifactReader::V3(_) => (
                super::DELIVERY_POLICY_VERSION,
                super::delivery_policy_digest(
                    &assignment_path.0,
                    &assignment_digest.0,
                    &worktree.0,
                    &spec.cwd.0,
                ),
            ),
            super::DeliveryAssignmentArtifactReader::V4(_) => (
                super::DELIVERY_POLICY_V5_VERSION,
                super::delivery_policy_digest_v5(
                    &assignment_path.0,
                    &assignment_digest.0,
                    &worktree.0,
                    &spec.cwd.0,
                ),
            ),
        };
        audit.as_object_mut().expect("tool audit is object").insert(
            "delivery_policy".to_owned(),
            serde_json::json!({
                "version": version,
                "assignment_path": assignment_path.0,
                "assignment_digest": assignment_digest.0,
                "worktree": worktree.0,
                "cwd": spec.cwd.0,
                "policy_digest": policy_digest,
                "active_overrides": [super::APPROVED_COMMAND_TOOL, "edit", "write"],
                "denials": denial_ledger.expect("validated delivery denial ledger"),
                "command_executions": execution_ledger.expect("validated delivery command execution ledger"),
            }),
        );
    }
    let audit_bytes = serde_json::to_vec_pretty(&audit)
        .map_err(|error| value_rejection("tool_audit", "serializable", error.to_string()))?;
    let audit_path = PathBuf::from(&spec.carrier_path.0).with_extension("tool-audit.json");
    let audit_path_text = audit_path
        .to_str()
        .ok_or_else(|| value_rejection("tool_audit", "UTF-8 path", "non-UTF-8"))?;
    // A crash after the parent has published this staged immutable audit but
    // before the receipt root must be replayable.  Reuse only byte-identical
    // create-once audit bytes; a different existing file remains a loud
    // collision and cannot be adopted.
    ensure_exact_artifact_admissible(&audit_path, &audit_bytes)
        .map_err(|error| value_rejection("tool_audit", "create-once exact audit", error))?;
    artifacts.push(PreparedArtifact::JsonNew {
        path: audit_path_text.to_owned(),
        value: audit.clone(),
    });
    let mut carrier = serde_json::json!({
        "schema": schema,
        "action_id": spec.action_id,
        "assignment_id": spec.assignment_id,
        "run_revision": spec.run_revision,
        "workstream": spec.workstream,
        "role_id": spec.role_id,
        "mode": spec.mode,
        "prompt_path": spec.prompt_path,
        "prompt_digest": spec.prompt_digest,
        "spec_path": super::path_to_string(spec_path).map_err(|error| value_rejection("spec_path", "UTF-8 path", error.to_string()))?,
        "spec_digest": spec_digest,
        "spec_bytes": spec_bytes,
        "carrier_path": spec.carrier_path,
        "boundary_id": spec.boundary_id,
        "boundary_digest": spec.boundary_digest,
        "result_contract": spec.result_contract,
        "result_contract_digest": spec.result_contract_digest,
        "settings_digest": spec.settings_digest,
        "skills_digest": spec.skills_digest,
        "subscription_digest": spec.subscription_digest,
        "runtime_extension_digest": runtime_digest,
        "terminal_profile_id": terminal.details.profile_id,
        "tool_name": terminal.tool_name,
        "tool_schema_digest": terminal.details.schema_digest,
        "carrier_binding": terminal.details.binding,
        "tool_call_id": terminal.tool_call_id,
        "tool_audit_ref": audit_path.display().to_string(),
        "tool_audit_digest": sha256_hex(&audit_bytes),
        "submission_digest": submission_digest,
        "submission": submission,
    });
    let object = carrier
        .as_object_mut()
        .expect("package tool result is an object");
    if matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Delivery
    ) {
        object.insert(
            "lane_id".to_owned(),
            serde_json::to_value(spec.lane_id.as_ref().expect("validated lane")).unwrap(),
        );
        object.insert(
            "attempt".to_owned(),
            serde_json::json!(spec.attempt.expect("validated attempt")),
        );
        object.insert(
            "base_commit".to_owned(),
            serde_json::to_value(spec.base_commit.as_ref().expect("validated base")).unwrap(),
        );
        object.insert(
            "worktree".to_owned(),
            serde_json::to_value(spec.worktree.as_ref().expect("validated worktree")).unwrap(),
        );
        object.insert(
            "context_digest".to_owned(),
            serde_json::to_value(&spec.context_digest).unwrap(),
        );
    } else {
        let assignment_path = spec.assignment_path.as_ref().ok_or_else(|| {
            value_rejection("assignment_path", "validated assignment path", "missing")
        })?;
        let assignment_digest = spec.assignment_digest.as_ref().ok_or_else(|| {
            value_rejection(
                "assignment_digest",
                "validated assignment digest",
                "missing",
            )
        })?;
        let assignment_bytes =
            super::read_bounded_file(Path::new(&assignment_path.0), MAX_VALIDATION_ARTIFACT_BYTES)
                .map_err(|error| {
                    value_rejection("assignment", "bounded regular artifact", error.to_string())
                })?;
        if sha256_hex(&assignment_bytes) != assignment_digest.0 {
            return Err(value_rejection(
                "assignment",
                "spec-bound assignment digest",
                "digest drift",
            ));
        }
        match spec.boundary_id.0.as_str() {
            "autopilot.validation_submission.v2" => {
                let assignment: kernel::generated::ValidationAssignmentV2 =
                    serde_json::from_slice(&assignment_bytes).map_err(|error| {
                        value_rejection(
                            "assignment",
                            "strict closed v2 validation assignment",
                            error.to_string(),
                        )
                    })?;
                insert_serialized(object, "validation_id", &assignment.validation_id)?;
                insert_serialized(object, "validation_key", &assignment.validation_key)?;
                object.insert(
                    "validation_attempt".to_owned(),
                    serde_json::json!(assignment.validation_attempt),
                );
                object.insert(
                    "semantic_round".to_owned(),
                    serde_json::json!(assignment.semantic_round),
                );
                insert_serialized(
                    object,
                    "producer_assignment_ids",
                    &assignment.producer_assignment_ids,
                )?;
                insert_serialized(object, "exact_commit", &assignment.exact_commit)?;
                insert_serialized(object, "exact_tree", &assignment.exact_tree)?;
            }
            "autopilot.validation_submission.v3" => {
                // The caller selects this parser from the authenticated V5
                // path, never from assignment shape. Historical replay_v0
                // retains its byte-exact V3 reader.
                macro_rules! emit_assignment {
                    ($assignment:expr, $fresh:expr) => {{
                        let assignment = $assignment;
                        if assignment.action_id != spec.action_id
                            || assignment.assignment_id != spec.assignment_id
                            || assignment.workstream != spec.workstream
                            || assignment.run_revision != spec.run_revision
                            || assignment.role_id != spec.role_id
                            || assignment.mode != spec.mode
                            || Some(&assignment.context_path) != spec.context_manifest_path.as_ref()
                            || Some(&assignment.context_digest)
                                != spec.context_manifest_digest.as_ref()
                            || ($fresh
                                && assignment.admission_mode
                                    != kernel::generated::AdmissionMode::ReceiptV1)
                        {
                            return Err(value_rejection(
                                "assignment",
                                "exact receipt-selected v3 assignment identity/context",
                                "drift",
                            ));
                        }
                        insert_serialized(object, "validation_id", &assignment.validation_id)?;
                        insert_serialized(object, "validation_key", &assignment.validation_key)?;
                        object.insert(
                            "validation_attempt".to_owned(),
                            serde_json::json!(assignment.validation_attempt),
                        );
                        object.insert(
                            "semantic_round".to_owned(),
                            serde_json::json!(assignment.semantic_round),
                        );
                        insert_serialized(
                            object,
                            "producer_assignment_ids",
                            &assignment.producer_assignment_ids,
                        )?;
                        insert_serialized(object, "exact_commit", &assignment.exact_commit)?;
                        insert_serialized(object, "exact_tree", &assignment.exact_tree)?;
                        insert_serialized(object, "authority_path", &assignment.authority_path)?;
                        insert_serialized(
                            object,
                            "authority_digest",
                            &assignment.authority_digest,
                        )?;
                    }};
                }
                if !receipt_v1_validation_v3 {
                    return Err(value_rejection(
                        "assignment",
                        "receipt_v1 V4 validation assignment",
                        "replay_v0 child admission is reader-only",
                    ));
                }
                let assignment: kernel::generated::ValidationAssignmentV4 =
                    serde_json::from_slice(&assignment_bytes).map_err(|error| {
                        value_rejection(
                            "assignment",
                            "strict closed V4 receipt_v1 validation assignment",
                            error.to_string(),
                        )
                    })?;
                if assignment.schema.0 != "autopilot.validation_assignment.v4" {
                    return Err(value_rejection(
                        "assignment",
                        "autopilot.validation_assignment.v4",
                        assignment.schema.0,
                    ));
                }
                emit_assignment!(assignment, true);
            }
            other => {
                return Err(value_rejection(
                    "boundary_id",
                    "issued v2 or v3 validation boundary",
                    other,
                ));
            }
        }
        let context_path = spec.context_manifest_path.as_ref().ok_or_else(|| {
            value_rejection("context_manifest_path", "validated context path", "missing")
        })?;
        let context_digest = spec.context_manifest_digest.as_ref().ok_or_else(|| {
            value_rejection(
                "context_manifest_digest",
                "validated context digest",
                "missing",
            )
        })?;
        insert_serialized(object, "assignment_path", assignment_path)?;
        insert_serialized(object, "assignment_digest", assignment_digest)?;
        insert_serialized(object, "context_manifest_path", context_path)?;
        insert_serialized(object, "context_manifest_digest", context_digest)?;
    }
    Ok(PreparedCarrier { carrier, artifacts })
}

fn ensure_exact_artifact_admissible(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match super::read_bounded_file_optional(path, bytes.len().max(1))
        .map_err(|error| error.to_string())?
    {
        None => Ok(()),
        Some(existing) if existing == bytes => Ok(()),
        Some(_) => Err(format!("create-once exact artifact collision at {path:?}")),
    }
}

fn ensure_carrier_clear(path: &Path) -> Result<(), String> {
    super::reject_link_components_for_path(path).map_err(|error| error.to_string())?;
    match fs::File::open(path) {
        Ok(_) => Err(format!("carrier already present at {:?}", path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("carrier inspection failed {:?}: {error}", path)),
    }
}

fn compare_path(label: &str, actual: &Path, expected: &Path) -> Result<(), String> {
    if actual != expected {
        return Err(format!(
            "agent-run deterministic {label} drift: expected {:?}, got {:?}",
            expected, actual
        ));
    }
    Ok(())
}

fn path_value(label: &str, value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(format!("agent-run spec {label} must be absolute: {value}"));
    }
    Ok(path)
}

fn validate_id(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
    {
        return Err(format!("agent-run invalid {label}: {value}"));
    }
    Ok(())
}

fn bounded_stderr_limit(value: usize) -> Result<usize, String> {
    if value > crate::runner::rpc::MAX_STDERR_TAIL_BYTES {
        return Err(format!(
            "AUTOPILOT_AGENT_RUN_MAX_STDERR_BYTES must be <= {}, got {value}",
            crate::runner::rpc::MAX_STDERR_TAIL_BYTES
        ));
    }
    Ok(value)
}

fn bounded_terminal_limit(value: usize) -> Result<usize, String> {
    let ceiling = crate::generated::pi_rpc::DEFAULT_MAX_TERMINAL_BYTES;
    if value == 0 || value > ceiling {
        return Err(format!(
            "AUTOPILOT_AGENT_RUN_MAX_TERMINAL_BYTES must be within 1..={ceiling}, got {value}"
        ));
    }
    Ok(value)
}

fn env_usize(name: &str, default: usize) -> Result<usize, String> {
    match std::env::var(name) {
        Ok(value) => parse_usize_setting(name, Some(&value), default),
        Err(std::env::VarError::NotPresent) => parse_usize_setting(name, None, default),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err(format!("{name} must contain Unicode decimal digits"))
        }
    }
}

fn parse_usize_setting(name: &str, value: Option<&str>, default: usize) -> Result<usize, String> {
    value.map_or(Ok(default), |value| {
        value
            .parse::<usize>()
            .map_err(|error| format!("{name} must be an unsigned integer: {error}"))
    })
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
#[path = "../../tests/unit/runner_child.rs"]
mod tests;
