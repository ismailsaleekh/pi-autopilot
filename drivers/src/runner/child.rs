use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::checkpoint::{
    self, AgentHandoff, CheckpointInput, CheckpointPolicy, CheckpointSource, ContextAction,
    ContextBudget,
};
use crate::runner::rpc::{
    AppendedEntry, CompactionReason, RpcClient, RpcCommand, RpcCommandKind, RpcDiagnostics,
    RpcEvent, RpcFrame, RpcResponse, RpcSpawnConfig, TerminalMessage, ToolCarrierDetails,
};

use kernel::failure::{Failure, OperatorDecision, RetryPolicy};
use kernel::generated::{AgentRunSpec, SessionContinuity, TaskDocument};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as ShaDigest, Sha256};

const DEFAULT_MAX_PI_STDOUT_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_PI_STDERR_BYTES: usize = 256 * 1024;
const MAX_VALUE_ATTEMPTS: u32 = 3;
const RUNTIME_ADDON_DIGEST_FIELD: &str = concat!("runtime_", "ext", "ension_digest");
#[rustfmt::skip]
fn runtime_addon(spec: &AgentRunSpec) -> Option<(&kernel::generated::Path, &kernel::generated::Digest)> { spec.runtime_extension_path.as_ref().zip(spec.runtime_extension_digest.as_ref()) }

#[derive(Debug, Clone, Eq, PartialEq)]
struct ValueRejection {
    field: String,
    expected: String,
    got: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct AssistantRecord {
    text: String,
    provider: String,
    model: String,
    stop_reason: String,
}

#[derive(Debug, Clone, PartialEq)]
struct ToolTerminal {
    tool_name: String,
    tool_call_id: String,
    details: ToolCarrierDetails,
    details_value: Value,
    continuation_provenance: Option<ContinuationProvenance>,
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
}

#[derive(Debug, Clone, PartialEq)]
enum CarrierSource {
    Tool(ToolTerminal),
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
struct ContinuationProvenance {
    attempts_made: u32,
    classes: Vec<TerminalMissClass>,
    directive_digests: Vec<String>,
    session_digest: String,
    dispatch_receipts: Vec<DirectiveReceipt>,
    terminal_call_id: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
enum CarrierRejection {
    Identity(String),
    Value(ValueRejection),
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) enum TerminalMissClass {
    ProseInsteadOfTerminal,
    EmptyStopNoTerminal,
    NoTerminalFrame,
    TerminalToolNotOffered,
    MultipleTerminals,
}

impl TerminalMissClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::ProseInsteadOfTerminal => "prose-instead-of-terminal",
            Self::EmptyStopNoTerminal => "empty-stop-no-terminal",
            Self::NoTerminalFrame => "no-terminal-frame",
            Self::TerminalToolNotOffered => "terminal-tool-not-offered",
            Self::MultipleTerminals => "multiple-terminals",
        }
    }

    fn is_retryable(self) -> bool {
        matches!(
            self,
            Self::ProseInsteadOfTerminal | Self::EmptyStopNoTerminal
        )
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
struct DirectiveReceipt {
    template_id: String,
    template_version: u32,
    byte_len: usize,
    sha256: String,
    attempt_index: u32,
    session_digest: String,
    prior_prose_digest: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
struct StopFacts {
    non_retryable: Option<TerminalMissClass>,
    deterministic_repeat: Option<[u8; 32]>,
    budget_exhausted: bool,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
struct TerminalTrace {
    attempts_made: u32,
    continuations_prepared: u32,
    continuations_dispatched: u32,
    classes: Vec<TerminalMissClass>,
    directives: Vec<DirectiveReceipt>,
    stop: StopFacts,
}

impl TerminalTrace {
    fn new() -> Self {
        Self {
            attempts_made: 0,
            continuations_prepared: 0,
            continuations_dispatched: 0,
            classes: Vec::new(),
            directives: Vec::new(),
            stop: StopFacts {
                non_retryable: None,
                deterministic_repeat: None,
                budget_exhausted: false,
            },
        }
    }

    fn class_names(&self) -> Vec<&'static str> {
        self.classes.iter().map(|class| class.as_str()).collect()
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
struct SessionId(String);

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) struct EvidenceError {
    stage: String,
    message: String,
}

impl EvidenceError {
    fn new(stage: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            stage: stage.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for EvidenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.stage, self.message)
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
enum TerminalContinuationError {
    InvalidPolicy {
        value: u64,
    },
    Prompt {
        source: Box<ChildError>,
        trace: Box<TerminalTrace>,
    },
    Terminal {
        miss: Box<TerminalMiss>,
        trace: Box<TerminalTrace>,
    },
    EvidenceWrite {
        primary: Box<TerminalContinuationError>,
        evidence: EvidenceError,
    },
    SessionContinuityLost {
        expected: SessionId,
        actual: SessionId,
    },
}

impl TerminalContinuationError {
    fn into_message(self) -> String {
        self.to_string()
    }
}

impl fmt::Display for TerminalContinuationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPolicy { value } => write!(
                f,
                "agent-run terminal continuation policy invalid max_attempts={value}; expected positive u32 total prompt attempts"
            ),
            Self::Prompt { source, trace } => write!(
                f,
                "agent-run prompt failed after terminal trace attempts={} classes=[{}]: {}",
                trace.attempts_made,
                trace.class_names().join(","),
                source.as_ref().clone().into_message()
            ),
            Self::Terminal { miss, trace } => {
                if let Some(digest) = trace.stop.deterministic_repeat {
                    write!(
                        f,
                        "agent-run terminal miss deterministic repeated prose digest={} attempts={} classes=[{}]",
                        hex_digest(&digest),
                        trace.attempts_made,
                        trace.class_names().join(",")
                    )
                } else if trace.stop.budget_exhausted {
                    write!(
                        f,
                        "agent-run terminal continuation exhausted attempts={} max={} classes=[{}]",
                        trace.attempts_made,
                        trace.attempts_made,
                        trace.class_names().join(",")
                    )
                } else {
                    write!(
                        f,
                        "agent-run terminal miss: {} attempts={} classes=[{}]",
                        terminal_miss_message(miss),
                        trace.attempts_made,
                        trace.class_names().join(",")
                    )
                }
            }
            Self::EvidenceWrite { primary, evidence } => {
                write!(f, "{primary}; evidence write failed: {evidence}")
            }
            Self::SessionContinuityLost { expected, actual } => write!(
                f,
                "agent-run session continuity lost: expected {expected}, got {actual}"
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) enum TerminalToolNotOfferedSource {
    PrePromptActiveTools,
    OfferedTerminalToolGuard,
    TerminalCycleOfferedTools,
}

impl TerminalToolNotOfferedSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::PrePromptActiveTools => "pre-prompt-active-tools",
            Self::OfferedTerminalToolGuard => "offered-terminal-tool-guard",
            Self::TerminalCycleOfferedTools => "terminal-cycle-offered-tools",
        }
    }
}

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

impl TerminalMiss {
    fn class_enum(&self) -> TerminalMissClass {
        match self {
            Self::ProseInsteadOfTerminal { .. } => TerminalMissClass::ProseInsteadOfTerminal,
            Self::EmptyStopNoTerminal { .. } => TerminalMissClass::EmptyStopNoTerminal,
            Self::NoTerminalFrame { .. } => TerminalMissClass::NoTerminalFrame,
            Self::TerminalToolNotOffered { .. } => TerminalMissClass::TerminalToolNotOffered,
            Self::MultipleTerminals { .. } => TerminalMissClass::MultipleTerminals,
        }
    }

    fn class(&self) -> &'static str {
        self.class_enum().as_str()
    }

    fn is_retryable(&self) -> bool {
        self.class_enum().is_retryable()
    }

    fn prose_digest(&self) -> Option<[u8; 32]> {
        match self {
            Self::ProseInsteadOfTerminal { text_digest, .. } => Some(*text_digest),
            Self::EmptyStopNoTerminal { .. }
            | Self::NoTerminalFrame { .. }
            | Self::TerminalToolNotOffered { .. }
            | Self::MultipleTerminals { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
enum ChildError {
    TerminalMiss(TerminalMiss),
    TerminalMissDeterministic {
        digest: [u8; 32],
    },
    TerminalContinuationExhausted {
        classes: Vec<String>,
        attempts_made: u32,
        max_attempts: u32,
    },
    EvidenceWrite(EvidenceError),
    SessionContinuityLost {
        expected: String,
        actual: String,
    },
    Fatal(String),
}

impl ChildError {
    fn into_message(self) -> String {
        match self {
            Self::TerminalMiss(miss) => {
                format!("agent-run terminal miss: {}", terminal_miss_message(&miss))
            }
            Self::TerminalMissDeterministic { digest } => format!(
                "agent-run terminal miss deterministic repeated prose digest={}",
                hex_digest(&digest)
            ),
            Self::TerminalContinuationExhausted {
                classes,
                attempts_made,
                max_attempts,
            } => format!(
                "agent-run terminal continuation exhausted attempts={attempts_made} max={max_attempts} classes=[{}]",
                classes.join(",")
            ),
            Self::EvidenceWrite(error) => format!("agent-run evidence write failed: {error}"),
            Self::SessionContinuityLost { expected, actual } => {
                format!("agent-run session continuity lost: expected {expected}, got {actual}")
            }
            Self::Fatal(message) => message,
        }
    }
}

impl From<String> for ChildError {
    fn from(message: String) -> Self {
        Self::Fatal(message)
    }
}

impl From<&str> for ChildError {
    fn from(message: &str) -> Self {
        Self::Fatal(message.to_owned())
    }
}

impl From<ValueRejection> for CarrierRejection {
    fn from(value: ValueRejection) -> Self {
        Self::Value(value)
    }
}

pub fn main(args: &[String]) -> Result<(), String> {
    let spec_path = parse_args(args)?;
    super::reject_link_components_for_path(&spec_path).map_err(|error| error.to_string())?;
    super::require_regular_file(&spec_path).map_err(|error| error.to_string())?;
    let raw = fs::read_to_string(&spec_path)
        .map_err(|error| format!("agent-run spec read failed {:?}: {error}", spec_path))?;
    let spec: AgentRunSpec = serde_json::from_str(&raw).map_err(|error| {
        format!("agent-run spec is malformed, incomplete, or has unknown fields: {error}")
    })?;
    let spec_digest = sha256_hex(raw.as_bytes());
    validate_spec(&spec, &spec_path)?;
    let prompt_path = PathBuf::from(&spec.prompt_path.0);
    super::require_regular_file(&prompt_path).map_err(|error| error.to_string())?;
    let prompt = fs::read_to_string(&prompt_path).map_err(|error| {
        format!(
            "agent-run prompt read failed {}: {error}",
            spec.prompt_path.0
        )
    })?;
    let digest = sha256_hex(prompt.as_bytes());
    if digest != spec.prompt_digest.0 {
        return Err(format!(
            "agent-run prompt digest mismatch: expected {}, got {}",
            spec.prompt_digest.0, digest
        ));
    }
    ensure_carrier_absent(&spec)?;
    let audit_path = PathBuf::from(&spec.carrier_path.0).with_extension("tool-audit.json");
    super::reject_link_components_for_path(&audit_path).map_err(|error| error.to_string())?;
    match fs::symlink_metadata(&audit_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(format!(
                "agent-run unconsumed pre-existing tool audit refused at {}",
                audit_path.display()
            ));
        }
        Err(error) => return Err(error.to_string()),
    }
    let mut runner = RpcAssignment::spawn_and_configure(&spec)?;
    let mut session = PromptSession::new(&spec);
    let result = run_value_attempts(
        &mut runner,
        &mut session,
        &spec_path,
        &raw,
        &spec_digest,
        &spec,
        prompt,
    );
    let shutdown = runner.shutdown();
    if result.is_ok() {
        shutdown?;
    }
    result
}

fn run_value_attempts(
    runner: &mut RpcAssignment,
    session: &mut PromptSession,
    spec_path: &Path,
    spec_bytes: &str,
    spec_digest: &str,
    spec: &AgentRunSpec,
    prompt: String,
) -> Result<(), String> {
    let mut attempt_prompt = prompt;
    for attempt in 1..=MAX_VALUE_ATTEMPTS {
        append_attempt_event(spec, attempt, "started", AttemptEventDetail::none())
            .map_err(|error| error.to_string())?;
        let source =
            run_prompt_with_terminal_continuation(runner, spec, session, &attempt_prompt, attempt)
                .map_err(TerminalContinuationError::into_message)?;
        match write_carrier(spec_path, spec_bytes, spec_digest, spec, &source) {
            Ok(()) => {
                append_attempt_event(spec, attempt, "accepted", AttemptEventDetail::none())
                    .map_err(|error| error.to_string())?;
                return Ok(());
            }
            Err(CarrierRejection::Identity(detail)) => {
                append_attempt_event(
                    spec,
                    attempt,
                    "identity-rejected",
                    AttemptEventDetail::none(),
                )
                .map_err(|error| error.to_string())?;
                return Err(format!(
                    "agent-run carrier identity rejected before value repair: {detail}"
                ));
            }
            Err(CarrierRejection::Value(rejection)) if attempt < MAX_VALUE_ATTEMPTS => {
                append_attempt_event(
                    spec,
                    attempt,
                    "value-rejected",
                    AttemptEventDetail::rejection(&rejection),
                )
                .map_err(|error| error.to_string())?;
                attempt_prompt = render_repair_prompt(spec, &rejection);
            }
            Err(CarrierRejection::Value(rejection)) => {
                append_attempt_event(
                    spec,
                    attempt,
                    "paused-after-exhaustion",
                    AttemptEventDetail::rejection(&rejection),
                )
                .map_err(|error| error.to_string())?;
                return Err(paused_after_exhaustion(spec, &rejection));
            }
        }
    }
    unreachable!("bounded value attempt loop must return")
}

/// Run one value attempt, adding the bounded terminal-miss continuation layer.
///
/// This wraps prompt execution inside value repair: a retryable terminal miss
/// receives one same-session directive to call the already-declared terminating
/// tool, while a capacity refusal inside either turn is handled by the inner
/// capacity retry and does not consume a continuation attempt.
fn run_prompt_with_terminal_continuation(
    runner: &mut RpcAssignment,
    spec: &AgentRunSpec,
    session: &mut PromptSession,
    prompt: &str,
    value_attempt: u32,
) -> Result<CarrierSource, TerminalContinuationError> {
    let max_attempts_value = drivers_generated_max_terminal_attempts_raw();
    let max_attempts = u32::try_from(max_attempts_value)
        .ok()
        .and_then(NonZeroU32::new)
        .ok_or(TerminalContinuationError::InvalidPolicy {
            value: max_attempts_value,
        })?;
    let offered_tool = OfferedTerminalTool::new(spec).map_err(|miss| {
        let mut trace = TerminalTrace::new();
        trace.stop.non_retryable = Some(miss.class_enum());
        terminal_continuation_terminal_error(miss, trace)
    })?;
    let mut next_prompt = prompt.to_owned();
    let mut trace = TerminalTrace::new();
    let mut previous_prose_digest = None;
    for terminal_attempt in 1..=max_attempts.get() {
        let directive = trace.directives.last().cloned();
        match run_prompt_with_capacity_retry(
            runner,
            spec,
            session,
            &next_prompt,
            value_attempt,
            directive.as_ref(),
        ) {
            Ok(mut source) => {
                if directive.is_some() {
                    trace.continuations_dispatched =
                        trace.continuations_dispatched.saturating_add(1);
                }
                if trace.continuations_dispatched > 0 {
                    attach_continuation_provenance(&mut source, &trace);
                    append_terminal_event_or_error(
                        spec,
                        value_attempt,
                        "terminal-continuation-carrier-produced",
                        AttemptEventDetail::none(),
                        terminal_continuation_prompt_error(
                            ChildError::Fatal(
                                "agent-run continuation carrier-produced event failed".to_owned(),
                            ),
                            trace.clone(),
                        ),
                    )?;
                }
                return Ok(source);
            }
            Err(ChildError::TerminalMiss(miss)) => {
                if directive.is_some() {
                    trace.continuations_dispatched =
                        trace.continuations_dispatched.saturating_add(1);
                }
                trace.attempts_made = terminal_attempt;
                trace.classes.push(miss.class_enum());
                let deterministic = miss.prose_digest().and_then(|digest| {
                    if previous_prose_digest == Some(digest) {
                        Some(digest)
                    } else {
                        previous_prose_digest = Some(digest);
                        None
                    }
                });
                let retryable = miss.is_retryable();
                let final_attempt = terminal_attempt == max_attempts.get();
                if let Some(digest) = deterministic {
                    trace.stop.deterministic_repeat = Some(digest);
                }
                if final_attempt {
                    trace.stop.budget_exhausted = true;
                }
                if !retryable {
                    trace.stop.non_retryable = Some(miss.class_enum());
                    let primary = terminal_continuation_terminal_error(miss.clone(), trace.clone());
                    append_terminal_event_or_error(
                        spec,
                        value_attempt,
                        "terminal-miss-non-retryable",
                        AttemptEventDetail::terminal_miss(&miss),
                        primary.clone(),
                    )?;
                    return Err(primary);
                }
                if deterministic.is_some() || final_attempt {
                    let primary = terminal_continuation_terminal_error(miss.clone(), trace.clone());
                    let event = if deterministic.is_some() {
                        "terminal-continuation-deterministic"
                    } else {
                        "terminal-continuation-exhausted"
                    };
                    append_terminal_event_or_error(
                        spec,
                        value_attempt,
                        event,
                        AttemptEventDetail::terminal_trace(&trace),
                        primary.clone(),
                    )?;
                    return Err(primary);
                }
                append_terminal_event_or_error(
                    spec,
                    value_attempt,
                    "terminal-continuation",
                    AttemptEventDetail::terminal_miss(&miss),
                    terminal_continuation_terminal_error(miss.clone(), trace.clone()),
                )?;
                let directive_text = render_terminal_directive(&offered_tool, &miss);
                let receipt = directive_receipt(
                    &directive_text,
                    terminal_attempt + 1,
                    session,
                    miss.prose_digest(),
                );
                append_terminal_event_or_error(
                    spec,
                    value_attempt,
                    "continuation-prepared",
                    AttemptEventDetail::directive(&receipt),
                    terminal_continuation_terminal_error(miss.clone(), trace.clone()),
                )?;
                trace.continuations_prepared = trace.continuations_prepared.saturating_add(1);
                trace.directives.push(receipt);
                next_prompt = directive_text;
            }
            Err(ChildError::SessionContinuityLost { expected, actual }) => {
                return Err(TerminalContinuationError::SessionContinuityLost {
                    expected: SessionId(expected),
                    actual: SessionId(actual),
                });
            }
            Err(ChildError::TerminalMissDeterministic { digest }) => {
                trace.stop.deterministic_repeat = Some(digest);
                return Err(terminal_continuation_prompt_error(
                    ChildError::TerminalMissDeterministic { digest },
                    trace,
                ));
            }
            Err(ChildError::TerminalContinuationExhausted {
                classes,
                attempts_made,
                max_attempts,
            }) => {
                return Err(terminal_continuation_prompt_error(
                    ChildError::TerminalContinuationExhausted {
                        classes,
                        attempts_made,
                        max_attempts,
                    },
                    trace,
                ));
            }
            Err(ChildError::EvidenceWrite(evidence)) => {
                return Err(TerminalContinuationError::EvidenceWrite {
                    primary: Box::new(terminal_continuation_prompt_error(
                        ChildError::Fatal("agent-run prompt evidence write failed".to_owned()),
                        trace,
                    )),
                    evidence,
                });
            }
            Err(ChildError::Fatal(message)) => {
                if let Some((expected, actual)) = parse_session_continuity_lost(&message) {
                    return Err(TerminalContinuationError::SessionContinuityLost {
                        expected: SessionId(expected),
                        actual: SessionId(actual),
                    });
                }
                return Err(terminal_continuation_prompt_error(
                    ChildError::Fatal(message),
                    trace,
                ));
            }
        }
    }
    let mut trace = TerminalTrace::new();
    trace.stop.budget_exhausted = true;
    Err(terminal_continuation_terminal_error(
        TerminalMiss::NoTerminalFrame {
            messages_seen: 0,
            last_stop_reason: None,
        },
        trace,
    ))
}

/// Send one prompt, retrying only launch-side upstream capacity refusals.
///
/// A capacity refusal happens before the model produces anything: no tokens are
/// billed and no content exists to repair, so the value-repair path cannot help
/// and the correct response is to wait and re-send the identical prompt. Retry
/// happens on the same live child session, which keeps the session identity
/// contract intact and never re-enters the fresh-session fence.
///
/// Content failures are deliberately not retried here: they fall through to the
/// terminal-continuation or value-repair loops, which own model output shape and
/// typed-carrier value repair independently. Worst case is bounded at 2 terminal
/// attempts inside each of 3 value attempts: 6 model turns, before capacity
/// retries (which do not consume continuation attempts).
fn run_prompt_with_capacity_retry(
    runner: &mut RpcAssignment,
    spec: &AgentRunSpec,
    session: &mut PromptSession,
    prompt: &str,
    attempt: u32,
    directive: Option<&DirectiveReceipt>,
) -> Result<CarrierSource, ChildError> {
    let policy = CapacityRetryPolicy::parse()?;
    let mut last = String::new();
    for retry in 0..=policy.max_retries {
        match runner.run_normal_prompt(spec, session, prompt, attempt, directive) {
            Ok(assistant) => return Ok(assistant),
            Err(PromptFailure::UpstreamCapacity(detail)) => {
                last = detail;
                if retry == policy.max_retries {
                    break;
                }
                append_attempt_event(
                    spec,
                    attempt,
                    "upstream-capacity-retry",
                    AttemptEventDetail::none(),
                )
                .map_err(ChildError::EvidenceWrite)?;
                std::thread::sleep(policy.backoff(retry, &spec.assignment_id.0));
            }
            Err(other) => return Err(other.into_child_error()),
        }
    }
    Err(ChildError::Fatal(format!(
        "agent-run upstream capacity refusal: {last}; exhausted {} upstream capacity retries",
        policy.max_retries
    )))
}

struct RpcAssignment {
    client: RpcClient,
    next_command: u64,
    policy: CheckpointPolicy,
    /// Detail of the most recent launch-side refusal, set by `finish_cycle`.
    last_capacity_refusal: Option<String>,
    last_known_percent: Option<f64>,
    checkpoint_armed: bool,
    bootstrap_entry: Option<AppendedEntry>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum PromptPurpose {
    Normal,
    Handoff,
    Resume,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct CycleTerminal {
    record: AssistantRecord,
    delivered_after_steer: bool,
}

struct CycleState {
    purpose: PromptPurpose,
    attempt: Option<u32>,
    prompt_response_seen: bool,
    pending_stats: BTreeSet<String>,
    final_record: Option<CycleTerminal>,
    /// Count of selected terminating submit tool results only.
    terminal_count: usize,
    assistant_terminal_count: usize,
    assistant_message_count: usize,
    last_stop_reason: Option<String>,
    last_tool_name: Option<String>,
    tool_terminal: Option<ToolTerminal>,
    tool_terminal_count: usize,
    tool_execution_count: usize,
    tool_result_call_ids: BTreeSet<String>,
    tool_result_details: BTreeMap<String, Value>,
    tool_after_terminal: bool,
    awaiting_handoff: bool,
    steer_response_seen: bool,
    steer_queue_seen: bool,
    steer_message_started: bool,
    handoff: Option<AgentHandoff>,
    compacted: bool,
    /// Set when the terminal was an upstream refusal rather than model output.
    upstream_capacity_failure: Option<String>,
}

impl CycleState {
    fn new(purpose: PromptPurpose, attempt: Option<u32>) -> Self {
        Self {
            purpose,
            attempt,
            prompt_response_seen: false,
            pending_stats: BTreeSet::new(),
            final_record: None,
            terminal_count: 0,
            assistant_terminal_count: 0,
            assistant_message_count: 0,
            last_stop_reason: None,
            last_tool_name: None,
            tool_terminal: None,
            tool_terminal_count: 0,
            tool_execution_count: 0,
            tool_result_call_ids: BTreeSet::new(),
            tool_result_details: BTreeMap::new(),
            tool_after_terminal: false,
            awaiting_handoff: matches!(purpose, PromptPurpose::Handoff),
            steer_response_seen: false,
            steer_queue_seen: false,
            steer_message_started: matches!(purpose, PromptPurpose::Handoff),
            handoff: None,
            compacted: false,
            upstream_capacity_failure: None,
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct TerminalFailureDiagnostic {
    stop_reason: Option<String>,
    provider_error_message_present: bool,
    provider_error_message: Option<String>,
    assistant_text_present: bool,
    assistant_text_len: usize,
    capacity_detector_matched: bool,
    capacity_detector_miss: Vec<String>,
}

impl TerminalFailureDiagnostic {
    fn from_message(message: &TerminalMessage) -> Self {
        let stop_reason = message
            .stop_reason
            .as_deref()
            .map(|value| value.to_ascii_lowercase());
        let provider_error_message = message
            .error_message
            .as_deref()
            .map(crate::evidence::bound_detail);
        let assistant_text = message.text.as_deref().unwrap_or("");
        let assistant_text_present = !assistant_text.is_empty();
        let mut capacity_detector_miss = Vec::new();
        match stop_reason.as_deref() {
            None => capacity_detector_miss.push("missing-stopReason".to_owned()),
            Some("stop" | "tooluse") => {
                capacity_detector_miss.push("terminal-stopReason".to_owned())
            }
            Some(_) => {}
        }
        if provider_error_message.is_none() {
            capacity_detector_miss.push("missing-errorMessage".to_owned());
        }
        if assistant_text_present {
            capacity_detector_miss.push("assistant-text-present".to_owned());
        }
        Self {
            stop_reason,
            provider_error_message_present: provider_error_message.is_some(),
            provider_error_message,
            assistant_text_present,
            assistant_text_len: assistant_text.chars().count(),
            capacity_detector_matched: capacity_detector_miss.is_empty(),
            capacity_detector_miss,
        }
    }
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
    })
}

impl RpcAssignment {
    fn spawn_and_configure(spec: &AgentRunSpec) -> Result<Self, String> {
        let tools = spec
            .allowed_tools
            .iter()
            .map(|tool| tool.0.clone())
            .collect::<Vec<_>>();
        let stderr_limit = env_usize(
            "AUTOPILOT_AGENT_RUN_MAX_STDERR_BYTES",
            DEFAULT_MAX_PI_STDERR_BYTES,
        );
        let policy = CheckpointPolicy::parse()?;
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
        config.max_terminal_bytes = env_usize(
            "AUTOPILOT_AGENT_RUN_MAX_TERMINAL_BYTES",
            crate::generated::pi_rpc::DEFAULT_MAX_TERMINAL_BYTES,
        );
        if let Some((path, _)) = runtime_addon(spec) {
            config.runtime_addon = Some(PathBuf::from(&path.0));
            config.terminal_profile = spec.terminal_profile_id.clone();
            config.carrier_binding = Some(carrier_binding(spec));
        }
        let client = RpcClient::spawn(config).map_err(|error| error.to_string())?;
        let mut runner = Self {
            client,
            next_command: 0,
            policy,
            last_capacity_refusal: None,
            last_known_percent: None,
            checkpoint_armed: false,
            bootstrap_entry: None,
        };
        let auto_id = runner.next_id("auto-off");
        let response = runner.command_response(RpcCommand::set_auto_compaction(auto_id, false))?;
        if !response.success {
            return Err("agent-run set_auto_compaction returned success:false".to_owned());
        }
        let state_id = runner.next_id("state");
        let state = runner.command_response(RpcCommand::get_state(state_id))?;
        runner.validate_state(spec, &state)?;
        if runtime_addon(spec).is_some() {
            let entries_id = runner.next_id("entries");
            let entries = runner.command_response(RpcCommand::get_entries(entries_id))?;
            runner.validate_child_receipt(spec, &entries)?;
        } else if runner.bootstrap_entry.is_some() {
            return Err(
                "agent-run child emitted a registration entry without a runtime add-on".to_owned(),
            );
        }
        runner.client.complete_bootstrap();
        runner.bootstrap_entry = None;
        Ok(runner)
    }

    /// Run one normal prompt cycle, classifying the failure.
    fn run_normal_prompt(
        &mut self,
        spec: &AgentRunSpec,
        session: &mut PromptSession,
        prompt: &str,
        attempt: u32,
        directive: Option<&DirectiveReceipt>,
    ) -> Result<CarrierSource, PromptFailure> {
        let capacity_before = self.last_capacity_refusal.take();
        let result = self.run_prompt(
            spec,
            session,
            prompt,
            PromptPurpose::Normal,
            Some(attempt),
            directive,
        );
        match result {
            Ok(value) => Ok(value),
            Err(error) => match self.last_capacity_refusal.take().or(capacity_before) {
                Some(detail) => Err(PromptFailure::UpstreamCapacity(detail)),
                None => Err(PromptFailure::Other(error)),
            },
        }
    }

    fn run_prompt(
        &mut self,
        spec: &AgentRunSpec,
        session: &mut PromptSession,
        prompt: &str,
        purpose: PromptPurpose,
        attempt: Option<u32>,
        directive: Option<&DirectiveReceipt>,
    ) -> Result<CarrierSource, ChildError> {
        let prompt_id = self.next_id("prompt");
        session.validate_prompt_purpose(purpose)?;
        self.client
            .send_command(RpcCommand::prompt(prompt_id.clone(), prompt.to_owned()))
            .map_err(|error| error.to_string())?;
        session.turns_sent = session.turns_sent.saturating_add(1);
        if let (Some(attempt), Some(receipt)) = (attempt, directive) {
            append_attempt_event(
                spec,
                attempt,
                "continuation-dispatched",
                AttemptEventDetail::directive(receipt),
            )
            .map_err(ChildError::EvidenceWrite)?;
        }
        let mut state = CycleState::new(purpose, attempt);
        loop {
            let frame = self
                .client
                .next_frame()
                .map_err(|error| format!("agent-run rpc stream failed: {error}"))?
                .ok_or_else(|| "agent-run rpc stream ended before agent_settled".to_owned())?;
            match frame {
                RpcFrame::Response(response) => {
                    self.handle_response(spec, &mut state, &prompt_id, response)?;
                }
                RpcFrame::Event(RpcEvent::AgentSettled) => {
                    if !state.prompt_response_seen {
                        return Err(ChildError::Fatal(
                            "agent-run prompt response missing before agent_settled".to_owned(),
                        ));
                    }
                    while !state.pending_stats.is_empty() {
                        let frame = self
                            .client
                            .next_frame()
                            .map_err(|error| format!("agent-run rpc stream failed: {error}"))?
                            .ok_or_else(|| {
                                "agent-run rpc stream ended before session stats response"
                                    .to_owned()
                            })?;
                        match frame {
                            RpcFrame::Response(response) => {
                                self.handle_response(spec, &mut state, &prompt_id, response)?;
                            }
                            RpcFrame::Event(event) => {
                                return Err(ChildError::Fatal(format!(
                                    "agent-run rpc event after agent_settled while awaiting stats: {event:?}"
                                )));
                            }
                        }
                    }
                    return self.finish_cycle(spec, session, state);
                }
                RpcFrame::Event(event) => self.handle_event(spec, &mut state, event)?,
            }
        }
    }

    fn handle_response(
        &mut self,
        spec: &AgentRunSpec,
        state: &mut CycleState,
        prompt_id: &str,
        response: RpcResponse,
    ) -> Result<(), String> {
        match response.command {
            RpcCommandKind::Prompt if response.id == prompt_id => {
                state.prompt_response_seen = true;
                Ok(())
            }
            RpcCommandKind::Steer => {
                state.steer_response_seen = true;
                Ok(())
            }
            RpcCommandKind::GetSessionStats => {
                state.pending_stats.remove(&response.id);
                self.handle_stats(spec, state, &response)
            }
            RpcCommandKind::Abort => Ok(()),
            other => Err(format!(
                "agent-run unexpected rpc response command during prompt: {other:?}"
            )),
        }
    }

    fn handle_event(
        &mut self,
        spec: &AgentRunSpec,
        state: &mut CycleState,
        event: RpcEvent,
    ) -> Result<(), String> {
        match event {
            RpcEvent::MessageStart => {
                if state.steer_queue_seen {
                    state.steer_message_started = true;
                }
                Ok(())
            }
            RpcEvent::QueueUpdate { steering, .. } => {
                if state.awaiting_handoff && steering > 0 {
                    state.steer_queue_seen = true;
                }
                Ok(())
            }
            RpcEvent::MessageEnd { message } => self.handle_message_end(spec, state, message),
            RpcEvent::ToolExecutionStart => {
                if state.final_record.is_some() || state.tool_terminal.is_some() {
                    state.tool_after_terminal = true;
                }
                Ok(())
            }
            RpcEvent::ToolExecutionEnd {
                tool_call_id,
                tool_name,
                details,
                is_error,
                terminate,
            } => {
                state.tool_execution_count = state.tool_execution_count.saturating_add(1);
                state.last_tool_name = Some(tool_name.clone());
                if state.final_record.is_some() || state.tool_terminal.is_some() {
                    state.tool_after_terminal = true;
                }
                if kernel::generated::TERMINAL_PROFILES
                    .iter()
                    .any(|profile| profile.1 == tool_name)
                {
                    if is_error || !terminate {
                        return Err(format!(
                            "agent-run terminating submit tool {tool_name} completed with isError={is_error} terminate={terminate}"
                        ));
                    }
                    let details_value = details.ok_or_else(|| {
                        format!("agent-run submit tool {tool_name} returned no details")
                    })?;
                    let parsed: ToolCarrierDetails = serde_json::from_value(details_value.clone())
                        .map_err(|error| {
                            format!("agent-run submit tool {tool_name} details malformed: {error}")
                        })?;
                    state.tool_terminal_count = state.tool_terminal_count.saturating_add(1);
                    state.terminal_count = state.terminal_count.saturating_add(1);
                    state.tool_terminal = Some(ToolTerminal {
                        tool_name,
                        tool_call_id,
                        details: parsed,
                        details_value,
                        continuation_provenance: None,
                    });
                }
                self.request_stats(state)
            }
            RpcEvent::AgentEnd { will_retry } => {
                let _ = will_retry;
                Ok(())
            }
            RpcEvent::CompactionStart {
                reason: CompactionReason::Threshold | CompactionReason::Overflow,
            } => Err("agent-run Pi attempted automatic compaction".to_owned()),
            RpcEvent::EntryAppended { entry } => Err(format!(
                "agent-run child appended unexpected entry {} after bootstrap",
                entry.custom_type
            )),
            _ => Ok(()),
        }
    }

    fn handle_message_end(
        &mut self,
        spec: &AgentRunSpec,
        state: &mut CycleState,
        message: TerminalMessage,
    ) -> Result<(), String> {
        if message.role == "toolResult" {
            let call_id = message
                .tool_call_id
                .ok_or_else(|| "agent-run toolResult missing toolCallId".to_owned())?;
            if !state.tool_result_call_ids.insert(call_id.clone()) {
                return Err(format!(
                    "agent-run received duplicate toolResult for {call_id}"
                ));
            }
            let Some(details) = message.details else {
                return Ok(());
            };
            if state
                .tool_result_details
                .insert(call_id.clone(), details)
                .is_some()
            {
                return Err(format!(
                    "agent-run received duplicate toolResult details for {call_id}"
                ));
            }
            return Ok(());
        }
        if message.role != "assistant" {
            return Ok(());
        }
        state.assistant_message_count = state.assistant_message_count.saturating_add(1);
        state.last_stop_reason = message
            .stop_reason
            .as_deref()
            .map(|value| value.to_ascii_lowercase());
        // An upstream capacity refusal arrives as a terminal with no text and a
        // provider errorMessage. Record it and let the cycle drain normally:
        // returning early here would abandon the stream before the prompt
        // response is consumed and mask the real cause.
        if let Some(detail) = upstream_capacity_failure(&message) {
            state.upstream_capacity_failure = Some(detail);
            return self.request_stats(state);
        }
        // A usable assistant message means Pi's own auto-retry already replaced
        // an earlier refusal in this same cycle. Pi's recovery is authoritative,
        // so the superseded refusal must not outlive it.
        state.upstream_capacity_failure = None;
        let terminal_failure = TerminalFailureDiagnostic::from_message(&message);
        let record = assistant_from_terminal(message)?;
        if record.stop_reason == "tooluse" {
            validate_assistant_identity(&record, &spec.provider, &spec.model)?;
            self.request_stats(state)?;
            return Ok(());
        }
        if record.stop_reason != "stop" {
            let attempt = state.attempt.ok_or_else(|| {
                "agent-run terminal assistant hard-fail missing attempt context".to_owned()
            })?;
            append_attempt_event(
                spec,
                attempt,
                "terminal-assistant-hard-fail",
                AttemptEventDetail::terminal_failure(&terminal_failure),
            )
            .map_err(|error| error.to_string())?;
        }
        validate_terminal_assistant(&record, &spec.provider, &spec.model)?;
        if state.awaiting_handoff && state.steer_message_started {
            let handoff = self
                .policy
                .validate_handoff_text(&spec.role_id.0, &record.text)?;
            let checkpoint = self.checkpoint_record(spec, handoff.clone())?;
            self.compact_checkpoint(&checkpoint)?;
            state.compacted = true;
            state.handoff = Some(handoff);
            self.request_stats(state)?;
            return Ok(());
        }
        if state.final_record.as_ref().map(|item| &item.record) != Some(&record) {
            state.assistant_terminal_count = state.assistant_terminal_count.saturating_add(1);
            state.final_record = Some(CycleTerminal {
                record,
                delivered_after_steer: state.steer_message_started,
            });
        }
        self.request_stats(state)
    }

    fn handle_stats(
        &mut self,
        spec: &AgentRunSpec,
        state: &mut CycleState,
        response: &RpcResponse,
    ) -> Result<(), String> {
        let (actual_session, budget) = context_budget_from_stats(response)?;
        if actual_session
            .as_deref()
            .is_some_and(|actual| actual != spec.session_id.0.as_str())
        {
            return Err(format!(
                "agent-run session continuity lost: expected {}, got {}",
                spec.session_id.0,
                actual_session.expect("checked present")
            ));
        }
        match budget {
            ContextBudget::Unknown => {
                let decision = checkpoint::observe_context(
                    ContextBudget::Unknown,
                    &checkpoint::AssignmentState::<
                        Option<kernel::generated::Id>,
                        Option<kernel::generated::Sha>,
                        Option<kernel::generated::Sha>,
                    > {
                        assignment_id: spec.assignment_id.clone(),
                        lane_id: None,
                        run_revision: spec.run_revision,
                        base_commit: None,
                        current_commit: None,
                        dirty_paths: Vec::new(),
                        completed: Vec::new(),
                        remaining: vec![spec.assignment_id.clone()],
                        next_action: "continue".to_owned(),
                        session_ref: kernel::generated::Ref(format!(
                            "session:{}",
                            spec.session_id.0
                        )),
                    },
                )
                .map_err(|error| format!("agent-run context observation failed: {error:?}"))?;
                if state.compacted {
                    let handoff = state.handoff.clone().ok_or_else(|| {
                        "agent-run compacted checkpoint missing retained handoff".to_owned()
                    })?;
                    let checkpoint = self.checkpoint_record(spec, handoff)?;
                    let outcome = decision.apply_action(ContextAction::InjectRetainedHandoff(
                        checkpoint.resume_overlay.clone(),
                    ));
                    return match outcome {
                        Ok(checkpoint::ContextActionOutcome::ResumeOnly { .. }) => Ok(()),
                        Ok(checkpoint::ContextActionOutcome::Allowed) => Err(
                            "agent-run context action allowed non-resume during unknown budget"
                                .to_owned(),
                        ),
                        Err(error) => Err(format!(
                            "agent-run context budget unknown rejected retained handoff recovery: {error:?}"
                        )),
                    };
                }
                if state.final_record.is_some() || state.tool_terminal.is_some() {
                    if !decision.allows_terminal_success() {
                        return Err(
                            "agent-run context budget unknown blocks terminal success: UnknownBlocksTerminalSuccess".to_owned(),
                        );
                    }
                } else if !decision.allows_new_work() {
                    return Err(
                        "agent-run context budget unknown blocks new work: UnknownBlocksWork"
                            .to_owned(),
                    );
                }
            }
            ContextBudget::Known(percent) => {
                let percent_value = percent.as_f64();
                self.last_known_percent = Some(percent_value);
                if percent_value >= 75.0 {
                    let _ = checkpoint::observe_context(
                        ContextBudget::Known(percent),
                        &checkpoint::AssignmentState::<
                            Option<kernel::generated::Id>,
                            Option<kernel::generated::Sha>,
                            Option<kernel::generated::Sha>,
                        > {
                            assignment_id: spec.assignment_id.clone(),
                            lane_id: None,
                            run_revision: spec.run_revision,
                            base_commit: None,
                            current_commit: None,
                            dirty_paths: Vec::new(),
                            completed: Vec::new(),
                            remaining: vec![spec.assignment_id.clone()],
                            next_action: "continue".to_owned(),
                            session_ref: kernel::generated::Ref(format!(
                                "session:{}",
                                spec.session_id.0
                            )),
                        },
                    );
                    self.checkpoint_armed = true;
                }
                if percent_value >= 85.0
                    && state.purpose == PromptPurpose::Normal
                    && !state.awaiting_handoff
                {
                    self.start_checkpoint(spec, state)?;
                }
            }
        }
        Ok(())
    }

    fn start_checkpoint(
        &mut self,
        spec: &AgentRunSpec,
        state: &mut CycleState,
    ) -> Result<(), String> {
        let role = self.policy.role(&spec.role_id.0)?;
        if !role.interruptible {
            return Err(format!(
                "agent-run role `{}` is not interruptible; checkpoint refused",
                spec.role_id.0
            ));
        }
        let prompt = self.handoff_prompt(spec)?;
        let id = self.next_id("steer-handoff");
        self.client
            .send_command(RpcCommand::steer(id, prompt))
            .map_err(|error| error.to_string())?;
        state.awaiting_handoff = true;
        Ok(())
    }

    fn finish_cycle(
        &mut self,
        spec: &AgentRunSpec,
        session: &mut PromptSession,
        state: CycleState,
    ) -> Result<CarrierSource, ChildError> {
        // Surface a launch-side refusal ahead of output-shape checks: there is
        // no assistant output to judge, and the caller retries on this marker.
        if let Some(detail) = state.upstream_capacity_failure {
            self.last_capacity_refusal = Some(detail.clone());
            return Err(ChildError::Fatal(format!(
                "agent-run upstream capacity refusal: {detail}"
            )));
        }
        if state.tool_terminal_count > 0 {
            if state.tool_terminal_count != 1 {
                return Err(ChildError::TerminalMiss(TerminalMiss::MultipleTerminals {
                    count: u32::try_from(state.tool_terminal_count).unwrap_or(u32::MAX),
                }));
            }
            if state.tool_after_terminal {
                return Err(ChildError::Fatal(
                    "agent-run Pi JSONL had tool activity after terminal result".to_owned(),
                ));
            }
            if state.final_record.is_some() {
                return Err(ChildError::TerminalMiss(TerminalMiss::MultipleTerminals {
                    count: u32::try_from(
                        state
                            .tool_terminal_count
                            .saturating_add(state.assistant_terminal_count),
                    )
                    .unwrap_or(u32::MAX),
                }));
            }
            let terminal = state
                .tool_terminal
                .ok_or_else(|| "agent-run terminating tool count without carrier".to_owned())?;
            let duplicate = state
                .tool_result_details
                .get(&terminal.tool_call_id)
                .ok_or_else(|| {
                    format!(
                        "agent-run terminating tool missing correlated toolResult details for {}",
                        terminal.tool_call_id
                    )
                })?;
            if duplicate != &terminal.details_value {
                return Err(ChildError::Fatal(format!(
                    "agent-run tool details drift between tool_execution_end and toolResult for {}",
                    terminal.tool_call_id
                )));
            }
            // Deliberately NOT asserting tool_result_details.len() == 1: ordinary Pi
            // tools (grep, and others) legitimately attach a `details` payload, so a
            // worker that greps before submitting has several details-bearing tool
            // results. The real invariant is that exactly ONE TERMINATING submit
            // result exists (checked above via tool_terminal_count) and that its
            // details correlate by tool_call_id and do not drift (both checked
            // immediately above). Counting unrelated tools' details asserted nothing
            // about submit correctness and rejected valid runs.
            return Ok(CarrierSource::Tool(terminal));
        }
        if state.tool_after_terminal {
            return Err(ChildError::Fatal(
                "agent-run Pi JSONL had tool activity after terminal result".to_owned(),
            ));
        }
        if let Some(handoff) = state.handoff {
            let checkpoint = self.checkpoint_record(spec, handoff)?;
            if !state.compacted {
                self.compact_checkpoint(&checkpoint)?;
            }
            let resume = self.resume_prompt(&checkpoint.resume_overlay)?;
            return self.run_prompt(
                spec,
                session,
                &resume,
                PromptPurpose::Resume,
                state.attempt,
                None,
            );
        }
        if state.awaiting_handoff {
            self.abort_stale_queue()?;
            let handoff_prompt = self.handoff_prompt(spec)?;
            return self.run_prompt(
                spec,
                session,
                &handoff_prompt,
                PromptPurpose::Handoff,
                state.attempt,
                None,
            );
        }
        if state.terminal_count == 0 {
            return Err(ChildError::TerminalMiss(classify_terminal_miss(
                spec, &state,
            )?));
        }
        Err(ChildError::Fatal(
            "agent-run Pi JSONL contained no accepted carrier despite terminal result count"
                .to_owned(),
        ))
    }

    fn request_stats(&mut self, state: &mut CycleState) -> Result<(), String> {
        let id = self.next_id("stats");
        self.client
            .send_command(RpcCommand::get_session_stats(id.clone()))
            .map_err(|error| error.to_string())?;
        state.pending_stats.insert(id);
        Ok(())
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
                "agent-run terminal miss: {}",
                terminal_miss_message(&TerminalMiss::TerminalToolNotOffered {
                    source: TerminalToolNotOfferedSource::PrePromptActiveTools,
                    expected_tool: profile.1.to_owned(),
                    offered_tools: active,
                })
            ));
        }
        if active != expected {
            return Err(format!(
                "agent-run active tools drift before prompt: expected {expected:?}, got {active:?}"
            ));
        }
        Ok(())
    }

    fn validate_state(&self, spec: &AgentRunSpec, response: &RpcResponse) -> Result<(), String> {
        let data = response
            .data
            .as_ref()
            .ok_or_else(|| "agent-run get_state missing data".to_owned())?;
        let value: Value = serde_json::from_str(data)
            .map_err(|error| format!("agent-run get_state malformed data: {error}"))?;
        let startup_already_validated = Self::validate_startup_session_history(spec, &value)?;
        let session = value.get("sessionId").and_then(Value::as_str);
        let thinking = value.get("thinkingLevel").and_then(Value::as_str);
        let auto = value.get("autoCompactionEnabled").and_then(Value::as_bool);
        let model = value
            .get("model")
            .and_then(Value::as_object)
            .ok_or_else(|| "agent-run get_state missing model".to_owned())?;
        let provider = model.get("provider").and_then(Value::as_str);
        let model_id = model.get("id").and_then(Value::as_str);
        if session != Some(spec.session_id.0.as_str())
            || provider != Some(spec.provider.as_str())
            || model_id != Some(spec.model.as_str())
            || thinking != Some(spec.thinking.0.as_str())
            || auto != Some(false)
        {
            return Err(format!(
                "agent-run get_state drift: session={session:?} provider={provider:?} model={model_id:?} thinking={thinking:?} autoCompaction={auto:?}"
            ));
        }
        if !startup_already_validated {
            Self::write_startup_validation_marker(spec)?;
        }
        Ok(())
    }

    fn validate_startup_session_history(
        spec: &AgentRunSpec,
        state: &Value,
    ) -> Result<bool, String> {
        if Self::startup_validation_marker_matches(spec)? {
            Self::validate_restart_session_history(spec, state)?;
            Ok(true)
        } else {
            Self::validate_session_history(spec, state)?;
            Ok(false)
        }
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

    fn validate_restart_session_history(spec: &AgentRunSpec, state: &Value) -> Result<(), String> {
        let message_count = state
            .get("messageCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| "agent-run get_state missing messageCount".to_owned())?;
        match spec.session_continuity {
            SessionContinuity::Fresh => Ok(()),
            SessionContinuity::Resume if message_count == 0 => Err(format!(
                "agent-run resume without history: assignment {} authorizes resume but session {} is empty",
                spec.assignment_id.0, spec.session_id.0
            )),
            SessionContinuity::Resume => Ok(()),
        }
    }

    fn startup_validation_marker_matches(spec: &AgentRunSpec) -> Result<bool, String> {
        let path = startup_validation_marker_path(spec)?;
        match fs::read(&path) {
            Ok(bytes) => {
                let marker: StartupValidationMarker =
                    serde_json::from_slice(&bytes).map_err(|error| {
                        format!(
                            "agent-run startup validation marker malformed {}: {error}",
                            path.display()
                        )
                    })?;
                Ok(marker == StartupValidationMarker::new(spec))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!(
                "agent-run startup validation marker read failed {}: {error}",
                path.display()
            )),
        }
    }

    fn write_startup_validation_marker(spec: &AgentRunSpec) -> Result<(), String> {
        let path = startup_validation_marker_path(spec)?;
        let parent = path.parent().ok_or_else(|| {
            format!(
                "agent-run startup validation marker path has no parent: {:?}",
                path
            )
        })?;
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "agent-run startup validation marker mkdir failed {}: {error}",
                parent.display()
            )
        })?;
        let marker = StartupValidationMarker::new(spec);
        let data = serde_json::to_vec_pretty(&marker).map_err(|error| {
            format!("agent-run startup validation marker serialize failed: {error}")
        })?;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(&data).map_err(|error| {
                    format!(
                        "agent-run startup validation marker write failed {}: {error}",
                        path.display()
                    )
                })?;
                file.sync_all().map_err(|error| {
                    format!(
                        "agent-run startup validation marker fsync failed {}: {error}",
                        path.display()
                    )
                })?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if Self::startup_validation_marker_matches(spec)? {
                    Ok(())
                } else {
                    Err(format!(
                        "agent-run startup validation marker drift at {}",
                        path.display()
                    ))
                }
            }
            Err(error) => Err(format!(
                "agent-run startup validation marker create failed {}: {error}",
                path.display()
            )),
        }
    }

    fn checkpoint_record(
        &self,
        spec: &AgentRunSpec,
        handoff: AgentHandoff,
    ) -> Result<checkpoint::CheckpointRecord, String> {
        let percent = self
            .last_known_percent
            .ok_or_else(|| "agent-run checkpoint missing known context percent".to_owned())?;
        let input = if matches!(
            spec.assignment_kind,
            kernel::generated::ValidationAssignmentKind::Delivery
        ) {
            let lane_id = spec
                .lane_id
                .clone()
                .ok_or_else(|| "agent-run checkpoint missing lane_id".to_owned())?;
            let base = spec
                .base_commit
                .clone()
                .ok_or_else(|| "agent-run checkpoint missing base_commit".to_owned())?;
            CheckpointInput::execution(
                spec.assignment_id.clone(),
                spec.run_revision,
                kernel::generated::Ref(format!("session:{}", spec.session_id.0)),
                lane_id,
                base.clone(),
                base,
                checkpoint::PreservationEvidence::CleanCurrentCommit {
                    commit: spec
                        .base_commit
                        .clone()
                        .ok_or_else(|| "agent-run checkpoint missing base_commit".to_owned())?,
                },
                handoff,
            )
        } else {
            CheckpointInput::planning(
                spec.assignment_id.clone(),
                spec.run_revision,
                kernel::generated::Ref(format!("session:{}", spec.session_id.0)),
                handoff,
            )
        };
        input
            .render_checkpoint(checkpoint::ContextPercent::new(percent).map_err(|error| {
                format!("agent-run context percent invalid during checkpoint: {error:?}")
            })?)
            .map_err(|error| format!("agent-run checkpoint identity error: {error:?}"))
    }

    fn compact_checkpoint(
        &mut self,
        checkpoint: &checkpoint::CheckpointRecord,
    ) -> Result<(), String> {
        self.manual_compact(checkpoint)
            .map_err(|error| format!("agent-run manual compaction failed: {error}"))
    }

    fn handoff_prompt(&self, spec: &AgentRunSpec) -> Result<String, String> {
        let slots = self.policy.required_slot_names(&spec.role_id.0)?;
        Ok(format!(
            "Checkpoint now. Return exactly one JSON object with schema autopilot.agent-handoff.v1. Required top-level fields: schema, completed, remaining, critical_state, next_action. critical_state must include these role-required slots exactly: {}. Do not include prose or a code fence.",
            slots.join(", ")
        ))
    }

    fn resume_prompt(&self, overlay: &checkpoint::ResumeOverlay) -> Result<String, String> {
        let overlay = serde_json::to_string(overlay)
            .map_err(|error| format!("agent-run resume overlay serialize failed: {error}"))?;
        Ok(format!(
            "Resume the same assignment from this parent-retained handoff. Treat it as authoritative preserved state and continue the original task without inventing completed work. Handoff overlay JSON: {overlay}"
        ))
    }

    fn abort_stale_queue(&mut self) -> Result<(), String> {
        let id = self.next_id("abort");
        self.client
            .send_command(RpcCommand {
                id: id.clone(),
                command: RpcCommandKind::Abort,
                message: None,
                enabled: None,
                custom_instructions: None,
            })
            .map_err(|error| error.to_string())?;
        loop {
            let frame = self
                .client
                .next_frame()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "agent-run rpc stream ended before abort response".to_owned())?;
            if let RpcFrame::Response(response) = frame {
                if response.id == id {
                    return Ok(());
                }
                if response.command == RpcCommandKind::Steer {
                    continue;
                }
                return Err(format!(
                    "agent-run unexpected response while aborting stale queue: {}",
                    response.id
                ));
            }
        }
    }

    fn next_id(&mut self, prefix: &str) -> String {
        self.next_command = self.next_command.saturating_add(1);
        format!("{prefix}-{}", self.next_command)
    }

    fn shutdown(&mut self) -> Result<(), String> {
        let shutdown = self
            .client
            .shutdown(Duration::from_millis(250))
            .map_err(|error| error.to_string())?;
        let diagnostics = self.client.diagnostics();
        write_rpc_stats_if_requested(&diagnostics)?;
        if shutdown.escalated {
            return Err("agent-run rpc shutdown escalated after stdin close".to_owned());
        }
        match shutdown.status {
            Some(status) if !status.success() => {
                return Err(format!("agent-run pi exited nonzero status={status}"));
            }
            _ => {}
        }
        Ok(())
    }
}

#[allow(dead_code)]
struct RpcCompactor<'a> {
    runner: &'a mut RpcAssignment,
}

impl checkpoint::Compactor for RpcCompactor<'_> {
    fn compact_same_session(
        &mut self,
        checkpoint: &checkpoint::CheckpointRecord,
    ) -> Result<(), Failure> {
        self.runner
            .manual_compact(checkpoint)
            .map_err(|_| Failure::Transient {
                retry: RetryPolicy::AfterRestart,
            })
    }
}

impl RpcAssignment {
    fn manual_compact(&mut self, checkpoint: &checkpoint::CheckpointRecord) -> Result<(), String> {
        let slots = self
            .policy
            .required_slot_names_from_handoff(&checkpoint.resume_overlay.handoff)?;
        let instructions = format!(
            "Manual parent-controlled autopilot checkpoint compaction. Preserve the assignment handoff exactly, especially role-required critical_state slots: {}. Do not infer completed work that is absent from the handoff.",
            slots.join(", ")
        );
        let id = self.next_id("compact");
        self.client
            .send_command(RpcCommand::compact(id.clone(), instructions))
            .map_err(|error| error.to_string())?;
        let mut saw_start = false;
        let mut saw_end = false;
        let mut saw_response = false;
        loop {
            let frame = self
                .client
                .next_frame()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "agent-run rpc stream ended during compaction".to_owned())?;
            match frame {
                RpcFrame::Response(response) if response.id == id => {
                    saw_response = true;
                }
                RpcFrame::Response(response) => {
                    return Err(format!(
                        "agent-run unexpected response during compaction: {}",
                        response.id
                    ));
                }
                RpcFrame::Event(RpcEvent::CompactionStart {
                    reason: CompactionReason::Manual,
                }) => saw_start = true,
                RpcFrame::Event(RpcEvent::CompactionEnd {
                    reason: CompactionReason::Manual,
                    aborted: false,
                    ..
                }) => saw_end = true,
                RpcFrame::Event(RpcEvent::CompactionEnd { aborted: true, .. }) => {
                    return Err("agent-run manual compaction aborted".to_owned());
                }
                RpcFrame::Event(RpcEvent::CompactionStart { reason }) => {
                    return Err(format!(
                        "agent-run non-manual compaction reason during manual compact: {reason:?}"
                    ));
                }
                RpcFrame::Event(event) => {
                    return Err(format!(
                        "agent-run unexpected rpc event during manual compaction: {event:?}"
                    ));
                }
            }
            if saw_start && saw_end && saw_response {
                return Ok(());
            }
        }
    }
}

fn context_budget_from_stats(
    response: &RpcResponse,
) -> Result<(Option<String>, ContextBudget), String> {
    let data = response
        .data
        .as_ref()
        .ok_or_else(|| "agent-run get_session_stats missing data".to_owned())?;
    let value: Value = serde_json::from_str(data)
        .map_err(|error| format!("agent-run get_session_stats malformed data: {error}"))?;
    let session = value
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let Some(context) = value.get("contextUsage") else {
        return Ok((session, ContextBudget::Unknown));
    };
    let budget = match context.get("percent") {
        Some(Value::Null) | None => Ok(ContextBudget::Unknown),
        Some(Value::Number(number)) => checkpoint::ContextBudget::known(
            number
                .as_f64()
                .ok_or_else(|| "agent-run context percent was not finite f64".to_owned())?,
        )
        .map_err(|error| format!("agent-run context percent invalid: {error:?}")),
        _ => Err("agent-run context percent has wrong type".to_owned()),
    }?;
    Ok((session, budget))
}

/// Bounded retry policy for launch-side upstream capacity refusals.
///
/// Declared in `data/recovery.kdl` rather than hardcoded, so the retry budget
/// is operator-visible data alongside the value-repair policy it complements.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) struct CapacityRetryPolicy {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl CapacityRetryPolicy {
    pub(crate) fn parse() -> Result<Self, String> {
        Self::parse_source(include_str!("../../../data/recovery.kdl"))
    }

    pub(crate) fn parse_source(source: &str) -> Result<Self, String> {
        let line = source
            .lines()
            .map(str::trim)
            .find_map(|line| line.strip_prefix("upstream_capacity_retry "))
            .ok_or_else(|| "recovery policy missing upstream_capacity_retry".to_owned())?;
        let field = |key: &str| -> Result<u64, String> {
            let start = line
                .find(key)
                .ok_or_else(|| format!("upstream_capacity_retry missing {key}"))?
                + key.len();
            let rest = &line[start..];
            let end = rest
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(rest.len());
            rest[..end]
                .parse::<u64>()
                .map_err(|_| format!("upstream_capacity_retry {key} is not a number"))
        };
        let max_retries = u32::try_from(field("max_retries=")?)
            .map_err(|_| "upstream_capacity_retry max_retries out of range".to_owned())?;
        let base_delay_ms = field("base_delay_ms=")?;
        let max_delay_ms = field("max_delay_ms=")?;
        if max_retries == 0 || base_delay_ms == 0 || max_delay_ms < base_delay_ms {
            return Err("upstream_capacity_retry bounds are incoherent".to_owned());
        }
        Ok(Self {
            max_retries,
            base_delay_ms,
            max_delay_ms,
        })
    }

    /// Exponential backoff with deterministic per-assignment jitter.
    ///
    /// Jitter is derived from the assignment id rather than a random source so
    /// the schedule is reproducible in tests, while still de-synchronising the
    /// children of one wave, which are launched within milliseconds of one
    /// another and would otherwise retry in lockstep and re-create the burst.
    pub(crate) fn backoff(self, retry: u32, assignment_id: &str) -> Duration {
        let factor = 1_u64 << retry.min(16);
        let base = self
            .base_delay_ms
            .saturating_mul(factor)
            .min(self.max_delay_ms);
        let spread = base / 2;
        let jitter = if spread == 0 {
            0
        } else {
            let digest = sha256_hex(format!("{assignment_id}:{retry}").as_bytes());
            u64::from_str_radix(&digest[..8], 16).unwrap_or(0) % spread
        };
        Duration::from_millis(base.saturating_sub(spread / 2).saturating_add(jitter))
    }
}

/// Outcome classes for one prompt cycle.
///
/// Typed rather than a string marker so the retry decision is made on a
/// variant, never by inspecting message text.
#[derive(Debug, Clone, Eq, PartialEq)]
enum PromptFailure {
    /// Launch-side refusal by the provider: no content was produced and no
    /// tokens were billed, so the identical prompt may be re-sent.
    UpstreamCapacity(String),
    /// Any other failure, including content failures that terminal continuation
    /// or value repair owns.
    Other(ChildError),
}

impl PromptFailure {
    fn into_child_error(self) -> ChildError {
        match self {
            Self::UpstreamCapacity(detail) => {
                ChildError::Fatal(format!("agent-run upstream capacity refusal: {detail}"))
            }
            Self::Other(error) => error,
        }
    }
}

impl From<String> for PromptFailure {
    fn from(message: String) -> Self {
        Self::Other(ChildError::Fatal(message))
    }
}

fn classify_terminal_miss(
    spec: &AgentRunSpec,
    state: &CycleState,
) -> Result<TerminalMiss, ChildError> {
    let (expected_tool, offered_tools) = expected_terminal_tool_and_offered(spec)?;
    if !offered_tools.iter().any(|tool| tool == &expected_tool) {
        return Ok(TerminalMiss::TerminalToolNotOffered {
            source: TerminalToolNotOfferedSource::TerminalCycleOfferedTools,
            expected_tool,
            offered_tools,
        });
    }
    let tool_execution_count = u32::try_from(state.tool_execution_count).unwrap_or(u32::MAX);
    if let Some(final_record) = &state.final_record {
        let text = &final_record.record.text;
        if text.is_empty() {
            return Ok(TerminalMiss::EmptyStopNoTerminal {
                tool_execution_count,
                last_tool_name: state.last_tool_name.clone(),
            });
        }
        return Ok(TerminalMiss::ProseInsteadOfTerminal {
            text_len: text.chars().count(),
            text_digest: sha256_array(text.as_bytes()),
            preview: crate::evidence::bound_detail(text),
            tool_execution_count,
        });
    }
    Ok(TerminalMiss::NoTerminalFrame {
        messages_seen: u32::try_from(state.assistant_message_count).unwrap_or(u32::MAX),
        last_stop_reason: state.last_stop_reason.clone(),
    })
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct OfferedTerminalTool {
    name: String,
    offered_tools: Vec<String>,
}

impl OfferedTerminalTool {
    fn new(spec: &AgentRunSpec) -> Result<Self, TerminalMiss> {
        let (expected_tool, offered_tools) =
            expected_terminal_tool_and_offered(spec).map_err(|error| {
                TerminalMiss::NoTerminalFrame {
                    messages_seen: 0,
                    last_stop_reason: Some(error.into_message()),
                }
            })?;
        if !offered_tools.iter().any(|tool| tool == &expected_tool) {
            return Err(TerminalMiss::TerminalToolNotOffered {
                source: TerminalToolNotOfferedSource::OfferedTerminalToolGuard,
                expected_tool,
                offered_tools,
            });
        }
        Ok(Self {
            name: expected_tool,
            offered_tools,
        })
    }
}

const STARTUP_VALIDATION_MARKER_SCHEMA: &str = "pa.child-startup-session-validation.v1";

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
struct StartupValidationMarker {
    schema: String,
    assignment_id: String,
    run_id: String,
    session_id: String,
    session_dir: String,
    session_continuity: SessionContinuity,
}

impl StartupValidationMarker {
    fn new(spec: &AgentRunSpec) -> Self {
        Self {
            schema: STARTUP_VALIDATION_MARKER_SCHEMA.to_owned(),
            assignment_id: spec.assignment_id.0.clone(),
            run_id: spec.run_id.0.clone(),
            session_id: spec.session_id.0.clone(),
            session_dir: spec.session_dir.0.clone(),
            session_continuity: spec.session_continuity.clone(),
        }
    }
}

fn startup_validation_marker_path(spec: &AgentRunSpec) -> Result<PathBuf, String> {
    let carrier = PathBuf::from(&spec.carrier_path.0);
    let file_name = format!("{}.session-start.json", spec.session_id.0);
    let path = carrier.with_file_name(file_name);
    super::reject_link_components_for_path(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct PromptSession {
    expected: SessionId,
    session_digest: String,
    turns_sent: u32,
}

impl PromptSession {
    fn new(spec: &AgentRunSpec) -> Self {
        Self {
            expected: SessionId(spec.session_id.0.clone()),
            session_digest: sha256_hex(spec.session_id.0.as_bytes()),
            turns_sent: 0,
        }
    }

    fn validate_prompt_purpose(&self, purpose: PromptPurpose) -> Result<(), ChildError> {
        if matches!(purpose, PromptPurpose::Handoff | PromptPurpose::Resume) && self.turns_sent == 0
        {
            return Err(ChildError::Fatal(format!(
                "agent-run prompt session reset before {purpose:?} continuation for session {}",
                self.expected.0
            )));
        }
        Ok(())
    }
}

fn terminal_continuation_prompt_error(
    source: ChildError,
    trace: TerminalTrace,
) -> TerminalContinuationError {
    TerminalContinuationError::Prompt {
        source: Box::new(source),
        trace: Box::new(trace),
    }
}

fn terminal_continuation_terminal_error(
    miss: TerminalMiss,
    trace: TerminalTrace,
) -> TerminalContinuationError {
    TerminalContinuationError::Terminal {
        miss: Box::new(miss),
        trace: Box::new(trace),
    }
}

fn append_terminal_event_or_error(
    spec: &AgentRunSpec,
    attempt: u32,
    event: &str,
    detail: AttemptEventDetail<'_>,
    primary: TerminalContinuationError,
) -> Result<(), TerminalContinuationError> {
    append_attempt_event(spec, attempt, event, detail).map_err(|evidence| {
        TerminalContinuationError::EvidenceWrite {
            primary: Box::new(primary),
            evidence,
        }
    })
}

fn parse_session_continuity_lost(message: &str) -> Option<(String, String)> {
    let rest = message.strip_prefix("agent-run session continuity lost: expected ")?;
    let (expected, actual) = rest.split_once(", got ")?;
    Some((expected.to_owned(), actual.to_owned()))
}

fn attach_continuation_provenance(source: &mut CarrierSource, trace: &TerminalTrace) {
    let CarrierSource::Tool(terminal) = source;
    if terminal.continuation_provenance.is_some() {
        return;
    }
    let session_digest = trace
        .directives
        .last()
        .map(|directive| directive.session_digest.clone())
        .unwrap_or_default();
    terminal.continuation_provenance = Some(ContinuationProvenance {
        attempts_made: trace.attempts_made.saturating_add(1),
        classes: trace.classes.clone(),
        directive_digests: trace
            .directives
            .iter()
            .map(|directive| directive.sha256.clone())
            .collect(),
        session_digest,
        dispatch_receipts: trace.directives.clone(),
        terminal_call_id: terminal.tool_call_id.clone(),
    });
}

fn expected_terminal_tool_and_offered(
    spec: &AgentRunSpec,
) -> Result<(String, Vec<String>), ChildError> {
    let profile = super::terminal_profile_for(
        &spec.role_id.0,
        &spec.boundary_id.0,
        &spec.result_contract.0,
    )
    .map_err(|error| ChildError::Fatal(error.to_string()))?;
    let mut offered_tools = spec
        .allowed_tools
        .iter()
        .map(|tool| tool.0.clone())
        .collect::<Vec<_>>();
    offered_tools.sort();
    Ok((profile.1.to_owned(), offered_tools))
}

fn terminal_miss_message(miss: &TerminalMiss) -> String {
    match miss {
        TerminalMiss::ProseInsteadOfTerminal {
            text_len,
            text_digest,
            preview,
            tool_execution_count,
        } => format!(
            "class=prose-instead-of-terminal text_len={text_len} text_digest={} preview={:?} tool_execution_count={tool_execution_count}; assistant text discarded; selected terminating tool result is required",
            hex_digest(text_digest),
            preview
        ),
        TerminalMiss::EmptyStopNoTerminal {
            tool_execution_count,
            last_tool_name,
        } => format!(
            "class=empty-stop-no-terminal tool_execution_count={tool_execution_count} last_tool_name={}",
            last_tool_name.as_deref().unwrap_or("<none>")
        ),
        TerminalMiss::NoTerminalFrame {
            messages_seen,
            last_stop_reason,
        } => format!(
            "class=no-terminal-frame messages_seen={messages_seen} last_stop_reason={}",
            last_stop_reason.as_deref().unwrap_or("<none>")
        ),
        TerminalMiss::TerminalToolNotOffered {
            source,
            expected_tool,
            offered_tools,
        } => format!(
            "class=terminal-tool-not-offered source={} expected_tool={expected_tool} offered_tools=[{}]",
            source.as_str(),
            offered_tools.join(",")
        ),
        TerminalMiss::MultipleTerminals { count } => {
            format!("class=multiple-terminals count={count}")
        }
    }
}

const TERMINAL_DIRECTIVE_TEMPLATE_ID: &str = "terminal-continuation-directive";
const TERMINAL_DIRECTIVE_TEMPLATE_VERSION: u32 = 1;

fn render_terminal_directive(tool: &OfferedTerminalTool, miss: &TerminalMiss) -> String {
    let prose_note = if matches!(miss, TerminalMiss::ProseInsteadOfTerminal { .. }) {
        "\nAssistant prose is not accepted as a result for this role.\n"
    } else {
        ""
    };
    format!(
        "# {TERMINAL_DIRECTIVE_TEMPLATE_ID} v{TERMINAL_DIRECTIVE_TEMPLATE_VERSION}\nThe prior turn did not produce a terminating tool call.\n{prose_note}If more evidence is needed, use available tools to gather it.\nWhen the result is truthful and complete, call `{}`.\nDo not invent findings. Do not answer with prose; prose is not accepted here.",
        tool.name
    )
}

fn directive_receipt(
    directive: &str,
    attempt_index: u32,
    session: &PromptSession,
    prior_prose_digest: Option<[u8; 32]>,
) -> DirectiveReceipt {
    DirectiveReceipt {
        template_id: TERMINAL_DIRECTIVE_TEMPLATE_ID.to_owned(),
        template_version: TERMINAL_DIRECTIVE_TEMPLATE_VERSION,
        byte_len: directive.len(),
        sha256: sha256_hex(directive.as_bytes()),
        attempt_index,
        session_digest: session.session_digest.clone(),
        prior_prose_digest: prior_prose_digest.map(|digest| hex_digest(&digest)),
    }
}

fn drivers_generated_max_terminal_attempts_raw() -> u64 {
    u64::from(crate::generated::recovery::MAX_TERMINAL_ATTEMPTS)
}

/// Detect a terminal that failed upstream rather than in the model's output.
///
/// The signature is a non-`stop` terminal carrying a provider `errorMessage`
/// and no assistant text: the request was refused before any content existed.
/// This is deliberately evidence-based rather than string-matching the
/// provider's prose, which is not a stable contract.
fn upstream_capacity_failure(message: &TerminalMessage) -> Option<String> {
    let stop = message.stop_reason.as_deref()?.to_ascii_lowercase();
    if stop == "stop" || stop == "tooluse" {
        return None;
    }
    let detail = message.error_message.as_deref()?;
    if message.text.as_deref().is_some_and(|text| !text.is_empty()) {
        return None;
    }
    Some(format!("stopReason={stop}; {detail}"))
}

fn assistant_from_terminal(message: TerminalMessage) -> Result<AssistantRecord, String> {
    Ok(AssistantRecord {
        text: message
            .text
            .ok_or_else(|| "agent-run assistant message missing text".to_owned())?,
        provider: message
            .provider
            .ok_or_else(|| "agent-run assistant message missing provider".to_owned())?,
        model: message
            .model
            .ok_or_else(|| "agent-run assistant message missing model".to_owned())?,
        stop_reason: message
            .stop_reason
            .ok_or_else(|| "agent-run assistant message missing stopReason".to_owned())?
            .to_ascii_lowercase(),
    })
}

fn write_rpc_stats_if_requested(diagnostics: &RpcDiagnostics) -> Result<(), String> {
    let Some(path) = std::env::var_os("AUTOPILOT_AGENT_RUN_STATS_PATH") else {
        return Ok(());
    };
    let path = PathBuf::from(path);
    let stats = serde_json::json!({
        "stdout_total_bytes": diagnostics.total_bytes,
        "stderr_total_bytes": diagnostics.stderr_total_bytes,
        "stdout_tail_bytes": diagnostics.retained_tail_bytes,
        "stderr_tail_bytes": diagnostics.stderr_tail_bytes,
        "stdout_tail_truncated": diagnostics.total_bytes > diagnostics.retained_tail_bytes,
        "stderr_tail_truncated": diagnostics.stderr_tail_truncated,
        "stdout_lines": diagnostics.frames,
        "final_event_bytes": diagnostics.terminal_payload_bytes,
        "peak_retained_stdout_bytes": diagnostics.retained_tail_bytes,
        "peak_retained_stderr_bytes": diagnostics.stderr_tail_bytes,
        "stdout_retention_limit": DEFAULT_MAX_PI_STDOUT_BYTES,
        "stderr_retention_limit": DEFAULT_MAX_PI_STDERR_BYTES,
        "message_update_frames": diagnostics.message_update_frames,
        "tool_update_frames": diagnostics.tool_update_frames,
        "bash_update_frames": diagnostics.bash_update_frames,
        "peak_line_bytes": diagnostics.peak_line_bytes,
        "peak_line_capacity": diagnostics.peak_line_capacity,
    });
    fs::write(
        &path,
        serde_json::to_vec_pretty(&stats)
            .map_err(|error| format!("agent-run stats serialize failed: {error}"))?,
    )
    .map_err(|error| format!("agent-run stats write failed {:?}: {error}", path))
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

fn validate_spec(strict: &AgentRunSpec, spec_path: &Path) -> Result<(), String> {
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
    validate_delivery_identity(strict)?;
    validate_planning_documents(strict)?;
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
    let resolved = super::resolve_role_tools(&strict.role_id.0, profile_id)
        .map_err(|error| error.to_string())?;
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
            if strict.boundary_id.0 == "autopilot.validation_submission.v2"
                && strict.result_contract.0 == "autopilot.validation_result.v2" => {}
        _ => {
            return Err(format!(
                "agent-run assignment kind/boundary/result drift: {:?}/{}/{}",
                strict.assignment_kind, strict.boundary_id.0, strict.result_contract.0
            ));
        }
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
            super::reject_link_components_for_path(&path).map_err(|error| error.to_string())?;
            super::require_regular_file(&path).map_err(|error| error.to_string())?;
            let mut file = fs::File::open(&path)
                .map_err(|error| format!("agent-run child add-on open failed: {error}"))?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|error| format!("agent-run child add-on read failed: {error}"))?;
            let actual = sha256_hex(&bytes);
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
    let context_digest = if matches!(
        strict.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Delivery
    ) {
        sha_json(&serde_json::json!({
            "workstream": strict.workstream.0,
            "lane_id": strict.lane_id.as_ref().map(|id| id.0.as_str()),
            "attempt": strict.attempt,
            "base_commit": strict.base_commit.as_ref().map(|sha| sha.0.as_str()),
            "worktree": strict.worktree.as_ref().map(|path| path.0.as_str()),
            "required_focused_evidence": strict.required_focused_evidence,
        }))?
    } else if matches!(
        strict.assignment_kind,
        kernel::generated::ValidationAssignmentKind::PlanningReview
    ) {
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
    } else {
        sha_json(&serde_json::json!({
            "assignment_path": strict.assignment_path,
            "assignment_digest": strict.assignment_digest,
            "context_manifest_path": strict.context_manifest_path,
            "context_manifest_digest": strict.context_manifest_digest,
            "producer_assignment_ids": strict.producer_assignment_ids,
            "validation_id": strict.validation_id,
            "validation_attempt": strict.validation_attempt,
            "semantic_round": strict.semantic_round,
        }))?
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
        return validate_validation_spec_identity(strict);
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
    if attempt == 0 || base_commit.0.trim().is_empty() || required == 0 {
        return Err("agent-run delivery lane/attempt/base requirement drift".to_owned());
    }
    if worktree.0 != strict.cwd.0 {
        return Err(format!(
            "agent-run worktree/cwd drift: worktree={} cwd={}",
            worktree.0, strict.cwd.0
        ));
    }
    let expected_assignment = format!("assignment-{}-{}", strict.workstream.0, lane_id.0);
    let expected_action = format!("action-{}-{}", strict.workstream.0, lane_id.0);
    if strict.assignment_id.0 != expected_assignment || strict.action_id.0 != expected_action {
        return Err(format!(
            "agent-run delivery action/assignment drift: expected {expected_action}/{expected_assignment}, got {}/{}",
            strict.action_id.0, strict.assignment_id.0
        ));
    }
    Ok(())
}

fn validate_validation_spec_identity(strict: &AgentRunSpec) -> Result<(), String> {
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
    for (label, path, digest) in [
        ("assignment", &assignment_path.0, &assignment_digest.0),
        ("context", &context_path.0, &context_digest.0),
    ] {
        let bytes = fs::read(path)
            .map_err(|error| format!("agent-run validation {label} read failed: {error}"))?;
        if sha256_hex(&bytes) != *digest {
            return Err(format!("agent-run validation {label} digest drift"));
        }
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
        serde_json::from_slice(&fs::read(&assignment_path.0).map_err(|error| error.to_string())?)
            .map_err(|error| format!("agent-run validation assignment malformed: {error}"))?;
    let context: kernel::generated::ValidationContextV2 =
        serde_json::from_slice(&fs::read(&context_path.0).map_err(|error| error.to_string())?)
            .map_err(|error| format!("agent-run validation context malformed: {error}"))?;
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
            return Err("agent-run delivery spec contains planning documents".to_owned());
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

fn validate_assistant_identity(
    record: &AssistantRecord,
    expected_provider: &str,
    expected_model: &str,
) -> Result<(), String> {
    if record.provider != expected_provider || record.model != expected_model {
        return Err(format!(
            "agent-run Pi provider/model drift: expected {expected_provider}/{expected_model}, got {}/{}",
            record.provider, record.model
        ));
    }
    Ok(())
}

fn validate_terminal_assistant(
    record: &AssistantRecord,
    expected_provider: &str,
    expected_model: &str,
) -> Result<(), String> {
    validate_assistant_identity(record, expected_provider, expected_model)?;
    if record.stop_reason != "stop" {
        return Err(format!(
            "agent-run terminal assistant stopReason was not stop: {}",
            record.stop_reason
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

fn sha256_array(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn hex_digest(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
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

fn render_repair_prompt(spec: &AgentRunSpec, rejection: &ValueRejection) -> String {
    let action = if runtime_addon(spec).is_some() {
        "The prior submission is not accepted. Call the declared terminating submit tool again with corrected values."
    } else {
        "Re-emit with corrected values."
    };
    format!(
        "Your {} submission was rejected.\n  field:    {}\n  expected: {}\n  got:      {}\n{action}",
        spec.boundary_id.0, rejection.field, rejection.expected, rejection.got
    )
}

fn paused_after_exhaustion(spec: &AgentRunSpec, rejection: &ValueRejection) -> String {
    let failure = Failure::Paused {
        needs: OperatorDecision::ChooseAfterExhaustion,
    };
    format!(
        "agent-run value repair exhausted taxonomy=D77 variant={failure:?} assignment={} attempts={} field={} expected={} got={}",
        spec.assignment_id.0,
        MAX_VALUE_ATTEMPTS,
        rejection.field,
        rejection.expected,
        rejection.got
    )
}

#[derive(Debug, Clone, Copy)]
struct AttemptEventDetail<'a> {
    rejection: Option<&'a ValueRejection>,
    terminal_failure: Option<&'a TerminalFailureDiagnostic>,
    terminal_miss: Option<&'a TerminalMiss>,
    child_error: Option<&'a ChildError>,
    terminal_trace: Option<&'a TerminalTrace>,
    directive: Option<&'a DirectiveReceipt>,
}

impl<'a> AttemptEventDetail<'a> {
    fn none() -> Self {
        Self {
            rejection: None,
            terminal_failure: None,
            terminal_miss: None,
            child_error: None,
            terminal_trace: None,
            directive: None,
        }
    }

    fn rejection(rejection: &'a ValueRejection) -> Self {
        Self {
            rejection: Some(rejection),
            terminal_failure: None,
            terminal_miss: None,
            child_error: None,
            terminal_trace: None,
            directive: None,
        }
    }

    fn terminal_failure(terminal_failure: &'a TerminalFailureDiagnostic) -> Self {
        Self {
            rejection: None,
            terminal_failure: Some(terminal_failure),
            terminal_miss: None,
            child_error: None,
            terminal_trace: None,
            directive: None,
        }
    }

    fn terminal_miss(terminal_miss: &'a TerminalMiss) -> Self {
        Self {
            rejection: None,
            terminal_failure: None,
            terminal_miss: Some(terminal_miss),
            child_error: None,
            terminal_trace: None,
            directive: None,
        }
    }

    fn terminal_trace(terminal_trace: &'a TerminalTrace) -> Self {
        Self {
            rejection: None,
            terminal_failure: None,
            terminal_miss: None,
            child_error: None,
            terminal_trace: Some(terminal_trace),
            directive: None,
        }
    }

    fn directive(directive: &'a DirectiveReceipt) -> Self {
        Self {
            rejection: None,
            terminal_failure: None,
            terminal_miss: None,
            child_error: None,
            terminal_trace: None,
            directive: Some(directive),
        }
    }
}

fn terminal_miss_json(value: &TerminalMiss) -> Value {
    match value {
        TerminalMiss::ProseInsteadOfTerminal {
            text_len,
            text_digest,
            preview,
            tool_execution_count,
        } => serde_json::json!({
            "class": value.class(),
            "text_len": text_len,
            "text_digest": hex_digest(text_digest),
            "preview": preview,
            "tool_execution_count": tool_execution_count,
        }),
        TerminalMiss::EmptyStopNoTerminal {
            tool_execution_count,
            last_tool_name,
        } => serde_json::json!({
            "class": value.class(),
            "tool_execution_count": tool_execution_count,
            "last_tool_name": last_tool_name,
        }),
        TerminalMiss::NoTerminalFrame {
            messages_seen,
            last_stop_reason,
        } => serde_json::json!({
            "class": value.class(),
            "messages_seen": messages_seen,
            "last_stop_reason": last_stop_reason,
        }),
        TerminalMiss::TerminalToolNotOffered {
            source,
            expected_tool,
            offered_tools,
        } => serde_json::json!({
            "class": value.class(),
            "source": source.as_str(),
            "expected_tool": expected_tool,
            "offered_tools": offered_tools,
        }),
        TerminalMiss::MultipleTerminals { count } => serde_json::json!({
            "class": value.class(),
            "count": count,
        }),
    }
}

fn child_error_json(value: &ChildError) -> Value {
    match value {
        ChildError::TerminalMiss(miss) => serde_json::json!({
            "kind": "terminal-miss",
            "terminal_miss": terminal_miss_json(miss),
        }),
        ChildError::TerminalMissDeterministic { digest } => serde_json::json!({
            "kind": "terminal-miss-deterministic",
            "digest": hex_digest(digest),
        }),
        ChildError::TerminalContinuationExhausted {
            classes,
            attempts_made,
            max_attempts,
        } => serde_json::json!({
            "kind": "terminal-continuation-exhausted",
            "classes": classes,
            "attempts_made": attempts_made,
            "max_attempts": max_attempts,
        }),
        ChildError::EvidenceWrite(error) => serde_json::json!({
            "kind": "evidence-write",
            "stage": &error.stage,
            "message": crate::evidence::bound_detail(&error.message),
        }),
        ChildError::SessionContinuityLost { expected, actual } => serde_json::json!({
            "kind": "session-continuity-lost",
            "expected": expected,
            "actual": actual,
        }),
        ChildError::Fatal(message) => serde_json::json!({
            "kind": "fatal",
            "message": crate::evidence::bound_detail(message),
        }),
    }
}

fn append_attempt_event(
    spec: &AgentRunSpec,
    attempt: u32,
    event: &str,
    detail: AttemptEventDetail<'_>,
) -> Result<(), EvidenceError> {
    let root = Path::new(&spec.cwd.0).join(".pi/autopilot/runner/attempt-events");
    fs::create_dir_all(&root).map_err(|error| {
        EvidenceError::new(
            "attempt-event-mkdir",
            format!("agent-run attempt event mkdir failed {:?}: {error}", root),
        )
    })?;
    let path = root.join(format!("{}.jsonl", spec.assignment_id.0));
    super::reject_link_components_for_path(&path)
        .map_err(|error| EvidenceError::new("attempt-event-path", error.to_string()))?;
    let row = serde_json::json!({
        "schema": "autopilot.agent_run_attempt_event.v1",
        "assignment_id": spec.assignment_id.0,
        "session_id": spec.session_id.0,
        "attempt": attempt,
        "event": event,
        "rejection": detail.rejection.map(|value| serde_json::json!({
            "field": value.field.clone(),
            "expected": value.expected.clone(),
            "got": value.got.clone(),
        })),
        "terminal_failure": detail.terminal_failure.map(|value| serde_json::json!({
            "stopReason": value.stop_reason.clone(),
            "provider_errorMessage_present": value.provider_error_message_present,
            "provider_errorMessage": value.provider_error_message.clone(),
            "assistant_text_present": value.assistant_text_present,
            "assistant_text_len": value.assistant_text_len,
            "capacity_detector_matched": value.capacity_detector_matched,
            "capacity_detector_miss": value.capacity_detector_miss.clone(),
        })),
        "terminal_miss": detail.terminal_miss.map(terminal_miss_json),
        "child_error": detail.child_error.map(child_error_json),
        "terminal_trace": detail.terminal_trace.map(|trace| serde_json::json!({
            "attempts_made": trace.attempts_made,
            "continuations_prepared": trace.continuations_prepared,
            "continuations_dispatched": trace.continuations_dispatched,
            "classes": trace.class_names(),
            "directives": &trace.directives,
            "stop": &trace.stop,
        })),
        "directive": detail.directive,
    });
    let mut data = serde_json::to_vec(&row).map_err(|error| {
        EvidenceError::new(
            "attempt-event-serialize",
            format!("agent-run attempt event serialize failed: {error}"),
        )
    })?;
    data.push(b'\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| {
            EvidenceError::new(
                "attempt-event-open",
                format!("agent-run attempt event open failed {:?}: {error}", path),
            )
        })?;
    file.write_all(&data).map_err(|error| {
        EvidenceError::new(
            "attempt-event-write",
            format!("agent-run attempt event write failed {:?}: {error}", path),
        )
    })?;
    file.sync_all().map_err(|error| {
        EvidenceError::new(
            "attempt-event-fsync",
            format!("agent-run attempt event fsync failed {:?}: {error}", path),
        )
    })?;
    Ok(())
}

fn ensure_carrier_absent(spec: &AgentRunSpec) -> Result<(), String> {
    let path = Path::new(&spec.carrier_path.0);
    super::reject_link_components_for_path(path).map_err(|error| error.to_string())?;
    match fs::symlink_metadata(path) {
        Ok(_) => Err(format!(
            "agent-run unconsumed pre-existing carrier refused at {:?}",
            path
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("carrier inspection failed {:?}: {error}", path)),
    }
}

fn write_carrier(
    spec_path: &Path,
    spec_bytes: &str,
    spec_digest: &str,
    spec: &AgentRunSpec,
    source: &CarrierSource,
) -> Result<(), CarrierRejection> {
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
    let raw_output = serde_json::to_string(&terminal.details.payload).map_err(|error| {
        CarrierRejection::Value(value_rejection(
            "payload",
            "serializable tool payload",
            error.to_string(),
        ))
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
        let carrier = package_tool_result(
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
        )?;
        return write_json_new(&spec.carrier_path.0, &carrier)
            .map_err(|error| value_rejection("carrier_path", "create-once carrier", error))
            .map_err(Into::into);
    }
    if matches!(
        spec.assignment_kind,
        kernel::generated::ValidationAssignmentKind::Validation
    ) {
        let submission: kernel::generated::ValidationSubmissionV2 =
            serde_json::from_value(terminal.details.payload.clone()).map_err(|error| {
                value_rejection(
                    "payload",
                    "closed autopilot.validation_submission.v2",
                    error.to_string(),
                )
            })?;
        validate_validation_submission(spec, &submission)?;
        let carrier = package_tool_result(
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
        )?;
        return write_json_new(&spec.carrier_path.0, &carrier)
            .map_err(|error| value_rejection("carrier_path", "create-once carrier", error))
            .map_err(Into::into);
    }
    crate::runner::validate_child_boundary(spec, &raw_output).map_err(|error| {
        value_rejection(
            "payload",
            format!("{} admitted value", error.boundary_id()),
            error.actual().to_owned(),
        )
    })?;
    let carrier = serde_json::json!({
        "schema": "autopilot.planning_carrier.v1",
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
    let mut carrier = carrier;
    if let Some(provenance) = &terminal.continuation_provenance {
        let object = carrier
            .as_object_mut()
            .expect("planning carrier is an object");
        object.insert(
            "continuation_provenance".to_owned(),
            serde_json::to_value(provenance).expect("provenance serializes"),
        );
        object.insert(
            "continuation_provenance_digest".to_owned(),
            serde_json::json!(sha256_hex(
                &serde_json::to_vec(provenance).expect("provenance serializes")
            )),
        );
    }
    write_json_new(&spec.carrier_path.0, &carrier)
        .map_err(|error| {
            value_rejection("carrier_path", "create-once writable carrier path", error)
        })
        .map_err(Into::into)
}

fn validate_delivery_submission(
    spec: &AgentRunSpec,
    submission: &kernel::generated::DeliverySubmissionV2,
) -> Result<(), ValueRejection> {
    let required = spec.required_focused_evidence.unwrap_or(0) as usize;
    if submission.actual_changed_paths.is_empty()
        || submission.execution_audit_ref.0.trim().is_empty()
        || submission.focused_evidence_refs.len() < required
    {
        return Err(value_rejection(
            "delivery_submission",
            format!("changed paths, audit ref, and at least {required} focused evidence refs"),
            "missing required delivery evidence",
        ));
    }
    if !submission.hard_boundary_violations.is_empty() {
        return Err(value_rejection(
            "hard_boundary_violations",
            "empty array",
            submission.hard_boundary_violations.join(","),
        ));
    }
    Ok(())
}

pub fn admit_validation_submission(
    spec: &AgentRunSpec,
    submission: &kernel::generated::ValidationSubmissionV2,
) -> Result<(), String> {
    validate_validation_submission(spec, submission).map_err(|rejection| {
        format!(
            "field={} expected={} got={}",
            rejection.field, rejection.expected, rejection.got
        )
    })
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
    let assignment: kernel::generated::ValidationAssignmentV2 =
        serde_json::from_slice(&fs::read(&assignment_path.0).map_err(|error| {
            value_rejection("assignment_path", "readable assignment", error.to_string())
        })?)
        .map_err(|error| value_rejection("assignment", "valid assignment", error.to_string()))?;
    let context: kernel::generated::ValidationContextV2 =
        serde_json::from_slice(&fs::read(&context_path.0).map_err(|error| {
            value_rejection(
                "context_manifest_path",
                "readable context",
                error.to_string(),
            )
        })?)
        .map_err(|error| {
            value_rejection("context", "valid validation context", error.to_string())
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
        if !criterion
            .covered_paths
            .iter()
            .all(|path| result.covered_paths.contains(path))
            || !criterion
                .semantic_surface_ids
                .iter()
                .all(|id| result.semantic_surface_ids.contains(id))
            || !criterion
                .forward_edge_ids
                .iter()
                .all(|id| result.forward_edge_ids.contains(id))
        {
            return Err(value_rejection(
                "criterion_results.coverage",
                "issued criterion coverage",
                result.criterion_id.0.clone(),
            ));
        }
        blocked |= result.verdict != kernel::generated::CriterionVerdict::PASS;
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

fn package_tool_result(
    spec_path: &Path,
    spec_bytes: &str,
    spec_digest: &str,
    spec: &AgentRunSpec,
    terminal: &ToolTerminal,
    submission: Value,
    schema: &str,
) -> Result<Value, ValueRejection> {
    let (_, runtime_digest) = runtime_addon(spec)
        .ok_or_else(|| value_rejection(RUNTIME_ADDON_DIGEST_FIELD, "digest", "missing"))?;
    let submission_bytes = serde_json::to_vec(&submission)
        .map_err(|error| value_rejection("submission", "serializable", error.to_string()))?;
    let submission_digest = sha256_hex(&submission_bytes);
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
        write_json_new(&path.0, &submission).map_err(|error| {
            value_rejection(
                "model_submission_path",
                "create-once model submission",
                error,
            )
        })?;
    }
    let audit = serde_json::json!({
        "schema": "autopilot.tool_audit.v1",
        "tool_call_id": terminal.tool_call_id,
        "profile_id": terminal.details.profile_id,
        "tool_name": terminal.tool_name,
        "boundary_id": terminal.details.boundary_id,
        "result_contract": terminal.details.result_contract,
        "schema_digest": terminal.details.schema_digest,
        "binding": terminal.details.binding,
        "submission_digest": submission_digest,
    });
    let audit_bytes = serde_json::to_vec_pretty(&audit)
        .map_err(|error| value_rejection("tool_audit", "serializable", error.to_string()))?;
    let audit_path = PathBuf::from(&spec.carrier_path.0).with_extension("tool-audit.json");
    write_json_new(
        audit_path
            .to_str()
            .ok_or_else(|| value_rejection("tool_audit", "UTF-8 path", "non-UTF-8"))?,
        &audit,
    )
    .map_err(|error| value_rejection("tool_audit", "create-once audit", error))?;
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
    if let Some(provenance) = &terminal.continuation_provenance {
        let object = carrier
            .as_object_mut()
            .expect("package tool result is an object");
        object.insert(
            "continuation_provenance".to_owned(),
            serde_json::to_value(provenance).expect("provenance serializes"),
        );
        object.insert(
            "continuation_provenance_digest".to_owned(),
            serde_json::json!(sha256_hex(
                &serde_json::to_vec(provenance).expect("provenance serializes")
            )),
        );
    }
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
        let assignment_bytes = fs::read(
            &spec
                .assignment_path
                .as_ref()
                .expect("validated assignment path")
                .0,
        )
        .map_err(|error| value_rejection("assignment", "readable", error.to_string()))?;
        let assignment: kernel::generated::ValidationAssignmentV2 =
            serde_json::from_slice(&assignment_bytes)
                .map_err(|error| value_rejection("assignment", "valid", error.to_string()))?;
        for (key, value) in [
            (
                "validation_id",
                serde_json::to_value(&assignment.validation_id).unwrap(),
            ),
            (
                "validation_key",
                serde_json::to_value(&assignment.validation_key).unwrap(),
            ),
            (
                "validation_attempt",
                serde_json::json!(assignment.validation_attempt),
            ),
            (
                "semantic_round",
                serde_json::json!(assignment.semantic_round),
            ),
            (
                "producer_assignment_ids",
                serde_json::to_value(&assignment.producer_assignment_ids).unwrap(),
            ),
            (
                "exact_commit",
                serde_json::to_value(&assignment.exact_commit).unwrap(),
            ),
            (
                "exact_tree",
                serde_json::to_value(&assignment.exact_tree).unwrap(),
            ),
            (
                "assignment_path",
                serde_json::to_value(spec.assignment_path.as_ref().unwrap()).unwrap(),
            ),
            (
                "assignment_digest",
                serde_json::to_value(spec.assignment_digest.as_ref().unwrap()).unwrap(),
            ),
            (
                "context_manifest_path",
                serde_json::to_value(spec.context_manifest_path.as_ref().unwrap()).unwrap(),
            ),
            (
                "context_manifest_digest",
                serde_json::to_value(spec.context_manifest_digest.as_ref().unwrap()).unwrap(),
            ),
        ] {
            object.insert(key.to_owned(), value);
        }
    }
    Ok(carrier)
}

fn write_json_new(path: &str, value: &impl serde::Serialize) -> Result<(), String> {
    let path = Path::new(path);
    let parent = path
        .parent()
        .ok_or_else(|| format!("carrier path has no parent: {:?}", path))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("carrier mkdir failed {:?}: {error}", parent))?;
    ensure_carrier_clear(path)?;
    let data = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("carrier serialize failed: {error}"))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("carrier create failed {:?}: {error}", path))?;
    file.write_all(&data)
        .map_err(|error| format!("carrier write failed {:?}: {error}", path))?;
    file.sync_all()
        .map_err(|error| format!("carrier fsync failed {:?}: {error}", path))?;
    Ok(())
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

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default)
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
mod tests {
    use super::*;

    #[test]
    fn offered_terminal_tool_new_rejects_unoffered_expected_tool() {
        let spec = agent_run_spec_with_tools(["bash", "read"]);

        let miss = OfferedTerminalTool::new(&spec).expect_err("missing terminal tool must fail");

        assert_eq!(
            miss,
            TerminalMiss::TerminalToolNotOffered {
                source: TerminalToolNotOfferedSource::OfferedTerminalToolGuard,
                expected_tool: "autopilot_submit_atoms".to_owned(),
                offered_tools: vec!["bash".to_owned(), "read".to_owned()],
            }
        );
    }

    fn agent_run_spec_with_tools(tools: impl IntoIterator<Item = &'static str>) -> AgentRunSpec {
        let allowed_tools = tools.into_iter().collect::<Vec<_>>();
        serde_json::from_value(serde_json::json!({
            "schema": "autopilot.agent_run_spec.v4",
            "assignment_kind": "planning-review",
            "action_id": "action-planning-main-task-extractor-01",
            "assignment_id": "planning-main-task-extractor-01",
            "run_id": "run-01",
            "run_revision": 1,
            "workstream": "main",
            "role_id": "task-extractor",
            "mode": "inventory",
            "provider": "openai-codex",
            "model": "gpt-5.5",
            "thinking": "high",
            "route": "subscription",
            "cwd": "/tmp/pi-autopilot-test",
            "allowed_tools": allowed_tools,
            "spec_path": "/tmp/pi-autopilot-test/spec.json",
            "prompt_path": "/tmp/pi-autopilot-test/prompt.md",
            "prompt_digest": "prompt-digest",
            "boundary_id": "planning.task-atoms.v1",
            "boundary_digest": "boundary-digest",
            "result_contract": "planning.task-atoms.v1",
            "result_contract_digest": "result-contract-digest",
            "carrier_path": "/tmp/pi-autopilot-test/carrier.json",
            "session_id": "session-01",
            "session_dir": "/tmp/pi-autopilot-test/session",
            "session_continuity": "fresh",
            "settings_digest": "settings-digest",
            "context_digest": "context-digest",
            "skills_digest": "skills-digest",
            "subscription_digest": "subscription-digest",
            "terminal_profile_id": "planning.task-atoms.v1:autopilot_submit_atoms",
            "unavailable_tools": []
        }))
        .expect("valid agent run spec")
    }
}
