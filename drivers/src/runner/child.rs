use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kernel::failure::{Failure, OperatorDecision, RetryPolicy};
use kernel::generated::{AgentRunSpec, DeliveryResult, TaskDocument};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest as ShaDigest, Sha256};

const DEFAULT_MAX_PI_STDOUT_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_PI_STDERR_BYTES: usize = 256 * 1024;
const DEFAULT_PI_TIMEOUT_MS: u64 = 60 * 60 * 1000;
const MAX_VALUE_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Eq, PartialEq)]
struct ValueRejection {
    field: String,
    expected: String,
    got: String,
}

struct ChildOutput {
    assistant: Option<String>,
    stdout_error: Option<String>,
    stderr_error: Option<String>,
    stdout_tail: Vec<u8>,
    stderr_tail: Vec<u8>,
    status: Option<std::process::ExitStatus>,
    timed_out: bool,
    diagnostics: StreamDiagnostics,
}

#[derive(Debug, Clone)]
struct StreamDiagnostics {
    stdout_total_bytes: usize,
    stderr_total_bytes: usize,
    stdout_tail_bytes: usize,
    stderr_tail_bytes: usize,
    stdout_tail_truncated: bool,
    stderr_tail_truncated: bool,
    stdout_lines: usize,
    final_event_bytes: usize,
    peak_retained_stdout_bytes: usize,
    peak_retained_stderr_bytes: usize,
    stdout_limit: usize,
    stderr_limit: usize,
}

struct StdoutRead {
    assistant: Option<String>,
    error: Option<String>,
    tail: Vec<u8>,
    total_bytes: usize,
    lines: usize,
    final_event_bytes: usize,
    tail_truncated: bool,
    peak_retained_bytes: usize,
}

struct TailRead {
    data: Vec<u8>,
    read_error: Option<String>,
    total_bytes: usize,
    tail_truncated: bool,
    peak_retained_bytes: usize,
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
    if existing_carrier_valid(&spec_path, &spec_digest, &spec)? {
        append_attempt_event(&spec, 0, "existing-carrier-accepted", None)?;
        return Ok(());
    }
    let mut attempt_prompt = prompt;
    for attempt in 1..=MAX_VALUE_ATTEMPTS {
        append_attempt_event(&spec, attempt, "started", None)?;
        let output = checked_pi_output(&spec, &attempt_prompt)?;
        let assistant = output
            .assistant
            .as_deref()
            .ok_or_else(|| "agent-run Pi JSONL contained no final assistant result".to_owned())?;
        match write_carrier(&spec_path, &spec_digest, &spec, assistant) {
            Ok(()) => {
                append_attempt_event(&spec, attempt, "accepted", None)?;
                return Ok(());
            }
            Err(rejection) if attempt < MAX_VALUE_ATTEMPTS => {
                append_attempt_event(&spec, attempt, "value-rejected", Some(&rejection))?;
                attempt_prompt = render_repair_prompt(&spec, &rejection);
            }
            Err(rejection) => {
                append_attempt_event(&spec, attempt, "paused-after-exhaustion", Some(&rejection))?;
                return Err(paused_after_exhaustion(&spec, &rejection));
            }
        }
    }
    unreachable!("bounded value attempt loop must return")
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

fn checked_pi_output(spec: &AgentRunSpec, prompt: &str) -> Result<ChildOutput, String> {
    let output = launch_pi(spec, prompt)?;
    write_stats_if_requested(&output)?;
    if output.timed_out {
        return Err(transient_with_artifact(
            spec,
            &output,
            "AUTOPILOT_AGENT_RUN_TIMEOUT_MS",
            "timeout",
            "agent-run pi wall timeout exceeded",
        ));
    }
    let status = output
        .status
        .ok_or_else(|| "agent-run pi status unavailable after launch".to_owned())?;
    if !status.success() {
        return Err(error_with_optional_artifact(
            spec,
            &output,
            "AUTOPILOT_AGENT_RUN_MAX_STDERR_BYTES",
            &format!(
                "agent-run pi exited nonzero status={status} stderr={}",
                String::from_utf8_lossy(&output.stderr_tail)
            ),
        ));
    }
    if let Some(error) = &output.stderr_error {
        return Err(error_with_optional_artifact(
            spec,
            &output,
            "AUTOPILOT_AGENT_RUN_MAX_STDERR_BYTES",
            error,
        ));
    }
    if let Some(error) = &output.stdout_error {
        return Err(error_with_optional_artifact(
            spec,
            &output,
            "AUTOPILOT_AGENT_RUN_MAX_STDOUT_BYTES",
            error,
        ));
    }
    Ok(output)
}

fn validate_spec(strict: &AgentRunSpec, spec_path: &Path) -> Result<(), String> {
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
    validate_digests(strict)?;
    validate_session_identity(strict)?;
    validate_delivery_identity(strict)?;
    validate_planning_documents(strict)?;
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

fn validate_digests(strict: &AgentRunSpec) -> Result<(), String> {
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
        sha_json(&serde_json::json!({
            "authority_set_id": strict.authority_set_id.as_deref(),
            "authority_documents": strict.authority_documents.as_ref(),
            "context_document": strict.context_document.as_ref(),
        }))?
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

fn validate_planning_documents(strict: &AgentRunSpec) -> Result<(), String> {
    if strict.result_contract.0 == "autopilot.delivery_result.v1" {
        if strict.authority_set_id.is_some()
            || strict.authority_documents.is_some()
            || strict.context_document.is_some()
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
    if docs.len() != 3 {
        return Err(format!(
            "agent-run expected three authority documents, got {}",
            docs.len()
        ));
    }
    for doc in docs {
        validate_doc(doc, "authority", authority_set_id)?;
    }
    let context = strict
        .context_document
        .as_ref()
        .ok_or_else(|| "agent-run missing context document".to_owned())?;
    validate_doc(context, "context/non-authority", authority_set_id)?;
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

fn launch_pi(spec: &AgentRunSpec, prompt: &str) -> Result<ChildOutput, String> {
    let tools = spec
        .allowed_tools
        .iter()
        .map(|tool| tool.0.as_str())
        .collect::<Vec<_>>()
        .join(",");
    let mut command = Command::new("pi");
    command
        .current_dir(&spec.cwd.0)
        .arg("--mode")
        .arg("json")
        .arg("--session-id")
        .arg(&spec.session_id.0)
        .arg(format!("--no-{}s", concat!("ext", "ension")))
        .arg("--no-skills")
        .arg("--no-prompt-templates")
        .arg("--no-themes")
        .arg("--no-context-files")
        .arg("--provider")
        .arg(&spec.provider)
        .arg("--model")
        .arg(&spec.model)
        .arg("--thinking")
        .arg(&spec.thinking.0)
        .arg("--tools")
        .arg(tools)
        .arg("-p")
        .arg(prompt)
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
        .map_err(|error| format!("agent-run failed to spawn pi: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "agent-run missing stdout pipe".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "agent-run missing stderr pipe".to_owned())?;
    // These historical knobs no longer cap bytes received from Pi. Pi JSON mode
    // re-emits full message objects on message_update, so total transcript bytes
    // grow with thinking depth. The knobs now cap retained diagnostic tails only;
    // the runner streams and discards nonterminal JSONL chatter as it arrives.
    let stdout_limit = env_usize(
        "AUTOPILOT_AGENT_RUN_MAX_STDOUT_BYTES",
        DEFAULT_MAX_PI_STDOUT_BYTES,
    );
    let stderr_limit = env_usize(
        "AUTOPILOT_AGENT_RUN_MAX_STDERR_BYTES",
        DEFAULT_MAX_PI_STDERR_BYTES,
    );
    let stdout_handle = spawn_stdout_reader(
        stdout,
        stdout_limit,
        spec.provider.clone(),
        spec.model.clone(),
    );
    let stderr_handle = spawn_tail_reader(stderr, stderr_limit);
    let timeout = Duration::from_millis(env_u64(
        "AUTOPILOT_AGENT_RUN_TIMEOUT_MS",
        DEFAULT_PI_TIMEOUT_MS,
    ));
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if started.elapsed() > timeout {
            timed_out = true;
            terminate_child(&mut child);
            break None;
        }
        match child
            .try_wait()
            .map_err(|error| format!("agent-run wait failed: {error}"))?
        {
            Some(status) => break Some(status),
            None => thread::sleep(Duration::from_millis(20)),
        }
    };
    let out = stdout_handle
        .join()
        .map_err(|_| "agent-run stdout reader panicked".to_owned())?;
    let err = stderr_handle
        .join()
        .map_err(|_| "agent-run stderr reader panicked".to_owned())?;
    let stdout_tail_bytes = out.tail.len();
    let stderr_tail_bytes = err.data.len();
    Ok(ChildOutput {
        assistant: out.assistant,
        stdout_error: out.error,
        stderr_error: err
            .read_error
            .map(|error| format!("agent-run stderr read failed: {error}")),
        stdout_tail: out.tail,
        stderr_tail: err.data,
        status,
        timed_out,
        diagnostics: StreamDiagnostics {
            stdout_total_bytes: out.total_bytes,
            stderr_total_bytes: err.total_bytes,
            stdout_tail_bytes,
            stderr_tail_bytes,
            stdout_tail_truncated: out.tail_truncated,
            stderr_tail_truncated: err.tail_truncated,
            stdout_lines: out.lines,
            final_event_bytes: out.final_event_bytes,
            peak_retained_stdout_bytes: out.peak_retained_bytes,
            peak_retained_stderr_bytes: err.peak_retained_bytes,
            stdout_limit,
            stderr_limit,
        },
    })
}

fn spawn_stdout_reader<R: Read + Send + 'static>(
    reader: R,
    limit: usize,
    expected_provider: String,
    expected_model: String,
) -> thread::JoinHandle<StdoutRead> {
    thread::spawn(move || {
        let mut parser = PiJsonlParser::new(expected_provider, expected_model);
        let mut tail = RetainedTail::new(limit);
        let mut reader = std::io::BufReader::new(reader);
        let mut line = Vec::new();
        let mut total_bytes = 0usize;
        let mut peak_retained_bytes = 0usize;
        let mut read_error = None;
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(n) => {
                    total_bytes = total_bytes.saturating_add(n);
                    tail.push(&line);
                    if parser.error.is_none() {
                        parser.ingest_line(&line);
                    }
                    peak_retained_bytes = peak_retained_bytes
                        .max(tail.len().saturating_add(parser.retained_result_bytes()));
                }
                Err(error) => {
                    read_error = Some(format!("agent-run stdout read failed: {error}"));
                    break;
                }
            }
        }
        if parser.error.is_none() && read_error.is_none() {
            parser.finish();
        }
        let parse_error = parser.error.clone();
        let tail_truncated = tail.truncated;
        StdoutRead {
            assistant: parser.final_text(),
            error: read_error.or(parse_error),
            tail: tail.into_vec(),
            total_bytes,
            lines: parser.lines,
            final_event_bytes: parser.final_event_bytes,
            tail_truncated,
            peak_retained_bytes,
        }
    })
}

fn spawn_tail_reader<R: Read + Send + 'static>(
    mut reader: R,
    limit: usize,
) -> thread::JoinHandle<TailRead> {
    thread::spawn(move || {
        let mut tail = RetainedTail::new(limit);
        let mut buf = [0_u8; 8192];
        let mut total_bytes = 0usize;
        let mut peak_retained_bytes = 0usize;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let tail_truncated = tail.truncated;
                    return TailRead {
                        data: tail.into_vec(),
                        read_error: None,
                        total_bytes,
                        tail_truncated,
                        peak_retained_bytes,
                    };
                }
                Ok(n) => {
                    total_bytes = total_bytes.saturating_add(n);
                    tail.push(&buf[..n]);
                    peak_retained_bytes = peak_retained_bytes.max(tail.len());
                }
                Err(error) => {
                    let tail_truncated = tail.truncated;
                    return TailRead {
                        data: tail.into_vec(),
                        read_error: Some(error.to_string()),
                        total_bytes,
                        tail_truncated,
                        peak_retained_bytes,
                    };
                }
            }
        }
    })
}

struct RetainedTail {
    data: Vec<u8>,
    limit: usize,
    truncated: bool,
}

impl RetainedTail {
    fn new(limit: usize) -> Self {
        Self {
            data: Vec::new(),
            limit,
            truncated: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        if self.limit == 0 {
            self.truncated |= !bytes.is_empty();
            return;
        }
        if bytes.len() >= self.limit {
            self.data.clear();
            self.data
                .extend_from_slice(&bytes[bytes.len().saturating_sub(self.limit)..]);
            self.truncated = true;
            return;
        }
        let overflow = self
            .data
            .len()
            .saturating_add(bytes.len())
            .saturating_sub(self.limit);
        if overflow > 0 {
            self.data.drain(..overflow);
            self.truncated = true;
        }
        self.data.extend_from_slice(bytes);
    }

    fn len(&self) -> usize {
        self.data.len()
    }

    fn into_vec(self) -> Vec<u8> {
        self.data
    }
}

fn terminate_child(child: &mut std::process::Child) {
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
            .status();
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

#[derive(Debug, Clone, Eq, PartialEq)]
struct AssistantRecord {
    text: String,
    provider: String,
    model: String,
    stop_reason: String,
}

#[derive(Deserialize)]
struct EventKind {
    #[serde(rename = "type")]
    kind: Option<String>,
}

struct PiJsonlParser {
    expected_provider: String,
    expected_model: String,
    final_record: Option<AssistantRecord>,
    assistant_count: usize,
    tool_after_terminal: bool,
    saw_agent_end: bool,
    lines: usize,
    final_event_bytes: usize,
    error: Option<String>,
}

impl PiJsonlParser {
    fn new(expected_provider: String, expected_model: String) -> Self {
        Self {
            expected_provider,
            expected_model,
            final_record: None,
            assistant_count: 0,
            tool_after_terminal: false,
            saw_agent_end: false,
            lines: 0,
            final_event_bytes: 0,
            error: None,
        }
    }

    fn ingest_line(&mut self, line: &[u8]) {
        if self.error.is_some() {
            return;
        }
        self.lines = self.lines.saturating_add(1);
        let line = trim_jsonl_newline(line);
        let Ok(text) = std::str::from_utf8(line) else {
            self.error = Some(format!(
                "agent-run pi stdout was not UTF-8 at line {}",
                self.lines
            ));
            return;
        };
        if text.trim().is_empty() {
            return;
        }
        let kind = match serde_json::from_str::<EventKind>(text) {
            Ok(kind) => kind.kind,
            Err(error) => {
                self.error = Some(format!(
                    "agent-run malformed Pi JSONL line {}: {error}",
                    self.lines
                ));
                return;
            }
        };
        if self.saw_agent_end {
            if kind.as_deref() == Some("agent_settled") {
                return;
            }
            self.error = Some(format!(
                "agent-run Pi JSONL contained events after agent_end at line {}",
                self.lines
            ));
            return;
        }
        if kind.as_deref().is_some_and(|kind| kind.contains("tool")) {
            if self.final_record.is_some() {
                self.tool_after_terminal = true;
            }
            return;
        }
        match kind.as_deref() {
            Some("final" | "message_end" | "assistant" | "turn_end" | "agent_end") => {}
            _ => return,
        }
        let value: Value = match serde_json::from_str(text) {
            Ok(value) => value,
            Err(error) => {
                self.error = Some(format!(
                    "agent-run malformed Pi JSONL line {}: {error}",
                    self.lines
                ));
                return;
            }
        };
        self.ingest_value(&value, text.len());
    }

    fn ingest_value(&mut self, value: &Value, line_bytes: usize) {
        match assistant_event(value) {
            Ok(Some(record)) => {
                if record.stop_reason == "tooluse" {
                    return;
                }
                if let Err(error) = validate_terminal_assistant(
                    &record,
                    &self.expected_provider,
                    &self.expected_model,
                ) {
                    self.error = Some(error);
                    return;
                }
                if self.final_record.as_ref() == Some(&record) {
                    return;
                }
                self.assistant_count = self.assistant_count.saturating_add(1);
                self.final_record = Some(record);
                return;
            }
            Ok(None) => {}
            Err(error) => {
                self.error = Some(error);
                return;
            }
        }
        match agent_end_record(value) {
            Ok(Some(record)) => {
                self.final_event_bytes = line_bytes;
                if let Err(error) = validate_terminal_assistant(
                    &record,
                    &self.expected_provider,
                    &self.expected_model,
                ) {
                    self.error = Some(error);
                    return;
                }
                if let Some(existing) = &self.final_record {
                    if existing != &record {
                        self.error = Some(
                            "agent-run Pi agent_end terminal assistant drifted from message_end"
                                .to_owned(),
                        );
                        return;
                    }
                } else {
                    self.assistant_count = self.assistant_count.saturating_add(1);
                    self.final_record = Some(record);
                }
                self.saw_agent_end = true;
            }
            Ok(None) => {}
            Err(error) => self.error = Some(error),
        }
    }

    fn finish(&mut self) {
        if self.error.is_some() {
            return;
        }
        if !self.saw_agent_end {
            self.error = Some("agent-run Pi JSONL lacked agent_end".to_owned());
            return;
        }
        if self.tool_after_terminal {
            self.error = Some(
                "agent-run Pi JSONL had tool activity after terminal assistant result".to_owned(),
            );
            return;
        }
        match (&self.final_record, self.assistant_count) {
            (Some(record), 1) if !record.text.trim().is_empty() => {}
            (_, 0) => {
                self.error =
                    Some("agent-run Pi JSONL contained no final assistant result".to_owned())
            }
            (_, count) => {
                self.error = Some(format!(
                    "agent-run Pi JSONL contained {count} terminal assistant results; expected exactly one"
                ));
            }
        }
    }

    fn final_text(&self) -> Option<String> {
        self.final_record.as_ref().map(|record| record.text.clone())
    }

    fn retained_result_bytes(&self) -> usize {
        self.final_record
            .as_ref()
            .map(|record| record.text.len())
            .unwrap_or(0)
            .saturating_add(self.final_event_bytes)
    }
}

fn trim_jsonl_newline(mut line: &[u8]) -> &[u8] {
    if line.ends_with(b"\n") {
        line = &line[..line.len() - 1];
    }
    if line.ends_with(b"\r") {
        line = &line[..line.len() - 1];
    }
    line
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

fn agent_end_record(value: &Value) -> Result<Option<AssistantRecord>, String> {
    if value.get("type").and_then(Value::as_str) != Some("agent_end") {
        return Ok(None);
    }
    if value.get("willRetry").and_then(Value::as_bool) == Some(true) {
        return Err("agent-run Pi agent_end announced retry".to_owned());
    }
    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "agent-run agent_end missing messages".to_owned())?;
    for message in messages.iter().rev() {
        if message.get("role").and_then(Value::as_str) == Some("assistant") {
            return assistant_from_message(message)
                .map(Some)
                .ok_or_else(|| "agent-run agent_end terminal assistant was malformed".to_owned());
        }
    }
    Err("agent-run agent_end missing assistant message".to_owned())
}

fn assistant_event(value: &Value) -> Result<Option<AssistantRecord>, String> {
    let object = match value.as_object() {
        Some(object) => object,
        None => return Ok(None),
    };
    match object.get("type").and_then(Value::as_str) {
        Some("final") => {
            return Ok(Some(AssistantRecord {
                text: string_field(value, "content")
                    .or_else(|| string_field(value, "text"))
                    .ok_or_else(|| "agent-run final event missing content".to_owned())?,
                provider: string_field(value, "provider")
                    .ok_or_else(|| "agent-run final event missing provider".to_owned())?,
                model: string_field(value, "model")
                    .ok_or_else(|| "agent-run final event missing model".to_owned())?,
                stop_reason: lower_string(value, "stopReason")
                    .or_else(|| lower_string(value, "stop_reason"))
                    .unwrap_or_else(|| "stop".to_owned()),
            }));
        }
        Some("message_end") | Some("assistant") => {}
        Some("turn_end") => {
            let message = object
                .get("message")
                .ok_or_else(|| "agent-run turn_end missing message".to_owned())?;
            return Ok(assistant_from_message(message));
        }
        _ => return Ok(None),
    }
    let message = object.get("message").unwrap_or(value);
    Ok(assistant_from_message(message))
}

fn assistant_from_message(message: &Value) -> Option<AssistantRecord> {
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    Some(AssistantRecord {
        text: content_text(message)?,
        provider: string_field(message, "provider")?,
        model: string_field(message, "model")?,
        stop_reason: lower_string(message, "stopReason")
            .or_else(|| lower_string(message, "stop_reason"))?,
    })
}

fn content_text(value: &Value) -> Option<String> {
    if let Some(text) = string_field(value, "content") {
        return Some(text);
    }
    if let Some(text) = string_field(value, "text") {
        return Some(text);
    }
    let content = value.get("content")?.as_array()?;
    let mut out = String::new();
    for item in content {
        if item.get("type").and_then(Value::as_str) == Some("text")
            && let Some(text) = item.get("text").and_then(Value::as_str)
        {
            out.push_str(text);
        }
    }
    (!out.is_empty()).then_some(out)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_owned)
}

fn lower_string(value: &Value, key: &str) -> Option<String> {
    string_field(value, key).map(|text| text.to_ascii_lowercase())
}

fn error_with_optional_artifact(
    spec: &AgentRunSpec,
    output: &ChildOutput,
    limit_name: &str,
    detail: &str,
) -> String {
    if output.diagnostics.stdout_tail_truncated || output.diagnostics.stderr_tail_truncated {
        transient_with_artifact(
            spec,
            output,
            limit_name,
            "retained diagnostic tail wrapped",
            detail,
        )
    } else {
        detail.to_owned()
    }
}

fn transient_with_artifact(
    spec: &AgentRunSpec,
    output: &ChildOutput,
    limit_name: &str,
    reason: &str,
    detail: &str,
) -> String {
    let artifact = write_diagnostic_artifact(spec, output, reason)
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("artifact-write-failed:{error}"));
    let failure = Failure::Transient {
        retry: RetryPolicy::Backoff,
    };
    format!(
        "agent-run transient failure taxonomy=D77 variant={failure:?} assignment={} limit={} artifact={artifact}: {detail}",
        spec.assignment_id.0, limit_name
    )
}

fn write_diagnostic_artifact(
    spec: &AgentRunSpec,
    output: &ChildOutput,
    reason: &str,
) -> Result<PathBuf, String> {
    let root = Path::new(&spec.cwd.0).join(".pi/autopilot/runner/diagnostics");
    fs::create_dir_all(&root)
        .map_err(|error| format!("agent-run diagnostic mkdir failed {:?}: {error}", root))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let path = root.join(format!(
        "{}-{nanos}-pi-stream-diagnostic.json",
        spec.assignment_id.0
    ));
    let artifact = serde_json::json!({
        "schema": "autopilot.agent_run_stream_diagnostic.v1",
        "assignment_id": spec.assignment_id.0,
        "reason": reason,
        "diagnostics": diagnostics_json(&output.diagnostics),
        "stdout_tail_utf8_lossy": String::from_utf8_lossy(&output.stdout_tail).to_string(),
        "stderr_tail_utf8_lossy": String::from_utf8_lossy(&output.stderr_tail).to_string(),
    });
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("agent-run diagnostic create failed {:?}: {error}", path))?;
    file.write_all(
        &serde_json::to_vec_pretty(&artifact)
            .map_err(|error| format!("agent-run diagnostic serialize failed: {error}"))?,
    )
    .map_err(|error| format!("agent-run diagnostic write failed {:?}: {error}", path))?;
    file.write_all(b"\n")
        .map_err(|error| format!("agent-run diagnostic newline failed {:?}: {error}", path))?;
    file.sync_all()
        .map_err(|error| format!("agent-run diagnostic fsync failed {:?}: {error}", path))?;
    Ok(path)
}

fn write_stats_if_requested(output: &ChildOutput) -> Result<(), String> {
    let Some(path) = std::env::var_os("AUTOPILOT_AGENT_RUN_STATS_PATH") else {
        return Ok(());
    };
    let path = PathBuf::from(path);
    let stats = diagnostics_json(&output.diagnostics);
    fs::write(
        &path,
        serde_json::to_vec_pretty(&stats)
            .map_err(|error| format!("agent-run stats serialize failed: {error}"))?,
    )
    .map_err(|error| format!("agent-run stats write failed {:?}: {error}", path))
}

fn diagnostics_json(diagnostics: &StreamDiagnostics) -> Value {
    serde_json::json!({
        "stdout_total_bytes": diagnostics.stdout_total_bytes,
        "stderr_total_bytes": diagnostics.stderr_total_bytes,
        "stdout_tail_bytes": diagnostics.stdout_tail_bytes,
        "stderr_tail_bytes": diagnostics.stderr_tail_bytes,
        "stdout_tail_truncated": diagnostics.stdout_tail_truncated,
        "stderr_tail_truncated": diagnostics.stderr_tail_truncated,
        "stdout_lines": diagnostics.stdout_lines,
        "final_event_bytes": diagnostics.final_event_bytes,
        "peak_retained_stdout_bytes": diagnostics.peak_retained_stdout_bytes,
        "peak_retained_stderr_bytes": diagnostics.peak_retained_stderr_bytes,
        "stdout_retention_limit": diagnostics.stdout_limit,
        "stderr_retention_limit": diagnostics.stderr_limit,
    })
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
        spec.assignment_id.0, MAX_VALUE_ATTEMPTS, rejection.field, rejection.expected, rejection.got
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
            value_rejection("carrier", "existing autopilot.delivery_result.v1 JSON object", format!("invalid JSON: {error}"))
        })?;
        validate_delivery_carrier(spec, &carrier)?;
        bind_delivery_carrier(spec_path, spec_digest, spec, &mut carrier)?;
        return Ok(());
    }
    let value: Value = serde_json::from_str(text).map_err(|error| {
        value_rejection("carrier", "existing autopilot.planning_carrier.v1 JSON object", format!("invalid JSON: {error}"))
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
            value_rejection("carrier", "autopilot.delivery_result.v1 JSON object", format!("invalid JSON: {error}"))
        })?;
        validate_delivery_carrier(spec, &carrier)?;
        bind_delivery_carrier(spec_path, spec_digest, spec, &mut carrier)?;
        write_json_new(&spec.carrier_path.0, &carrier)
            .map_err(|error| value_rejection("carrier_path", "create-once writable carrier path", error))
    } else {
        crate::runner::validate_child_boundary(&spec.boundary_id.0, assistant).map_err(|error| {
            value_rejection("raw_output", format!("{} admitted value", error.boundary_id()), error.actual().to_owned())
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
        write_json_new(&spec.carrier_path.0, &carrier)
            .map_err(|error| value_rejection("carrier_path", "create-once writable carrier path", error))
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
        ("result_contract_digest", spec.result_contract_digest.0.clone()),
        ("settings_digest", spec.settings_digest.0.clone()),
        ("context_digest", spec.context_digest.0.clone()),
        ("skills_digest", spec.skills_digest.0.clone()),
        ("subscription_digest", spec.subscription_digest.0.clone()),
        ("spec_digest", spec_digest.to_owned()),
        ("spec_path", super::path_to_string(spec_path).map_err(|error| {
            value_rejection("spec_path", "absolute runner spec path", error.to_string())
        })?),
        ("carrier_path", spec.carrier_path.0.clone()),
    ] {
        let got = if field == "run_revision" {
            value.get(field).and_then(Value::as_u64).map(|v| v.to_string())
        } else {
            value.get(field).and_then(Value::as_str).map(str::to_owned)
        };
        if got.as_deref() != Some(expected.as_str()) {
            return Err(value_rejection(field, expected, got.unwrap_or_else(|| "missing-or-wrong-type".to_owned())));
        }
    }
    let raw = value
        .get("raw_output")
        .and_then(Value::as_str)
        .ok_or_else(|| value_rejection("raw_output", "string", "missing-or-wrong-type"))?;
    crate::runner::validate_child_boundary(&spec.boundary_id.0, raw).map_err(|error| {
        value_rejection("raw_output", format!("{} admitted value", error.boundary_id()), error.actual().to_owned())
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
        carrier.assignment_id.0, carrier.role_id.0, carrier.mode.0, carrier.run_revision,
        carrier.lane_id.0, carrier.attempt, carrier.base_commit.0, carrier.worktree.0
    )
}

fn validate_delivery_carrier(spec: &AgentRunSpec, carrier: &DeliveryResult) -> Result<(), ValueRejection> {
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
        return Err(value_rejection("carrier.identity", "assignment_id/role_id/mode/run_revision/lane_id/attempt/base_commit/worktree matching spec", delivery_identity_got(carrier)));
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
        return Err(value_rejection("carrier.binding", "optional binding fields absent or matching runner spec", "binding drift"));
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

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
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
