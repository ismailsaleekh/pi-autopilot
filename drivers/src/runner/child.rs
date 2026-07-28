use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::checkpoint::{
    self, AgentHandoff, CheckpointInput, CheckpointPolicy, CheckpointSource, ContextAction,
    ContextBudget,
};
use crate::runner::rpc::{
    CompactionReason, RpcClient, RpcCommand, RpcCommandKind, RpcDiagnostics, RpcEvent, RpcFrame,
    RpcResponse, RpcSpawnConfig, TerminalMessage,
};

use kernel::failure::{Failure, OperatorDecision, RetryPolicy};
use kernel::generated::{AgentRunSpec, DeliveryResult, TaskDocument};
use serde_json::Value;
use sha2::{Digest as ShaDigest, Sha256};

const DEFAULT_MAX_PI_STDOUT_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_PI_STDERR_BYTES: usize = 256 * 1024;
const MAX_VALUE_ATTEMPTS: u32 = 3;

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

pub fn main(args: &[String]) -> Result<(), String> {
    let spec_path = parse_args(args)?;
    super::reject_link_components_for_path(&spec_path).map_err(|error| error.to_string())?;
    super::require_regular_file(&spec_path).map_err(|error| error.to_string())?;
    let raw = fs::read_to_string(&spec_path)
        .map_err(|error| format!("agent-run spec read failed {:?}: {error}", spec_path))?;
    let mut spec_value: Value = serde_json::from_str(&raw).map_err(|error| {
        format!("agent-run spec is malformed, incomplete, or has unknown fields: {error}")
    })?;
    let planning_context_documents = spec_value
        .get("context_documents")
        .cloned()
        .map(|value| {
            serde_json::from_value::<Vec<TaskDocument>>(value)
                .map_err(|error| format!("agent-run context_documents is malformed: {error}"))
        })
        .transpose()?;
    if planning_context_documents.is_some() {
        spec_value
            .as_object_mut()
            .ok_or_else(|| "agent-run spec top-level must be an object".to_owned())?
            .remove("context_documents");
    }
    let spec: AgentRunSpec = serde_json::from_value(spec_value).map_err(|error| {
        format!("agent-run spec is malformed, incomplete, or has unknown fields: {error}")
    })?;
    let spec_digest = sha256_hex(raw.as_bytes());
    validate_spec(&spec, planning_context_documents.as_deref(), &spec_path)?;
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
    if existing_carrier_valid(&spec_path, &spec_digest, &spec)? {
        append_attempt_event(&spec, 0, "existing-carrier-accepted", None)?;
        return Ok(());
    }
    let mut runner = RpcAssignment::spawn_and_configure(&spec)?;
    let result = run_value_attempts(&mut runner, &spec_path, &spec_digest, &spec, prompt);
    let shutdown = runner.shutdown();
    if result.is_ok() {
        shutdown?;
    }
    result
}

fn run_value_attempts(
    runner: &mut RpcAssignment,
    spec_path: &Path,
    spec_digest: &str,
    spec: &AgentRunSpec,
    prompt: String,
) -> Result<(), String> {
    let mut attempt_prompt = prompt;
    for attempt in 1..=MAX_VALUE_ATTEMPTS {
        append_attempt_event(spec, attempt, "started", None)?;
        let assistant = runner.run_normal_prompt(spec, &attempt_prompt)?;
        match write_carrier(spec_path, spec_digest, spec, &assistant) {
            Ok(()) => {
                append_attempt_event(spec, attempt, "accepted", None)?;
                return Ok(());
            }
            Err(rejection) if attempt < MAX_VALUE_ATTEMPTS => {
                append_attempt_event(spec, attempt, "value-rejected", Some(&rejection))?;
                attempt_prompt = render_repair_prompt(spec, &rejection);
            }
            Err(rejection) => {
                append_attempt_event(spec, attempt, "paused-after-exhaustion", Some(&rejection))?;
                return Err(paused_after_exhaustion(spec, &rejection));
            }
        }
    }
    unreachable!("bounded value attempt loop must return")
}

struct RpcAssignment {
    client: RpcClient,
    next_command: u64,
    policy: CheckpointPolicy,
    last_known_percent: Option<f64>,
    checkpoint_armed: bool,
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
    prompt_response_seen: bool,
    pending_stats: BTreeSet<String>,
    final_record: Option<CycleTerminal>,
    terminal_count: usize,
    tool_after_terminal: bool,
    awaiting_handoff: bool,
    steer_response_seen: bool,
    steer_queue_seen: bool,
    steer_message_started: bool,
    handoff: Option<AgentHandoff>,
    compacted: bool,
}

impl CycleState {
    fn new(purpose: PromptPurpose) -> Self {
        Self {
            purpose,
            prompt_response_seen: false,
            pending_stats: BTreeSet::new(),
            final_record: None,
            terminal_count: 0,
            tool_after_terminal: false,
            awaiting_handoff: matches!(purpose, PromptPurpose::Handoff),
            steer_response_seen: false,
            steer_queue_seen: false,
            steer_message_started: matches!(purpose, PromptPurpose::Handoff),
            handoff: None,
            compacted: false,
        }
    }
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
        let stdout_limit = env_usize(
            "AUTOPILOT_AGENT_RUN_MAX_STDOUT_BYTES",
            DEFAULT_MAX_PI_STDOUT_BYTES,
        );
        let policy = CheckpointPolicy::parse()?;
        let mut config = RpcSpawnConfig::new(
            PathBuf::from(&spec.cwd.0),
            spec.provider.clone(),
            spec.model.clone(),
            spec.thinking.0.clone(),
            spec.session_id.0.clone(),
            tools,
        );
        config.stderr_tail_bytes = stderr_limit;
        config.max_terminal_bytes = stdout_limit.max(DEFAULT_MAX_PI_STDOUT_BYTES);
        let client = RpcClient::spawn(config).map_err(|error| error.to_string())?;
        let mut runner = Self {
            client,
            next_command: 0,
            policy,
            last_known_percent: None,
            checkpoint_armed: false,
        };
        let auto_id = runner.next_id("auto-off");
        let response = runner.command_response(RpcCommand::set_auto_compaction(auto_id, false))?;
        if !response.success {
            return Err("agent-run set_auto_compaction returned success:false".to_owned());
        }
        let state_id = runner.next_id("state");
        let state = runner.command_response(RpcCommand::get_state(state_id))?;
        runner.validate_state(spec, &state)?;
        Ok(runner)
    }

    fn run_normal_prompt(&mut self, spec: &AgentRunSpec, prompt: &str) -> Result<String, String> {
        self.run_prompt(spec, prompt, PromptPurpose::Normal)
    }

    fn run_prompt(
        &mut self,
        spec: &AgentRunSpec,
        prompt: &str,
        purpose: PromptPurpose,
    ) -> Result<String, String> {
        let prompt_id = self.next_id("prompt");
        self.client
            .send_command(RpcCommand::prompt(prompt_id.clone(), prompt.to_owned()))
            .map_err(|error| error.to_string())?;
        let mut state = CycleState::new(purpose);
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
                        return Err(
                            "agent-run prompt response missing before agent_settled".to_owned()
                        );
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
                                return Err(format!(
                                    "agent-run rpc event after agent_settled while awaiting stats: {event:?}"
                                ));
                            }
                        }
                    }
                    return self.finish_cycle(spec, state);
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
            RpcEvent::ToolExecutionStart | RpcEvent::ToolExecutionEnd => {
                if state.final_record.is_some() {
                    state.tool_after_terminal = true;
                }
                if matches!(event, RpcEvent::ToolExecutionEnd) {
                    self.request_stats(state)?;
                }
                Ok(())
            }
            RpcEvent::AgentEnd { will_retry } => {
                let _ = will_retry;
                Ok(())
            }
            RpcEvent::CompactionStart {
                reason: CompactionReason::Threshold | CompactionReason::Overflow,
            } => Err("agent-run Pi attempted automatic compaction".to_owned()),
            _ => Ok(()),
        }
    }

    fn handle_message_end(
        &mut self,
        spec: &AgentRunSpec,
        state: &mut CycleState,
        message: TerminalMessage,
    ) -> Result<(), String> {
        if message.role != "assistant" {
            return Ok(());
        }
        let record = assistant_from_terminal(message)?;
        if record.stop_reason == "tooluse" {
            self.request_stats(state)?;
            return Ok(());
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
            state.terminal_count = state.terminal_count.saturating_add(1);
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
        let budget = context_budget_from_stats(response)?;
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
                if state.final_record.is_some() {
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

    fn finish_cycle(&mut self, spec: &AgentRunSpec, state: CycleState) -> Result<String, String> {
        if state.tool_after_terminal {
            return Err(
                "agent-run Pi JSONL had tool activity after terminal assistant result".to_owned(),
            );
        }
        if let Some(handoff) = state.handoff {
            let checkpoint = self.checkpoint_record(spec, handoff)?;
            if !state.compacted {
                self.compact_checkpoint(&checkpoint)?;
            }
            let resume = self.resume_prompt(&checkpoint.resume_overlay)?;
            return self.run_prompt(spec, &resume, PromptPurpose::Resume);
        }
        if state.awaiting_handoff {
            match &state.final_record {
                Some(candidate)
                    if validate_assistant_value(spec, &candidate.record.text).is_ok() =>
                {
                    return Ok(candidate.record.text.clone());
                }
                _ => {}
            }
            self.abort_stale_queue()?;
            let handoff_prompt = self.handoff_prompt(spec)?;
            return self.run_prompt(spec, &handoff_prompt, PromptPurpose::Handoff);
        }
        if state.terminal_count == 0 {
            return Err("agent-run Pi JSONL contained no final assistant result".to_owned());
        }
        if state.terminal_count != 1 {
            return Err(format!(
                "agent-run Pi JSONL contained {} terminal assistant results; expected exactly one",
                state.terminal_count
            ));
        }
        let record = state
            .final_record
            .ok_or_else(|| "agent-run Pi JSONL contained no final assistant result".to_owned())?;
        if record.record.text.trim().is_empty() {
            return Err("agent-run Pi JSONL contained empty final assistant result".to_owned());
        }
        Ok(record.record.text)
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
        let frame = self
            .client
            .next_frame()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "agent-run rpc stream ended before command response".to_owned())?;
        match frame {
            RpcFrame::Response(response) if response.id == expected => Ok(response),
            RpcFrame::Response(response) => Err(format!(
                "agent-run unexpected rpc response id {}; expected {expected}",
                response.id
            )),
            RpcFrame::Event(event) => Err(format!(
                "agent-run unexpected rpc event before configuration completed: {event:?}"
            )),
        }
    }

    fn validate_state(&self, spec: &AgentRunSpec, response: &RpcResponse) -> Result<(), String> {
        let data = response
            .data
            .as_ref()
            .ok_or_else(|| "agent-run get_state missing data".to_owned())?;
        let value: Value = serde_json::from_str(data)
            .map_err(|error| format!("agent-run get_state malformed data: {error}"))?;
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
        Ok(())
    }

    fn checkpoint_record(
        &self,
        spec: &AgentRunSpec,
        handoff: AgentHandoff,
    ) -> Result<checkpoint::CheckpointRecord, String> {
        let percent = self
            .last_known_percent
            .ok_or_else(|| "agent-run checkpoint missing known context percent".to_owned())?;
        let input = if spec.result_contract.0 == "autopilot.delivery_result.v1" {
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

fn context_budget_from_stats(response: &RpcResponse) -> Result<ContextBudget, String> {
    let data = response
        .data
        .as_ref()
        .ok_or_else(|| "agent-run get_session_stats missing data".to_owned())?;
    let value: Value = serde_json::from_str(data)
        .map_err(|error| format!("agent-run get_session_stats malformed data: {error}"))?;
    let Some(context) = value.get("contextUsage") else {
        return Ok(ContextBudget::Unknown);
    };
    match context.get("percent") {
        Some(Value::Null) | None => Ok(ContextBudget::Unknown),
        Some(Value::Number(number)) => checkpoint::ContextBudget::known(
            number
                .as_f64()
                .ok_or_else(|| "agent-run context percent was not finite f64".to_owned())?,
        )
        .map_err(|error| format!("agent-run context percent invalid: {error:?}")),
        _ => Err("agent-run context percent has wrong type".to_owned()),
    }
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

fn validate_assistant_value(spec: &AgentRunSpec, assistant: &str) -> Result<(), ValueRejection> {
    if spec.result_contract.0 == "autopilot.delivery_result.v1" {
        let carrier: DeliveryResult = serde_json::from_str(assistant).map_err(|error| {
            value_rejection(
                "carrier",
                "autopilot.delivery_result.v1 JSON object",
                format!("invalid JSON: {error}"),
            )
        })?;
        validate_delivery_carrier(spec, &carrier)
    } else {
        crate::runner::validate_child_boundary(spec, assistant)
            .map(|_| ())
            .map_err(|error| {
                value_rejection(
                    "raw_output",
                    format!("{} admitted value", error.boundary_id()),
                    error.actual().to_owned(),
                )
            })
    }
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

fn validate_spec(
    strict: &AgentRunSpec,
    planning_context_documents: Option<&[TaskDocument]>,
    spec_path: &Path,
) -> Result<(), String> {
    if strict.schema.0 != "autopilot.agent_run_spec.v1" {
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
    validate_digests(strict, planning_context_documents)?;
    validate_session_identity(strict)?;
    validate_delivery_identity(strict)?;
    validate_planning_documents(strict, planning_context_documents)?;
    Ok(())
}

fn validate_session_identity(strict: &AgentRunSpec) -> Result<(), String> {
    let expected = super::session_id_for(
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
    let tools =
        super::role_builtin_tool_names(&strict.role_id.0).map_err(|error| error.to_string())?;
    let actual_tools = strict
        .allowed_tools
        .iter()
        .map(|tool| tool.0.clone())
        .collect::<Vec<_>>();
    if actual_tools != tools {
        return Err(format!(
            "agent-run allowed tools drift: expected {:?}, got {:?}",
            tools, actual_tools
        ));
    }
    let expected_boundary =
        super::expected_boundary_for_role(&strict.role_id.0).ok_or_else(|| {
            format!(
                "agent-run role has no result boundary: {}",
                strict.role_id.0
            )
        })?;
    if strict.boundary_id.0 != expected_boundary || strict.result_contract.0 != expected_boundary {
        return Err(format!(
            "agent-run result contract drift: expected {expected_boundary}, got boundary={} result={}",
            strict.boundary_id.0, strict.result_contract.0
        ));
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
    let expected_paths = if strict.result_contract.0 == "autopilot.delivery_result.v1" {
        super::delivery_paths(&cwd, &strict.assignment_id)
    } else {
        super::planning_paths(&cwd, &strict.workstream.0, &strict.assignment_id)
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

fn validate_digests(
    strict: &AgentRunSpec,
    planning_context_documents: Option<&[TaskDocument]>,
) -> Result<(), String> {
    let route = super::route_for_role(&strict.role_id.0).map_err(|error| error.to_string())?;
    let expected_boundary =
        super::contract_digest(&strict.boundary_id.0).map_err(|error| error.to_string())?;
    let expected_result =
        super::contract_digest(&strict.result_contract.0).map_err(|error| error.to_string())?;
    let expected_subscription = super::subscription_digest(&route);
    if strict.boundary_digest.0 != expected_boundary
        || strict.result_contract_digest.0 != expected_result
        || strict.settings_digest.0 != super::settings_digest()
        || strict.skills_digest.0 != super::skills_digest()
        || strict.subscription_digest.0 != expected_subscription
    {
        return Err("agent-run authority/settings/subscription digest drift".to_owned());
    }
    let context_digest = if strict.result_contract.0 == "autopilot.delivery_result.v1" {
        sha_json(&serde_json::json!({
            "workstream": strict.workstream.0,
            "lane_id": strict.lane_id.as_ref().map(|id| id.0.as_str()),
            "attempt": strict.attempt,
            "base_commit": strict.base_commit.as_ref().map(|sha| sha.0.as_str()),
            "worktree": strict.worktree.as_ref().map(|path| path.0.as_str()),
            "required_focused_evidence": strict.required_focused_evidence,
        }))?
    } else {
        match planning_context_documents {
            Some(context_documents) => sha_json(&serde_json::json!({
                "authority_set_id": strict.authority_set_id.as_deref(),
                "authority_documents": strict.authority_documents.as_ref(),
                "context_documents": context_documents,
            }))?,
            None => sha_json(&serde_json::json!({
                "authority_set_id": strict.authority_set_id.as_deref(),
                "authority_documents": strict.authority_documents.as_ref(),
                "context_document": strict.context_document.as_ref(),
            }))?,
        }
    };
    if strict.context_digest.0 != context_digest {
        return Err("agent-run context digest drift".to_owned());
    }
    Ok(())
}

fn validate_delivery_identity(strict: &AgentRunSpec) -> Result<(), String> {
    if strict.result_contract.0 != "autopilot.delivery_result.v1" {
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

fn validate_planning_documents(
    strict: &AgentRunSpec,
    planning_context_documents: Option<&[TaskDocument]>,
) -> Result<(), String> {
    if strict.result_contract.0 == "autopilot.delivery_result.v1" {
        if strict.authority_set_id.is_some()
            || strict.authority_documents.is_some()
            || strict.context_document.is_some()
            || planning_context_documents.is_some()
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
    if let Some(context_documents) = planning_context_documents {
        if context_documents.is_empty() {
            return Err("agent-run missing context documents".to_owned());
        }
        if context_documents.first() != Some(context) {
            return Err("agent-run context_document alias drift".to_owned());
        }
        for document in context_documents {
            validate_doc(document, "context/non-authority", authority_set_id)?;
        }
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

fn validate_terminal_assistant(
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
    format!(
        "Your {} call was rejected.\n  field:    {}\n  expected: {}\n  got:      {}\nRe-emit with corrected values.",
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

fn append_attempt_event(
    spec: &AgentRunSpec,
    attempt: u32,
    event: &str,
    rejection: Option<&ValueRejection>,
) -> Result<(), String> {
    let root = Path::new(&spec.cwd.0).join(".pi/autopilot/runner/attempt-events");
    fs::create_dir_all(&root)
        .map_err(|error| format!("agent-run attempt event mkdir failed {:?}: {error}", root))?;
    let path = root.join(format!("{}.jsonl", spec.assignment_id.0));
    super::reject_link_components_for_path(&path).map_err(|error| error.to_string())?;
    let row = serde_json::json!({
        "schema": "autopilot.agent_run_attempt_event.v1",
        "assignment_id": spec.assignment_id.0,
        "session_id": spec.session_id.0,
        "attempt": attempt,
        "event": event,
        "rejection": rejection.map(|value| serde_json::json!({
            "field": value.field.clone(),
            "expected": value.expected.clone(),
            "got": value.got.clone(),
        })),
    });
    let mut data = serde_json::to_vec(&row)
        .map_err(|error| format!("agent-run attempt event serialize failed: {error}"))?;
    data.push(b'\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("agent-run attempt event open failed {:?}: {error}", path))?;
    file.write_all(&data)
        .map_err(|error| format!("agent-run attempt event write failed {:?}: {error}", path))?;
    file.sync_all()
        .map_err(|error| format!("agent-run attempt event fsync failed {:?}: {error}", path))?;
    Ok(())
}

fn existing_carrier_valid(
    spec_path: &Path,
    spec_digest: &str,
    spec: &AgentRunSpec,
) -> Result<bool, String> {
    let path = Path::new(&spec.carrier_path.0);
    super::reject_link_components_for_path(path).map_err(|error| error.to_string())?;
    let text = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("carrier inspection failed {:?}: {error}", path)),
    };
    validate_existing_carrier(spec_path, spec_digest, spec, &text).map_err(|rejection| {
        format!(
            "agent-run stale carrier rejected field={} expected={} got={}",
            rejection.field, rejection.expected, rejection.got
        )
    })?;
    Ok(true)
}

fn validate_existing_carrier(
    spec_path: &Path,
    spec_digest: &str,
    spec: &AgentRunSpec,
    text: &str,
) -> Result<(), ValueRejection> {
    if spec.result_contract.0 == "autopilot.delivery_result.v1" {
        let mut carrier: DeliveryResult = serde_json::from_str(text).map_err(|error| {
            value_rejection(
                "carrier",
                "existing autopilot.delivery_result.v1 JSON object",
                format!("invalid JSON: {error}"),
            )
        })?;
        validate_delivery_carrier(spec, &carrier)?;
        bind_delivery_carrier(spec_path, spec_digest, spec, &mut carrier)?;
        return Ok(());
    }
    let value: Value = serde_json::from_str(text).map_err(|error| {
        value_rejection(
            "carrier",
            "existing autopilot.planning_carrier.v1 JSON object",
            format!("invalid JSON: {error}"),
        )
    })?;
    validate_existing_planning_carrier(spec_path, spec_digest, spec, &value)
}

fn write_carrier(
    spec_path: &Path,
    spec_digest: &str,
    spec: &AgentRunSpec,
    assistant: &str,
) -> Result<(), ValueRejection> {
    if spec.result_contract.0 == "autopilot.delivery_result.v1" {
        let mut carrier: DeliveryResult = serde_json::from_str(assistant).map_err(|error| {
            value_rejection(
                "carrier",
                "autopilot.delivery_result.v1 JSON object",
                format!("invalid JSON: {error}"),
            )
        })?;
        validate_delivery_carrier(spec, &carrier)?;
        bind_delivery_carrier(spec_path, spec_digest, spec, &mut carrier)?;
        write_json_new(&spec.carrier_path.0, &carrier).map_err(|error| {
            value_rejection("carrier_path", "create-once writable carrier path", error)
        })
    } else {
        crate::runner::validate_child_boundary(spec, assistant).map_err(|error| {
            value_rejection(
                "raw_output",
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
            "spec_digest": spec_digest,
            "spec_path": super::path_to_string(spec_path).map_err(|error| {
                value_rejection("spec_path", "absolute runner spec path", error.to_string())
            })?,
            "carrier_path": spec.carrier_path.0,
            "raw_output": assistant,
        });
        write_json_new(&spec.carrier_path.0, &carrier).map_err(|error| {
            value_rejection("carrier_path", "create-once writable carrier path", error)
        })
    }
}

fn validate_existing_planning_carrier(
    spec_path: &Path,
    spec_digest: &str,
    spec: &AgentRunSpec,
    value: &Value,
) -> Result<(), ValueRejection> {
    for (field, expected) in [
        ("schema", "autopilot.planning_carrier.v1".to_owned()),
        ("action_id", spec.action_id.0.clone()),
        ("assignment_id", spec.assignment_id.0.clone()),
        ("run_revision", spec.run_revision.to_string()),
        ("workstream", spec.workstream.0.clone()),
        ("role_id", spec.role_id.0.clone()),
        ("mode", spec.mode.0.clone()),
        ("boundary_id", spec.boundary_id.0.clone()),
        ("result_contract", spec.result_contract.0.clone()),
        ("prompt_path", spec.prompt_path.0.clone()),
        ("prompt_digest", spec.prompt_digest.0.clone()),
        ("boundary_digest", spec.boundary_digest.0.clone()),
        (
            "result_contract_digest",
            spec.result_contract_digest.0.clone(),
        ),
        ("settings_digest", spec.settings_digest.0.clone()),
        ("context_digest", spec.context_digest.0.clone()),
        ("skills_digest", spec.skills_digest.0.clone()),
        ("subscription_digest", spec.subscription_digest.0.clone()),
        ("spec_digest", spec_digest.to_owned()),
        (
            "spec_path",
            super::path_to_string(spec_path).map_err(|error| {
                value_rejection("spec_path", "absolute runner spec path", error.to_string())
            })?,
        ),
        ("carrier_path", spec.carrier_path.0.clone()),
    ] {
        let got = if field == "run_revision" {
            value
                .get(field)
                .and_then(Value::as_u64)
                .map(|v| v.to_string())
        } else {
            value.get(field).and_then(Value::as_str).map(str::to_owned)
        };
        if got.as_deref() != Some(expected.as_str()) {
            return Err(value_rejection(
                field,
                expected,
                got.unwrap_or_else(|| "missing-or-wrong-type".to_owned()),
            ));
        }
    }
    let raw = value
        .get("raw_output")
        .and_then(Value::as_str)
        .ok_or_else(|| value_rejection("raw_output", "string", "missing-or-wrong-type"))?;
    crate::runner::validate_child_boundary(spec, raw).map_err(|error| {
        value_rejection(
            "raw_output",
            format!("{} admitted value", error.boundary_id()),
            error.actual().to_owned(),
        )
    })?;
    Ok(())
}

fn bind_delivery_carrier(
    spec_path: &Path,
    spec_digest: &str,
    spec: &AgentRunSpec,
    carrier: &mut DeliveryResult,
) -> Result<(), ValueRejection> {
    carrier.action_id = Some(spec.action_id.clone());
    carrier.prompt_path = Some(spec.prompt_path.clone());
    carrier.prompt_digest = Some(spec.prompt_digest.clone());
    carrier.spec_path = Some(kernel::generated::Path(
        super::path_to_string(spec_path).map_err(|error| {
            value_rejection("spec_path", "absolute runner spec path", error.to_string())
        })?,
    ));
    carrier.spec_digest = Some(kernel::generated::Digest(spec_digest.to_owned()));
    carrier.carrier_path = Some(spec.carrier_path.clone());
    carrier.boundary_digest = Some(spec.boundary_digest.clone());
    carrier.result_contract_digest = Some(spec.result_contract_digest.clone());
    carrier.settings_digest = Some(spec.settings_digest.clone());
    carrier.context_digest = Some(spec.context_digest.clone());
    carrier.skills_digest = Some(spec.skills_digest.clone());
    carrier.subscription_digest = Some(spec.subscription_digest.clone());
    Ok(())
}

fn delivery_identity_got(carrier: &DeliveryResult) -> String {
    format!(
        "assignment_id={} role_id={} mode={} run_revision={} lane_id={} attempt={} base_commit={} worktree={}",
        carrier.assignment_id.0,
        carrier.role_id.0,
        carrier.mode.0,
        carrier.run_revision,
        carrier.lane_id.0,
        carrier.attempt,
        carrier.base_commit.0,
        carrier.worktree.0
    )
}

fn validate_delivery_carrier(
    spec: &AgentRunSpec,
    carrier: &DeliveryResult,
) -> Result<(), ValueRejection> {
    let lane = spec
        .lane_id
        .as_ref()
        .ok_or_else(|| value_rejection("lane_id", "runner-issued lane identity", "missing"))?;
    let attempt = spec
        .attempt
        .ok_or_else(|| value_rejection("attempt", "runner-issued attempt identity", "missing"))?;
    let base = spec
        .base_commit
        .as_ref()
        .ok_or_else(|| value_rejection("base_commit", "runner-issued base identity", "missing"))?;
    let worktree = spec
        .worktree
        .as_ref()
        .ok_or_else(|| value_rejection("worktree", "runner-issued worktree identity", "missing"))?;
    if carrier.assignment_id != spec.assignment_id
        || carrier.role_id != spec.role_id
        || carrier.mode != spec.mode
        || carrier.run_revision != spec.run_revision
        || carrier.lane_id != *lane
        || carrier.attempt != attempt
        || carrier.base_commit != *base
        || carrier.worktree.0 != worktree.0
    {
        return Err(value_rejection(
            "carrier.identity",
            "assignment_id/role_id/mode/run_revision/lane_id/attempt/base_commit/worktree matching spec",
            delivery_identity_got(carrier),
        ));
    }
    if carrier
        .action_id
        .as_ref()
        .is_some_and(|value| value != &spec.action_id)
        || carrier
            .prompt_path
            .as_ref()
            .is_some_and(|value| value != &spec.prompt_path)
        || carrier
            .prompt_digest
            .as_ref()
            .is_some_and(|value| value != &spec.prompt_digest)
        || carrier
            .spec_path
            .as_ref()
            .is_some_and(|value| value != &spec.spec_path)
        || carrier
            .carrier_path
            .as_ref()
            .is_some_and(|value| value != &spec.carrier_path)
        || carrier
            .boundary_digest
            .as_ref()
            .is_some_and(|value| value != &spec.boundary_digest)
        || carrier
            .result_contract_digest
            .as_ref()
            .is_some_and(|value| value != &spec.result_contract_digest)
        || carrier
            .settings_digest
            .as_ref()
            .is_some_and(|value| value != &spec.settings_digest)
        || carrier
            .context_digest
            .as_ref()
            .is_some_and(|value| value != &spec.context_digest)
        || carrier
            .skills_digest
            .as_ref()
            .is_some_and(|value| value != &spec.skills_digest)
        || carrier
            .subscription_digest
            .as_ref()
            .is_some_and(|value| value != &spec.subscription_digest)
    {
        return Err(value_rejection(
            "carrier.binding",
            "optional binding fields absent or matching runner spec",
            "binding drift",
        ));
    }
    Ok(())
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
