#![allow(clippy::possible_missing_else)]
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

mod order;
mod types;

pub use crate::generated::pi_rpc::*;
pub use order::EventOrder;
pub(crate) use types::settings_identity;
pub use types::{
    DeliveryPolicyLaunchConfig, RpcDiagnostics, RpcError, RpcShutdown, RpcSpawnConfig,
    ValidationEvidenceLaunchConfig, launch_arguments,
};

const TERM_GRACE_POLL_MS: u64 = 20;
const STDERR_COMPLETION_TIMEOUT_MS: u64 = 1_000;
pub const MAX_STDERR_TAIL_BYTES: usize = 256 * 1024;
const VALIDATION_PROFILE_ID: &str = "validation-status.v3";

pub struct RpcClient {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: JsonlReader<BufReader<std::process::ChildStdout>>,
    protocol: RpcProtocol,
    stderr: Receiver<TailRead>,
    stderr_read: Option<TailRead>,
    stderr_completion_failed: bool,
    stderr_limit: usize,
    stderr_metrics: Arc<StderrMetrics>,
}
impl RpcClient {
    pub fn spawn(config: RpcSpawnConfig) -> Result<Self, RpcError> {
        if config.stderr_tail_bytes > MAX_STDERR_TAIL_BYTES {
            return Err(RpcError::ProtocolViolation(format!(
                "rpc stderr tail limit must be <= {MAX_STDERR_TAIL_BYTES}, got {}",
                config.stderr_tail_bytes
            )));
        }
        if config.max_terminal_bytes == 0 || config.max_terminal_bytes > DEFAULT_MAX_TERMINAL_BYTES
        {
            return Err(RpcError::ProtocolViolation(format!(
                "rpc terminal byte limit must be within 1..={DEFAULT_MAX_TERMINAL_BYTES}, got {}",
                config.max_terminal_bytes
            )));
        }
        if config.runtime_addon.is_some()
            && (config.terminal_profile.as_deref().is_none_or(str::is_empty)
                || config.carrier_binding.as_deref().is_none_or(str::is_empty))
        {
            return Err(RpcError::ProtocolViolation(
                "runtime add-on requires terminal profile and carrier binding".to_owned(),
            ));
        }
        if config.terminal_profile.as_deref() == Some("delivery-status.v2")
            && config.delivery_policy.is_none()
        {
            return Err(RpcError::ProtocolViolation(
                "delivery terminal profile requires delivery policy launch config".to_owned(),
            ));
        }
        if config.terminal_profile.as_deref() != Some("delivery-status.v2")
            && config.delivery_policy.is_some()
        {
            return Err(RpcError::ProtocolViolation(
                "delivery policy launch config on non-delivery profile".to_owned(),
            ));
        }
        if config.terminal_profile.as_deref() == Some(VALIDATION_PROFILE_ID)
            && config.validation_evidence.is_none()
        {
            return Err(RpcError::ProtocolViolation(
                "v3 validation profile requires evidence policy launch config".to_owned(),
            ));
        }
        if config.terminal_profile.as_deref() != Some(VALIDATION_PROFILE_ID)
            && config.validation_evidence.is_some()
        {
            return Err(RpcError::ProtocolViolation(
                "validation evidence policy launch config on non-v3 profile".to_owned(),
            ));
        }
        if config.runtime_addon.is_none()
            && (config.terminal_profile.is_some()
                || config.carrier_binding.is_some()
                || config.delivery_policy.is_some()
                || config.validation_evidence.is_some())
        {
            return Err(RpcError::ProtocolViolation(
                "terminal profile/binding/policy without runtime add-on".to_owned(),
            ));
        }
        std::fs::create_dir_all(&config.session_dir).map_err(|error| {
            RpcError::Io(format!(
                "run-owned pi session directory unavailable at {}: {error}",
                config.session_dir.display()
            ))
        })?;
        let mut command = Command::new(&config.pi_executable);
        command
            .current_dir(&config.cwd)
            .args(launch_arguments(&config));
        if let Some(profile) = &config.terminal_profile {
            command.env("AUTOPILOT_TERMINAL_PROFILE", profile);
        }
        if let Some(binding) = &config.carrier_binding {
            command.env("AUTOPILOT_CARRIER_BINDING", binding);
        }
        if let Some(policy) = &config.delivery_policy {
            command.env(
                "AUTOPILOT_DELIVERY_ASSIGNMENT_PATH",
                &policy.assignment_path,
            );
            command.env(
                "AUTOPILOT_DELIVERY_ASSIGNMENT_DIGEST",
                &policy.assignment_digest,
            );
            command.env("AUTOPILOT_DELIVERY_WORKTREE", &policy.worktree);
            command.env("AUTOPILOT_DELIVERY_CWD", &policy.cwd);
            command.env("AUTOPILOT_DELIVERY_ASSIGNMENT_ID", &policy.assignment_id);
            command.env("AUTOPILOT_DELIVERY_WORKSTREAM", &policy.workstream);
            command.env("AUTOPILOT_DELIVERY_LANE_ID", &policy.lane_id);
            command.env("AUTOPILOT_DELIVERY_ATTEMPT", policy.attempt.to_string());
            command.env("AUTOPILOT_DELIVERY_BASE_COMMIT", &policy.base_commit);
            command.env("AUTOPILOT_DELIVERY_POLICY_DIGEST", &policy.policy_digest);
        }
        if let Some(policy) = &config.validation_evidence {
            command.env("AUTOPILOT_VALIDATION_CONTEXT_PATH", &policy.context_path);
            command.env(
                "AUTOPILOT_VALIDATION_CONTEXT_DIGEST",
                &policy.context_digest,
            );
            command.env("AUTOPILOT_VALIDATION_CWD", &policy.cwd);
        }
        for key in ENV_DENY {
            command.env_remove(key);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
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
        let stderr_limit = config.stderr_tail_bytes;
        let (stderr, stderr_metrics) = spawn_tail_reader(stderr, stderr_limit, child.id());
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: JsonlReader::with_max_record_bytes(
                BufReader::new(stdout),
                DEFAULT_MAX_TERMINAL_BYTES,
            ),
            protocol: RpcProtocol::new(config.max_terminal_bytes),
            stderr,
            stderr_read: None,
            stderr_completion_failed: false,
            stderr_limit,
            stderr_metrics,
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
            .and_then(|()| stdin.flush())
            .map_err(|error| RpcError::Io(error.to_string()))
    }
    pub fn complete_bootstrap(&mut self) {
        self.protocol.complete_bootstrap();
    }
    pub fn next_frame(&mut self) -> Result<Option<RpcFrame>, RpcError> {
        self.poll_stderr()?;
        let record = self.stdout.next_record();
        self.poll_stderr()?;
        let Some(line) = record? else {
            terminate_process_group_by_id(self.child.id());
            self.finish_stderr()?;
            self.protocol.finish()?;
            return Ok(None);
        };
        self.protocol.ingest_record(&line).map(Some)
    }
    #[must_use]
    pub fn diagnostics(&self) -> RpcDiagnostics {
        let mut diagnostics = self.protocol.diagnostics(&self.stdout);
        diagnostics.stderr_total_bytes = self.stderr_metrics.total_bytes.load(Ordering::Relaxed);
        diagnostics.stderr_tail_bytes = self.stderr_metrics.tail_bytes.load(Ordering::Relaxed);
        diagnostics.stderr_tail_truncated = self.stderr_metrics.truncated.load(Ordering::Relaxed);
        diagnostics
    }
    pub fn shutdown(&mut self, grace: Duration) -> Result<RpcShutdown, RpcError> {
        self.stdin.take();
        let started = Instant::now();
        loop {
            if let Err(error) = self.poll_stderr() {
                terminate_child(&mut self.child);
                return Err(error);
            }
            match self
                .child
                .try_wait()
                .map_err(|error| RpcError::Shutdown(error.to_string()))?
            {
                Some(status) => {
                    terminate_process_group_by_id(self.child.id());
                    self.finish_stderr()?;
                    return Ok(RpcShutdown {
                        status: Some(status),
                        escalated: false,
                        stderr_tail: self.collect_stderr_tail(),
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
        self.finish_stderr()?;
        Ok(RpcShutdown {
            status,
            escalated: true,
            stderr_tail: self.collect_stderr_tail(),
        })
    }
    fn poll_stderr(&mut self) -> Result<(), RpcError> {
        if self.stderr_read.is_none() {
            match self.stderr.try_recv() {
                Ok(read) => self.stderr_read = Some(read),
                Err(mpsc::TryRecvError::Empty) => return Ok(()),
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.stderr_completion_failed = true;
                    return Err(stderr_completion_error(
                        "reader disconnected before a terminal result",
                    ));
                }
            }
        }
        self.validate_stderr_read()
    }
    fn finish_stderr(&mut self) -> Result<(), RpcError> {
        if self.stderr_completion_failed {
            return Err(stderr_completion_error("previous terminal wait failed"));
        }
        if self.stderr_read.is_none() {
            match self
                .stderr
                .recv_timeout(Duration::from_millis(STDERR_COMPLETION_TIMEOUT_MS))
            {
                Ok(read) => self.stderr_read = Some(read),
                Err(error) => {
                    self.stderr_completion_failed = true;
                    return Err(stderr_completion_error(&error.to_string()));
                }
            }
        }
        self.validate_stderr_read()
    }
    fn validate_stderr_read(&self) -> Result<(), RpcError> {
        let read = self
            .stderr_read
            .as_ref()
            .ok_or_else(|| RpcError::Io("rpc stderr reader has no terminal result".to_owned()))?;
        if read.overflow {
            return Err(RpcError::StderrTooLarge {
                bytes: read.total_bytes,
                limit: self.stderr_limit,
            });
        }
        if let Some(error) = &read.error {
            return Err(RpcError::Io(format!("rpc stderr read failed: {error}")));
        }
        Ok(())
    }
    fn collect_stderr_tail(&self) -> Vec<u8> {
        self.stderr_read
            .as_ref()
            .map_or_else(Vec::new, |read| read.data.clone())
    }
}

fn stderr_completion_error(detail: &str) -> RpcError {
    RpcError::Io(format!(
        "rpc stderr reader did not complete after process termination: {detail}"
    ))
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
    cycle_terminal_payload_bytes: usize,
    bootstrap_open: bool,
    bootstrap_entry_count: usize,
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
            cycle_terminal_payload_bytes: 0,
            bootstrap_open: true,
            bootstrap_entry_count: 0,
        }
    }
    pub fn complete_bootstrap(&mut self) {
        self.bootstrap_open = false;
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
        self.cycle_terminal_payload_bytes = 0;
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
            "message_update" => self.discard(RpcEvent::MessageUpdateDiscarded),
            "tool_execution_update" => self.discard(RpcEvent::ToolExecutionUpdateDiscarded),
            "bash_execution_update" => self.discard(RpcEvent::BashExecutionUpdateDiscarded),
            _ => self.ingest_event(text, &envelope.kind),
        }
    }
    fn discard(&mut self, event: RpcEvent) -> Result<RpcFrame, RpcError> {
        match event {
            RpcEvent::MessageUpdateDiscarded => self.message_update_frames += 1,
            RpcEvent::ToolExecutionUpdateDiscarded => self.tool_update_frames += 1,
            RpcEvent::BashExecutionUpdateDiscarded => self.bash_update_frames += 1,
            _ => {}
        }
        self.order.accept(&event)?;
        Ok(RpcFrame::Event(event))
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
            retained_tail_bytes: self.cycle_terminal_payload_bytes,
            peak_line_bytes: reader.peak_line_bytes,
            peak_line_capacity: reader.peak_line_capacity,
            stderr_total_bytes: 0,
            stderr_tail_bytes: 0,
            stderr_tail_truncated: false,
        }
    }
    fn ingest_response(&mut self, text: &str) -> Result<RpcFrame, RpcError> {
        let parsed: ResponseRecord = serde_json::from_str(text)
            .map_err(|error| RpcError::MalformedFrame(format!("response: {error}")))?;
        let id = parsed
            .id
            .ok_or_else(|| RpcError::UnmatchedResponse("<missing id>".to_owned()))?;
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
        let error = parsed.error;
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
            data: parsed.data.map(|value| value.to_string()),
            error: None,
        }))
    }
    fn terminal_bytes(&mut self, len: usize) -> Result<(), RpcError> {
        if len > self.max_terminal_bytes {
            return Err(RpcError::TerminalPayloadTooLarge {
                bytes: len,
                limit: self.max_terminal_bytes,
            });
        }
        self.cycle_terminal_payload_bytes = self.cycle_terminal_payload_bytes.saturating_add(len);
        if self.cycle_terminal_payload_bytes > self.max_terminal_bytes {
            return Err(RpcError::TerminalPayloadTooLarge {
                bytes: self.cycle_terminal_payload_bytes,
                limit: self.max_terminal_bytes,
            });
        }
        self.terminal_payload_bytes = self.terminal_payload_bytes.saturating_add(len);
        Ok(())
    }
    fn ingest_event(&mut self, text: &str, kind: &str) -> Result<RpcFrame, RpcError> {
        let event = match kind {
            "agent_start" => RpcEvent::AgentStart,
            "agent_end" => RpcEvent::AgentEnd {
                will_retry: serde_json::from_str::<AgentEnd>(text)
                    .map_err(|e| RpcError::MalformedFrame(format!("agent_end: {e}")))?
                    .will_retry,
            },
            "agent_settled" => RpcEvent::AgentSettled,
            "turn_start" => RpcEvent::TurnStart,
            "turn_end" => RpcEvent::TurnEnd,
            "message_start" => RpcEvent::MessageStart,
            "tool_execution_start" => RpcEvent::ToolExecutionStart,
            "message_end" => {
                self.terminal_bytes(text.len())?;
                let message = serde_json::from_str::<MessageEnd>(text)
                    .map_err(|e| RpcError::MalformedFrame(format!("message_end: {e}")))?
                    .message
                    .into_terminal();
                RpcEvent::MessageEnd { message }
            }
            "tool_execution_end" => {
                self.terminal_bytes(text.len())?;
                let p = serde_json::from_str::<ToolExecutionEnd>(text)
                    .map_err(|e| RpcError::MalformedFrame(format!("tool_execution_end: {e}")))?;
                RpcEvent::ToolExecutionEnd {
                    tool_call_id: p.tool_call_id,
                    tool_name: p.tool_name,
                    details: p.result.details,
                    is_error: p.is_error,
                    terminate: p.result.terminate,
                }
            }
            "entry_appended" => {
                if text.len() > MAX_ENTRY_APPENDED_BYTES {
                    return Err(RpcError::EntryAppendedTooLarge {
                        bytes: text.len(),
                        limit: MAX_ENTRY_APPENDED_BYTES,
                    });
                }
                if !self.bootstrap_open {
                    return Err(RpcError::ProtocolViolation(
                        "entry_appended emitted after child bootstrap completed".to_owned(),
                    ));
                }
                if self.bootstrap_entry_count != 0 {
                    return Err(RpcError::ProtocolViolation(
                        "duplicate entry_appended during child bootstrap".to_owned(),
                    ));
                }
                let parsed: EntryAppendedRecord = serde_json::from_str(text)
                    .map_err(|e| RpcError::MalformedFrame(format!("entry_appended: {e}")))?;
                self.bootstrap_entry_count = 1;
                RpcEvent::EntryAppended {
                    entry: AppendedEntry {
                        id: parsed.entry.id,
                        custom_type: parsed.entry.custom_type,
                        data: parsed.entry.data,
                    },
                }
            }
            "queue_update" => {
                let p: QueueUpdate = serde_json::from_str(text)
                    .map_err(|e| RpcError::MalformedFrame(format!("queue_update: {e}")))?;
                RpcEvent::QueueUpdate {
                    steering: p.steering.len(),
                    follow_up: p.follow_up.len(),
                }
            }
            "compaction_start" => RpcEvent::CompactionStart {
                reason: serde_json::from_str::<CompactionStart>(text)
                    .map_err(|e| RpcError::MalformedFrame(format!("compaction_start: {e}")))?
                    .reason,
            },
            "compaction_end" => {
                let p: CompactionEnd = serde_json::from_str(text)
                    .map_err(|e| RpcError::MalformedFrame(format!("compaction_end: {e}")))?;
                RpcEvent::CompactionEnd {
                    reason: p.reason,
                    aborted: p.aborted,
                    will_retry: p.will_retry,
                }
            }
            "auto_retry_start" => RpcEvent::AutoRetryStart,
            "auto_retry_end" => RpcEvent::AutoRetryEnd {
                success: serde_json::from_str::<AutoRetryEnd>(text)
                    .map_err(|e| RpcError::MalformedFrame(format!("auto_retry_end: {e}")))?
                    .success,
            },
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
    max_record_bytes: usize,
    pub total_bytes: usize,
    pub frames: usize,
    pub peak_line_bytes: usize,
    pub peak_line_capacity: usize,
}
impl<R: Read> JsonlReader<R> {
    #[must_use]
    pub fn new(reader: R) -> Self {
        Self::with_max_record_bytes(reader, DEFAULT_MAX_TERMINAL_BYTES)
    }
    #[must_use]
    pub fn with_max_record_bytes(reader: R, max_record_bytes: usize) -> Self {
        Self {
            reader,
            buffer: Vec::new(),
            max_record_bytes,
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
        let mut consumed_total = 0_usize;
        loop {
            let available = self
                .reader
                .fill_buf()
                .map_err(|error| RpcError::Io(error.to_string()))?;
            if available.is_empty() {
                if self.buffer.is_empty() {
                    return Ok(None);
                }
                break;
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let content_bytes = newline.unwrap_or(available.len());
            let next_len = self.buffer.len().saturating_add(content_bytes);
            if next_len > self.max_record_bytes {
                return Err(RpcError::FrameTooLarge {
                    bytes: next_len,
                    limit: self.max_record_bytes,
                });
            }
            self.buffer.extend_from_slice(&available[..content_bytes]);
            let consumed = content_bytes + usize::from(newline.is_some());
            self.reader.consume(consumed);
            consumed_total = consumed_total.saturating_add(consumed);
            if newline.is_some() {
                break;
            }
        }
        self.total_bytes = self.total_bytes.saturating_add(consumed_total);
        if self.buffer.ends_with(b"\r") {
            self.buffer.pop();
        }
        self.frames = self.frames.saturating_add(1);
        self.peak_line_bytes = self.peak_line_bytes.max(self.buffer.len());
        self.peak_line_capacity = self.peak_line_capacity.max(self.buffer.capacity());
        Ok(Some(self.buffer.clone()))
    }
}

#[derive(Debug)]
struct TailRead {
    data: Vec<u8>,
    total_bytes: usize,
    overflow: bool,
    error: Option<String>,
}

#[derive(Debug, Default)]
struct StderrMetrics {
    total_bytes: AtomicUsize,
    tail_bytes: AtomicUsize,
    truncated: AtomicBool,
}

fn spawn_tail_reader<R: Read + Send + 'static>(
    mut reader: R,
    limit: usize,
    child_id: u32,
) -> (Receiver<TailRead>, Arc<StderrMetrics>) {
    let (tx, rx) = mpsc::channel();
    let metrics = Arc::new(StderrMetrics::default());
    let thread_metrics = Arc::clone(&metrics);
    thread::spawn(move || {
        let mut tail = RetainedTail {
            data: Vec::new(),
            limit,
        };
        let mut total_bytes = 0_usize;
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(TailRead {
                        data: tail.data,
                        total_bytes,
                        overflow: false,
                        error: None,
                    });
                    return;
                }
                Err(error) => {
                    let _ = tx.send(TailRead {
                        data: tail.data,
                        total_bytes,
                        overflow: false,
                        error: Some(error.to_string()),
                    });
                    terminate_process_group_by_id(child_id);
                    return;
                }
                Ok(count) => {
                    total_bytes = total_bytes.saturating_add(count);
                    tail.push(&buf[..count]);
                    thread_metrics
                        .total_bytes
                        .store(total_bytes, Ordering::Relaxed);
                    thread_metrics
                        .tail_bytes
                        .store(tail.data.len(), Ordering::Relaxed);
                    thread_metrics
                        .truncated
                        .store(total_bytes > tail.data.len(), Ordering::Relaxed);
                    if total_bytes > limit {
                        let _ = tx.send(TailRead {
                            data: tail.data,
                            total_bytes,
                            overflow: true,
                            error: None,
                        });
                        terminate_process_group_by_id(child_id);
                        return;
                    }
                }
            }
        }
    });
    (rx, metrics)
}
struct RetainedTail {
    data: Vec<u8>,
    limit: usize,
}
impl RetainedTail {
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
}
fn terminate_process_group_by_id(child_id: u32) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(child_id) {
        unsafe {
            let _ = kill(-pid, SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new(concat!("task", "ki", "ll"))
            .args(["/PID", &child_id.to_string(), "/T", "/F"])
            .output();
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
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => thread::sleep(Duration::from_millis(20)),
            }
        }
        unsafe {
            // The leader may exit on SIGTERM while a same-group descendant ignores it.
            // Always close that group before treating stderr/process shutdown as final.
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
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_byte_authority_resets_per_repair_cycle_but_remains_cumulative_diagnostic() {
        let mut protocol = RpcProtocol::new(2 * 1024 * 1024);
        for _ in 0..3 {
            protocol.begin_cycle();
            protocol.terminal_bytes(700_000).expect("tool result");
            protocol.terminal_bytes(700_000).expect("message result");
        }
        assert_eq!(protocol.cycle_terminal_payload_bytes, 1_400_000);
        assert_eq!(protocol.terminal_payload_bytes, 4_200_000);

        protocol.begin_cycle();
        protocol.terminal_bytes(1_100_000).expect("first frame");
        assert!(matches!(
            protocol.terminal_bytes(1_100_000),
            Err(RpcError::TerminalPayloadTooLarge { .. })
        ));
    }
}

#[cfg(unix)]
const SIGTERM: i32 = 15;
#[cfg(unix)]
const SIGKILL: i32 = 9;
#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}
