#![allow(clippy::possible_missing_else)]
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
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
    launch_arguments,
};

const TERM_GRACE_POLL_MS: u64 = 20;

pub struct RpcClient {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: JsonlReader<BufReader<std::process::ChildStdout>>,
    protocol: RpcProtocol,
    stderr: Receiver<TailRead>,
}
impl RpcClient {
    pub fn spawn(config: RpcSpawnConfig) -> Result<Self, RpcError> {
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
        if config.runtime_addon.is_none()
            && (config.terminal_profile.is_some()
                || config.carrier_binding.is_some()
                || config.delivery_policy.is_some())
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
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: JsonlReader::new(BufReader::new(stdout)),
            protocol: RpcProtocol::new(config.max_terminal_bytes),
            stderr: spawn_tail_reader(stderr, config.stderr_tail_bytes),
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
        let Some(line) = self.stdout.next_record()? else {
            self.protocol.finish()?;
            return Ok(None);
        };
        self.protocol.ingest_record(&line).map(Some)
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
        Ok(RpcShutdown {
            status,
            escalated: true,
            stderr_tail: self.collect_stderr_tail(),
        })
    }
    fn collect_stderr_tail(&mut self) -> Vec<u8> {
        self.stderr
            .try_recv()
            .map_or_else(|_| Vec::new(), |read| read.data)
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
            retained_tail_bytes: self.terminal_payload_bytes,
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
        self.terminal_payload_bytes = self.terminal_payload_bytes.saturating_add(len);
        if self.terminal_payload_bytes > self.max_terminal_bytes {
            return Err(RpcError::TerminalPayloadTooLarge {
                bytes: self.terminal_payload_bytes,
                limit: self.max_terminal_bytes,
            });
        }
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

#[derive(Debug)]
struct TailRead {
    data: Vec<u8>,
}
fn spawn_tail_reader<R: Read + Send + 'static>(mut reader: R, limit: usize) -> Receiver<TailRead> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut tail = RetainedTail {
            data: Vec::new(),
            limit,
        };
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(TailRead { data: tail.data });
                    return;
                }
                Ok(n) => tail.push(&buf[..n]),
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
