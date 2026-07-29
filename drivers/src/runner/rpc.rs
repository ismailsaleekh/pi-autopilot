use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_STDERR_TAIL_BYTES: usize = 64 * 1024;
const DEFAULT_MAX_TERMINAL_BYTES: usize = 2 * 1024 * 1024;
const TERM_GRACE_POLL_MS: u64 = 20;

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RpcSpawnConfig {
    pub cwd: PathBuf,
    pub provider: String,
    pub model: String,
    pub thinking: String,
    pub session_id: String,
    /// Run-owned Pi session directory. Required: Pi's default store is keyed
    /// only by cwd, so omitting this lets a later run reopen an earlier run's
    /// session for the same assignment.
    pub session_dir: PathBuf,
    pub tools: Vec<String>,
    pub pi_executable: OsString,
    pub stderr_tail_bytes: usize,
    pub max_terminal_bytes: usize,
}

impl RpcSpawnConfig {
    #[must_use]
    pub fn new(
        cwd: PathBuf,
        provider: String,
        model: String,
        thinking: String,
        session_id: String,
        session_dir: PathBuf,
        tools: Vec<String>,
    ) -> Self {
        Self {
            cwd,
            provider,
            model,
            thinking,
            session_id,
            session_dir,
            tools,
            pi_executable: OsString::from("pi"),
            stderr_tail_bytes: DEFAULT_STDERR_TAIL_BYTES,
            max_terminal_bytes: DEFAULT_MAX_TERMINAL_BYTES,
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct RpcCommand {
    pub id: String,
    #[serde(rename = "type")]
    pub command: RpcCommandKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(rename = "customInstructions", skip_serializing_if = "Option::is_none")]
    pub custom_instructions: Option<String>,
}

impl RpcCommand {
    #[must_use]
    pub fn set_auto_compaction(id: impl Into<String>, enabled: bool) -> Self {
        Self {
            id: id.into(),
            command: RpcCommandKind::SetAutoCompaction,
            message: None,
            enabled: Some(enabled),
            custom_instructions: None,
        }
    }

    #[must_use]
    pub fn get_state(id: impl Into<String>) -> Self {
        Self::bare(id, RpcCommandKind::GetState)
    }

    #[must_use]
    pub fn get_session_stats(id: impl Into<String>) -> Self {
        Self::bare(id, RpcCommandKind::GetSessionStats)
    }

    #[must_use]
    pub fn prompt(id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            command: RpcCommandKind::Prompt,
            message: Some(message.into()),
            enabled: None,
            custom_instructions: None,
        }
    }

    #[must_use]
    pub fn steer(id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            command: RpcCommandKind::Steer,
            message: Some(message.into()),
            enabled: None,
            custom_instructions: None,
        }
    }

    #[must_use]
    pub fn compact(id: impl Into<String>, custom_instructions: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            command: RpcCommandKind::Compact,
            message: None,
            enabled: None,
            custom_instructions: Some(custom_instructions.into()),
        }
    }

    fn bare(id: impl Into<String>, command: RpcCommandKind) -> Self {
        Self {
            id: id.into(),
            command,
            message: None,
            enabled: None,
            custom_instructions: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum RpcCommandKind {
    #[serde(rename = "prompt")]
    Prompt,
    #[serde(rename = "steer")]
    Steer,
    #[serde(rename = "compact")]
    Compact,
    #[serde(rename = "set_auto_compaction")]
    SetAutoCompaction,
    #[serde(rename = "get_state")]
    GetState,
    #[serde(rename = "get_session_stats")]
    GetSessionStats,
    #[serde(rename = "abort")]
    Abort,
}

impl RpcCommandKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Steer => "steer",
            Self::Compact => "compact",
            Self::SetAutoCompaction => "set_auto_compaction",
            Self::GetState => "get_state",
            Self::GetSessionStats => "get_session_stats",
            Self::Abort => "abort",
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum RpcFrame {
    Response(RpcResponse),
    Event(RpcEvent),
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RpcResponse {
    pub id: String,
    pub command: RpcCommandKind,
    pub success: bool,
    pub queued_not_delivered: bool,
    pub data: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum RpcEvent {
    AgentStart,
    AgentEnd {
        will_retry: bool,
    },
    AgentSettled,
    TurnStart,
    TurnEnd,
    MessageStart,
    MessageEnd {
        message: TerminalMessage,
    },
    MessageUpdateDiscarded,
    BashExecutionUpdateDiscarded,
    ToolExecutionStart,
    ToolExecutionUpdateDiscarded,
    ToolExecutionEnd,
    QueueUpdate {
        steering: usize,
        follow_up: usize,
    },
    CompactionStart {
        reason: CompactionReason,
    },
    CompactionEnd {
        reason: CompactionReason,
        aborted: bool,
        will_retry: bool,
    },
    AutoRetryStart,
    AutoRetryEnd {
        success: bool,
    },
    SummarizationRetryScheduled,
    SummarizationRetryAttemptStart,
    SummarizationRetryFinished,
    ExtensionError,
    ExtensionUiRequest,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct TerminalMessage {
    pub role: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub stop_reason: Option<String>,
    pub text: Option<String>,
    /// Provider-supplied failure detail accompanying a non-`stop` terminal.
    /// Retained because it is the only evidence distinguishing an upstream
    /// capacity refusal from a genuine content failure.
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum CompactionReason {
    Manual,
    Threshold,
    Overflow,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RpcDiagnostics {
    pub frames: usize,
    pub total_bytes: usize,
    pub message_update_frames: usize,
    pub tool_update_frames: usize,
    pub bash_update_frames: usize,
    pub terminal_payload_bytes: usize,
    pub retained_tail_bytes: usize,
    pub peak_line_bytes: usize,
    pub peak_line_capacity: usize,
    pub stderr_total_bytes: usize,
    pub stderr_tail_bytes: usize,
    pub stderr_tail_truncated: bool,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RpcShutdown {
    pub status: Option<ExitStatus>,
    pub escalated: bool,
    pub stderr_tail: Vec<u8>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum RpcError {
    Io(String),
    Utf8(String),
    Json(String),
    UnknownFrame(String),
    MalformedFrame(String),
    DuplicateRequest(String),
    UnmatchedResponse(String),
    MissingResponse(Vec<String>),
    CommandMismatch {
        id: String,
        expected: RpcCommandKind,
        actual: String,
    },
    ResponseError {
        id: String,
        command: RpcCommandKind,
        error: String,
    },
    OutOfOrderEvent(String),
    ProtocolViolation(String),
    TerminalPayloadTooLarge {
        bytes: usize,
        limit: usize,
    },
    Shutdown(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(value) => write!(formatter, "rpc I/O error: {value}"),
            Self::Utf8(value) => write!(formatter, "rpc UTF-8 error: {value}"),
            Self::Json(value) => write!(formatter, "rpc JSON error: {value}"),
            Self::UnknownFrame(value) => write!(formatter, "unknown rpc frame: {value}"),
            Self::MalformedFrame(value) => write!(formatter, "malformed rpc frame: {value}"),
            Self::DuplicateRequest(value) => write!(formatter, "duplicate rpc request id: {value}"),
            Self::UnmatchedResponse(value) => {
                write!(formatter, "unmatched rpc response id: {value}")
            }
            Self::MissingResponse(ids) => {
                write!(formatter, "missing rpc responses: {}", ids.join(","))
            }
            Self::CommandMismatch {
                id,
                expected,
                actual,
            } => write!(
                formatter,
                "rpc response command mismatch for {id}: expected {}, got {actual}",
                expected.as_str()
            ),
            Self::ResponseError { id, command, error } => write!(
                formatter,
                "rpc command {id}/{} failed: {error}",
                command.as_str()
            ),
            Self::OutOfOrderEvent(value) => write!(formatter, "out-of-order rpc event: {value}"),
            Self::ProtocolViolation(value) => write!(formatter, "rpc protocol violation: {value}"),
            Self::TerminalPayloadTooLarge { bytes, limit } => {
                write!(
                    formatter,
                    "rpc terminal payload too large: {bytes} > {limit}"
                )
            }
            Self::Shutdown(value) => write!(formatter, "rpc shutdown failed: {value}"),
        }
    }
}

impl std::error::Error for RpcError {}

pub struct RpcClient {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: JsonlReader<BufReader<std::process::ChildStdout>>,
    protocol: RpcProtocol,
    stderr: Receiver<TailRead>,
}

impl RpcClient {
    pub fn spawn(config: RpcSpawnConfig) -> Result<Self, RpcError> {
        // Create the run-owned session directory up front and fail loudly if it
        // is unusable. Falling back to Pi's default global store here would
        // silently restore cross-run session collision.
        std::fs::create_dir_all(&config.session_dir).map_err(|error| {
            RpcError::Io(format!(
                "run-owned pi session directory unavailable at {}: {error}",
                config.session_dir.display()
            ))
        })?;
        let mut command = Command::new(&config.pi_executable);
        command
            .current_dir(&config.cwd)
            .arg("--mode")
            .arg("rpc")
            .arg("--session-id")
            .arg(&config.session_id)
            .arg("--session-dir")
            .arg(&config.session_dir)
            .arg("--no-extensions")
            .arg("--no-skills")
            .arg("--no-prompt-templates")
            .arg("--no-themes")
            .arg("--no-context-files")
            .arg("--provider")
            .arg(&config.provider)
            .arg("--model")
            .arg(&config.model)
            .arg("--thinking")
            .arg(&config.thinking)
            .arg("--tools")
            .arg(config.tools.join(","))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        for key in [
            "OPENROUTER_API_KEY",
            "OPENROUTER_BASE_URL",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "PI_API_KEY",
        ] {
            command.env_remove(key);
        }
        let mut child = command
            .spawn()
            .map_err(|error| RpcError::Io(format!("failed to spawn pi rpc: {error}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| RpcError::Io("missing pi rpc stdin pipe".to_owned()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RpcError::Io("missing pi rpc stdout pipe".to_owned()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| RpcError::Io("missing pi rpc stderr pipe".to_owned()))?;
        let stderr_tail_bytes = config.stderr_tail_bytes;
        let stderr = spawn_tail_reader(stderr, stderr_tail_bytes);
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: JsonlReader::new(BufReader::new(stdout)),
            protocol: RpcProtocol::new(config.max_terminal_bytes),
            stderr,
        })
    }

    pub fn send_command(&mut self, command: RpcCommand) -> Result<(), RpcError> {
        self.protocol.register_request(&command)?;
        if matches!(command.command, RpcCommandKind::Prompt) {
            self.protocol.begin_cycle();
        }
        let mut data = serde_json::to_vec(&command)
            .map_err(|error| RpcError::Json(format!("serialize command: {error}")))?;
        data.push(b'\n');
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| RpcError::Io("rpc stdin is closed".to_owned()))?;
        stdin
            .write_all(&data)
            .map_err(|error| RpcError::Io(error.to_string()))?;
        stdin
            .flush()
            .map_err(|error| RpcError::Io(error.to_string()))?;
        Ok(())
    }

    pub fn next_frame(&mut self) -> Result<Option<RpcFrame>, RpcError> {
        let Some(line) = self.stdout.next_record()? else {
            self.protocol.finish()?;
            return Ok(None);
        };
        let frame = self.protocol.ingest_record(&line)?;
        Ok(Some(frame))
    }

    #[must_use]
    pub fn diagnostics(&self) -> RpcDiagnostics {
        self.protocol.diagnostics(&self.stdout)
    }

    pub fn shutdown(&mut self, grace: Duration) -> Result<RpcShutdown, RpcError> {
        self.stdin.take();
        let started = Instant::now();
        loop {
            match self
                .child
                .try_wait()
                .map_err(|error| RpcError::Shutdown(error.to_string()))?
            {
                Some(status) => {
                    let stderr_tail = self.collect_stderr_tail();
                    return Ok(RpcShutdown {
                        status: Some(status),
                        escalated: false,
                        stderr_tail,
                    });
                }
                None if started.elapsed() >= grace => break,
                None => thread::sleep(Duration::from_millis(TERM_GRACE_POLL_MS)),
            }
        }
        terminate_child(&mut self.child);
        let status = self
            .child
            .try_wait()
            .map_err(|error| RpcError::Shutdown(error.to_string()))?;
        let stderr_tail = self.collect_stderr_tail();
        Ok(RpcShutdown {
            status,
            escalated: true,
            stderr_tail,
        })
    }

    fn collect_stderr_tail(&mut self) -> Vec<u8> {
        match self.stderr.try_recv() {
            Ok(read) => read.data,
            Err(_) => Vec::new(),
        }
    }
}

pub struct RpcProtocol {
    pending: HashMap<String, RpcCommandKind>,
    order: EventOrder,
    max_terminal_bytes: usize,
    frames: usize,
    message_update_frames: usize,
    tool_update_frames: usize,
    bash_update_frames: usize,
    terminal_payload_bytes: usize,
}

impl RpcProtocol {
    #[must_use]
    pub fn new(max_terminal_bytes: usize) -> Self {
        Self {
            pending: HashMap::new(),
            order: EventOrder::new(),
            max_terminal_bytes,
            frames: 0,
            message_update_frames: 0,
            tool_update_frames: 0,
            bash_update_frames: 0,
            terminal_payload_bytes: 0,
        }
    }

    pub fn register_request(&mut self, command: &RpcCommand) -> Result<(), RpcError> {
        if self.pending.contains_key(&command.id) {
            return Err(RpcError::DuplicateRequest(command.id.clone()));
        }
        self.pending.insert(command.id.clone(), command.command);
        Ok(())
    }

    pub fn begin_cycle(&mut self) {
        self.order.begin_cycle();
    }

    pub fn ingest_record(&mut self, record: &[u8]) -> Result<RpcFrame, RpcError> {
        self.frames = self.frames.saturating_add(1);
        let text =
            std::str::from_utf8(record).map_err(|error| RpcError::Utf8(error.to_string()))?;
        if text.trim().is_empty() {
            return Err(RpcError::MalformedFrame("empty JSONL record".to_owned()));
        }
        let envelope: FrameEnvelope = serde_json::from_str(text)
            .map_err(|error| RpcError::Json(format!("frame {}: {error}", self.frames)))?;
        match envelope.kind.as_str() {
            "response" => self.ingest_response(text),
            "message_update" => {
                self.message_update_frames = self.message_update_frames.saturating_add(1);
                self.order.accept(&RpcEvent::MessageUpdateDiscarded)?;
                Ok(RpcFrame::Event(RpcEvent::MessageUpdateDiscarded))
            }
            "tool_execution_update" => {
                self.tool_update_frames = self.tool_update_frames.saturating_add(1);
                self.order.accept(&RpcEvent::ToolExecutionUpdateDiscarded)?;
                Ok(RpcFrame::Event(RpcEvent::ToolExecutionUpdateDiscarded))
            }
            "bash_execution_update" => {
                self.bash_update_frames = self.bash_update_frames.saturating_add(1);
                self.order.accept(&RpcEvent::BashExecutionUpdateDiscarded)?;
                Ok(RpcFrame::Event(RpcEvent::BashExecutionUpdateDiscarded))
            }
            _ => self.ingest_event(text, &envelope.kind),
        }
    }

    pub fn finish(&self) -> Result<(), RpcError> {
        if !self.pending.is_empty() {
            let mut ids = self.pending.keys().cloned().collect::<Vec<_>>();
            ids.sort();
            return Err(RpcError::MissingResponse(ids));
        }
        self.order.finish()
    }

    #[must_use]
    pub fn diagnostics<R: Read>(&self, reader: &JsonlReader<R>) -> RpcDiagnostics {
        RpcDiagnostics {
            frames: self.frames,
            total_bytes: reader.total_bytes,
            message_update_frames: self.message_update_frames,
            tool_update_frames: self.tool_update_frames,
            bash_update_frames: self.bash_update_frames,
            terminal_payload_bytes: self.terminal_payload_bytes,
            retained_tail_bytes: self.terminal_payload_bytes,
            peak_line_bytes: reader.peak_line_bytes,
            peak_line_capacity: reader.peak_line_capacity,
            stderr_total_bytes: 0,
            stderr_tail_bytes: 0,
            stderr_tail_truncated: false,
        }
    }

    fn ingest_response(&mut self, text: &str) -> Result<RpcFrame, RpcError> {
        let parsed: ResponseRecord<'_> = serde_json::from_str(text)
            .map_err(|error| RpcError::MalformedFrame(format!("response: {error}")))?;
        let id = parsed
            .id
            .ok_or_else(|| RpcError::UnmatchedResponse("<missing id>".to_owned()))?
            .to_owned();
        let expected = self
            .pending
            .remove(&id)
            .ok_or_else(|| RpcError::UnmatchedResponse(id.clone()))?;
        if parsed.command != expected.as_str() {
            return Err(RpcError::CommandMismatch {
                id,
                expected,
                actual: parsed.command.to_owned(),
            });
        }
        let data = parsed.data.map(|value| value.to_string());
        let error = parsed.error.map(ToOwned::to_owned);
        if !parsed.success {
            return Err(RpcError::ResponseError {
                id,
                command: expected,
                error: error.unwrap_or_else(|| "command returned success:false".to_owned()),
            });
        }
        Ok(RpcFrame::Response(RpcResponse {
            id,
            command: expected,
            success: true,
            queued_not_delivered: matches!(expected, RpcCommandKind::Steer),
            data,
            error: None,
        }))
    }

    fn ingest_event(&mut self, text: &str, kind: &str) -> Result<RpcFrame, RpcError> {
        let event = match kind {
            "agent_start" => RpcEvent::AgentStart,
            "agent_end" => {
                let parsed: AgentEnd = serde_json::from_str(text)
                    .map_err(|error| RpcError::MalformedFrame(format!("agent_end: {error}")))?;
                RpcEvent::AgentEnd {
                    will_retry: parsed.will_retry,
                }
            }
            "agent_settled" => RpcEvent::AgentSettled,
            "turn_start" => RpcEvent::TurnStart,
            "turn_end" => RpcEvent::TurnEnd,
            "message_start" => RpcEvent::MessageStart,
            "message_end" => {
                if text.len() > self.max_terminal_bytes {
                    return Err(RpcError::TerminalPayloadTooLarge {
                        bytes: text.len(),
                        limit: self.max_terminal_bytes,
                    });
                }
                let parsed: MessageEnd = serde_json::from_str(text)
                    .map_err(|error| RpcError::MalformedFrame(format!("message_end: {error}")))?;
                let message = parsed.message.into_terminal();
                self.terminal_payload_bytes = self
                    .terminal_payload_bytes
                    .saturating_add(message.text.as_ref().map_or(0, String::len));
                RpcEvent::MessageEnd { message }
            }
            "tool_execution_start" => RpcEvent::ToolExecutionStart,
            "tool_execution_end" => RpcEvent::ToolExecutionEnd,
            "queue_update" => {
                let parsed: QueueUpdate = serde_json::from_str(text)
                    .map_err(|error| RpcError::MalformedFrame(format!("queue_update: {error}")))?;
                RpcEvent::QueueUpdate {
                    steering: parsed.steering.len(),
                    follow_up: parsed.follow_up.len(),
                }
            }
            "compaction_start" => {
                let parsed: CompactionStart = serde_json::from_str(text).map_err(|error| {
                    RpcError::MalformedFrame(format!("compaction_start: {error}"))
                })?;
                RpcEvent::CompactionStart {
                    reason: parsed.reason,
                }
            }
            "compaction_end" => {
                let parsed: CompactionEnd = serde_json::from_str(text).map_err(|error| {
                    RpcError::MalformedFrame(format!("compaction_end: {error}"))
                })?;
                RpcEvent::CompactionEnd {
                    reason: parsed.reason,
                    aborted: parsed.aborted,
                    will_retry: parsed.will_retry,
                }
            }
            "auto_retry_start" => RpcEvent::AutoRetryStart,
            "auto_retry_end" => {
                let parsed: AutoRetryEnd = serde_json::from_str(text).map_err(|error| {
                    RpcError::MalformedFrame(format!("auto_retry_end: {error}"))
                })?;
                RpcEvent::AutoRetryEnd {
                    success: parsed.success,
                }
            }
            "summarization_retry_scheduled" => RpcEvent::SummarizationRetryScheduled,
            "summarization_retry_attempt_start" => RpcEvent::SummarizationRetryAttemptStart,
            "summarization_retry_finished" => RpcEvent::SummarizationRetryFinished,
            "extension_error" => RpcEvent::ExtensionError,
            "extension_ui_request" => RpcEvent::ExtensionUiRequest,
            other => return Err(RpcError::UnknownFrame(other.to_owned())),
        };
        self.order.accept(&event)?;
        Ok(RpcFrame::Event(event))
    }
}

pub struct JsonlReader<R: Read> {
    reader: R,
    buffer: Vec<u8>,
    pub total_bytes: usize,
    pub frames: usize,
    pub peak_line_bytes: usize,
    pub peak_line_capacity: usize,
}

impl<R: Read> JsonlReader<R> {
    #[must_use]
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            buffer: Vec::new(),
            total_bytes: 0,
            frames: 0,
            peak_line_bytes: 0,
            peak_line_capacity: 0,
        }
    }

    pub fn next_record(&mut self) -> Result<Option<Vec<u8>>, RpcError>
    where
        R: BufRead,
    {
        self.buffer.clear();
        let bytes = self
            .reader
            .read_until(b'\n', &mut self.buffer)
            .map_err(|error| RpcError::Io(error.to_string()))?;
        if bytes == 0 {
            return Ok(None);
        }
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        if self.buffer.ends_with(b"\n") {
            self.buffer.pop();
            if self.buffer.ends_with(b"\r") {
                self.buffer.pop();
            }
        }
        self.frames = self.frames.saturating_add(1);
        self.peak_line_bytes = self.peak_line_bytes.max(self.buffer.len());
        self.peak_line_capacity = self.peak_line_capacity.max(self.buffer.capacity());
        Ok(Some(self.buffer.clone()))
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum EventOrderState {
    Idle,
    Running,
    AfterAgentEnd {
        will_retry: bool,
        saw_retry_progress: bool,
    },
    Compacting {
        previous: CompactPrevious,
    },
    Settled,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum CompactPrevious {
    Idle,
    Running,
    AfterAgentEnd,
}

struct EventOrder {
    state: EventOrderState,
}

impl EventOrder {
    fn new() -> Self {
        Self {
            state: EventOrderState::Idle,
        }
    }

    fn begin_cycle(&mut self) {
        if matches!(self.state, EventOrderState::Settled) {
            self.state = EventOrderState::Idle;
        }
    }

    fn accept(&mut self, event: &RpcEvent) -> Result<(), RpcError> {
        if let RpcEvent::CompactionStart {
            reason: CompactionReason::Threshold | CompactionReason::Overflow,
        } = event
        {
            return Err(RpcError::ProtocolViolation(
                "automatic compaction emitted while auto-compaction is disabled".to_owned(),
            ));
        }
        let next = match (self.state, event) {
            (EventOrderState::Idle, RpcEvent::AgentStart) => EventOrderState::Running,
            (
                EventOrderState::Idle,
                RpcEvent::CompactionStart {
                    reason: CompactionReason::Manual,
                },
            ) => EventOrderState::Compacting {
                previous: CompactPrevious::Idle,
            },
            (
                EventOrderState::Idle,
                RpcEvent::QueueUpdate { .. }
                | RpcEvent::ExtensionUiRequest
                | RpcEvent::ExtensionError,
            ) => EventOrderState::Idle,

            (
                EventOrderState::Running,
                RpcEvent::TurnStart
                | RpcEvent::TurnEnd
                | RpcEvent::MessageStart
                | RpcEvent::MessageUpdateDiscarded
                | RpcEvent::MessageEnd { .. }
                | RpcEvent::ToolExecutionStart
                | RpcEvent::ToolExecutionUpdateDiscarded
                | RpcEvent::ToolExecutionEnd
                | RpcEvent::BashExecutionUpdateDiscarded
                | RpcEvent::QueueUpdate { .. }
                | RpcEvent::ExtensionUiRequest
                | RpcEvent::ExtensionError,
            ) => EventOrderState::Running,
            (
                EventOrderState::Running,
                RpcEvent::CompactionStart {
                    reason: CompactionReason::Manual,
                },
            ) => EventOrderState::Compacting {
                previous: CompactPrevious::Running,
            },
            (EventOrderState::Running, RpcEvent::AgentEnd { will_retry }) => {
                EventOrderState::AfterAgentEnd {
                    will_retry: *will_retry,
                    saw_retry_progress: false,
                }
            }

            (
                EventOrderState::AfterAgentEnd {
                    will_retry: false, ..
                },
                RpcEvent::AgentSettled,
            ) => EventOrderState::Settled,
            (
                EventOrderState::AfterAgentEnd {
                    will_retry,
                    saw_retry_progress,
                },
                RpcEvent::QueueUpdate { .. }
                | RpcEvent::ExtensionUiRequest
                | RpcEvent::ExtensionError,
            ) => EventOrderState::AfterAgentEnd {
                will_retry,
                saw_retry_progress,
            },
            (
                EventOrderState::AfterAgentEnd { will_retry, .. },
                RpcEvent::CompactionStart {
                    reason: CompactionReason::Manual,
                },
            ) => {
                let _ = will_retry;
                EventOrderState::Compacting {
                    previous: CompactPrevious::AfterAgentEnd,
                }
            }
            (
                EventOrderState::AfterAgentEnd { will_retry, .. },
                RpcEvent::AutoRetryStart
                | RpcEvent::AutoRetryEnd { .. }
                | RpcEvent::SummarizationRetryScheduled
                | RpcEvent::SummarizationRetryAttemptStart
                | RpcEvent::SummarizationRetryFinished,
            ) => EventOrderState::AfterAgentEnd {
                will_retry,
                saw_retry_progress: true,
            },
            (
                EventOrderState::AfterAgentEnd {
                    will_retry: true,
                    saw_retry_progress: true,
                },
                RpcEvent::AgentStart,
            ) => EventOrderState::Running,

            (
                EventOrderState::Compacting { previous },
                RpcEvent::SummarizationRetryScheduled
                | RpcEvent::SummarizationRetryAttemptStart
                | RpcEvent::SummarizationRetryFinished
                | RpcEvent::ExtensionUiRequest
                | RpcEvent::ExtensionError,
            ) => EventOrderState::Compacting { previous },
            (
                EventOrderState::Compacting {
                    previous: CompactPrevious::Idle,
                },
                RpcEvent::CompactionEnd { .. },
            ) => EventOrderState::Idle,
            (
                EventOrderState::Compacting {
                    previous: CompactPrevious::Running,
                },
                RpcEvent::CompactionEnd { .. },
            ) => EventOrderState::Running,
            (
                EventOrderState::Compacting {
                    previous: CompactPrevious::AfterAgentEnd,
                },
                RpcEvent::CompactionEnd {
                    will_retry: true, ..
                },
            ) => EventOrderState::AfterAgentEnd {
                will_retry: true,
                saw_retry_progress: true,
            },
            (
                EventOrderState::Compacting {
                    previous: CompactPrevious::AfterAgentEnd,
                },
                RpcEvent::CompactionEnd {
                    will_retry: false, ..
                },
            ) => EventOrderState::AfterAgentEnd {
                will_retry: false,
                saw_retry_progress: true,
            },

            (EventOrderState::Settled, _) => {
                return Err(RpcError::OutOfOrderEvent(format!(
                    "event {event:?} arrived after agent_settled"
                )));
            }
            _ => {
                return Err(RpcError::OutOfOrderEvent(format!(
                    "event {event:?} is invalid in state {:?}",
                    self.state
                )));
            }
        };
        self.state = next;
        Ok(())
    }

    fn finish(&self) -> Result<(), RpcError> {
        match self.state {
            EventOrderState::Idle | EventOrderState::Settled => Ok(()),
            other => Err(RpcError::OutOfOrderEvent(format!(
                "stream ended before agent_settled from state {other:?}"
            ))),
        }
    }
}

#[derive(Deserialize)]
struct FrameEnvelope {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct ResponseRecord<'a> {
    id: Option<&'a str>,
    command: &'a str,
    success: bool,
    data: Option<Value>,
    error: Option<&'a str>,
}

#[derive(Deserialize)]
struct AgentEnd {
    #[serde(rename = "willRetry")]
    will_retry: bool,
}

#[derive(Deserialize)]
struct MessageEnd {
    message: AgentMessage,
}

#[derive(Deserialize)]
struct AgentMessage {
    role: String,
    provider: Option<String>,
    model: Option<String>,
    #[serde(rename = "stopReason")]
    stop_reason: Option<String>,
    content: Option<Vec<MessageContent>>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
}

impl AgentMessage {
    fn into_terminal(self) -> TerminalMessage {
        TerminalMessage {
            role: self.role,
            provider: self.provider,
            model: self.model,
            stop_reason: self.stop_reason,
            text: self.content.map(extract_text),
            error_message: self.error_message,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum MessageContent {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(other)]
    Other,
}

fn extract_text(content: Vec<MessageContent>) -> String {
    let mut text = String::new();
    for item in content {
        if let MessageContent::Text { text: item } = item {
            text.push_str(&item);
        }
    }
    text
}

#[derive(Deserialize)]
struct QueueUpdate {
    #[serde(default)]
    steering: Vec<String>,
    #[serde(default, rename = "followUp")]
    follow_up: Vec<String>,
}

#[derive(Deserialize)]
struct CompactionStart {
    reason: CompactionReason,
}

#[derive(Deserialize)]
struct CompactionEnd {
    reason: CompactionReason,
    #[serde(default)]
    aborted: bool,
    #[serde(default, rename = "willRetry")]
    will_retry: bool,
}

impl<'de> Deserialize<'de> for CompactionReason {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        match value.as_str() {
            "manual" => Ok(Self::Manual),
            "threshold" => Ok(Self::Threshold),
            "overflow" => Ok(Self::Overflow),
            other => Err(serde::de::Error::custom(format!(
                "unknown compaction reason {other}"
            ))),
        }
    }
}

#[derive(Deserialize)]
struct AutoRetryEnd {
    success: bool,
}

#[derive(Debug)]
struct TailRead {
    data: Vec<u8>,
}

fn spawn_tail_reader<R: Read + Send + 'static>(mut reader: R, limit: usize) -> Receiver<TailRead> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut tail = RetainedTail::new(limit);
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(TailRead {
                        data: tail.into_vec(),
                    });
                    return;
                }
                Ok(n) => tail.push(&buf[..n]),
                Err(_) => {
                    let _ = tx.send(TailRead {
                        data: tail.into_vec(),
                    });
                    return;
                }
            }
        }
    });
    rx
}

struct RetainedTail {
    data: Vec<u8>,
    limit: usize,
}

impl RetainedTail {
    fn new(limit: usize) -> Self {
        Self {
            data: Vec::new(),
            limit,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        if self.limit == 0 {
            return;
        }
        if bytes.len() >= self.limit {
            self.data.clear();
            self.data
                .extend_from_slice(&bytes[bytes.len() - self.limit..]);
            return;
        }
        let overflow = self
            .data
            .len()
            .saturating_add(bytes.len())
            .saturating_sub(self.limit);
        if overflow > 0 {
            self.data.drain(..overflow);
        }
        self.data.extend_from_slice(bytes);
    }

    fn into_vec(self) -> Vec<u8> {
        self.data
    }
}

fn terminate_child(child: &mut Child) {
    #[cfg(unix)]
    {
        let Ok(pid) = i32::try_from(child.id()) else {
            let _ = child.kill();
            let _ = child.wait();
            return;
        };
        unsafe {
            let _ = kill(-pid, SIGTERM);
        }
        for _ in 0..50 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(_) => break,
            }
        }
        unsafe {
            let _ = kill(-pid, SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = Command::new(concat!("task", "ki", "ll"))
            .args(["/PID", &pid, "/T", "/F"])
            .output();
    }
    let _ = child.wait();
}

#[cfg(unix)]
const SIGTERM: i32 = 15;
#[cfg(unix)]
const SIGKILL: i32 = 9;

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}
