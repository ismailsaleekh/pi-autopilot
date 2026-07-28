use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

use kernel::generated::{AgentRunSpec, DeliveryResult, TaskDocument};
use serde_json::Value;
use sha2::{Digest as ShaDigest, Sha256};

const DEFAULT_MAX_PI_STDOUT_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_PI_STDERR_BYTES: usize = 256 * 1024;
const DEFAULT_PI_TIMEOUT_MS: u64 = 60 * 60 * 1000;

struct ChildOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: std::process::ExitStatus,
}

struct StreamRead {
    data: Vec<u8>,
    read_error: Option<String>,
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
    let output = launch_pi(&spec, &prompt)?;
    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("agent-run pi stdout was not UTF-8: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "agent-run pi exited nonzero status={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let assistant = parse_pi_jsonl(&stdout, &spec.provider, &spec.model)?;
    write_carrier(&spec_path, &spec_digest, &spec, &assistant)
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
    ] {
        validate_id(label, value)?;
    }
    validate_route_and_role(strict)?;
    validate_paths(strict, spec_path)?;
    validate_digests(strict)?;
    validate_delivery_identity(strict)?;
    validate_planning_documents(strict)?;
    ensure_carrier_clear(Path::new(&strict.carrier_path.0))?;
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
        .arg("--no-session")
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
    let stdout_limit = env_usize(
        "AUTOPILOT_AGENT_RUN_MAX_STDOUT_BYTES",
        DEFAULT_MAX_PI_STDOUT_BYTES,
    );
    let stderr_limit = env_usize(
        "AUTOPILOT_AGENT_RUN_MAX_STDERR_BYTES",
        DEFAULT_MAX_PI_STDERR_BYTES,
    );
    let stdout_over = Arc::new(AtomicBool::new(false));
    let stderr_over = Arc::new(AtomicBool::new(false));
    let stdout_handle = spawn_reader(stdout, stdout_limit, Arc::clone(&stdout_over));
    let stderr_handle = spawn_reader(stderr, stderr_limit, Arc::clone(&stderr_over));
    let timeout = Duration::from_millis(env_u64(
        "AUTOPILOT_AGENT_RUN_TIMEOUT_MS",
        DEFAULT_PI_TIMEOUT_MS,
    ));
    let started = Instant::now();
    let status = loop {
        if stdout_over.load(Ordering::SeqCst) {
            terminate_child(&mut child);
            return Err(format!("agent-run pi stdout exceeded {stdout_limit} bytes"));
        }
        if stderr_over.load(Ordering::SeqCst) {
            terminate_child(&mut child);
            return Err(format!("agent-run pi stderr exceeded {stderr_limit} bytes"));
        }
        if started.elapsed() > timeout {
            terminate_child(&mut child);
            return Err(format!(
                "agent-run pi wall timeout exceeded {} ms",
                timeout.as_millis()
            ));
        }
        match child
            .try_wait()
            .map_err(|error| format!("agent-run wait failed: {error}"))?
        {
            Some(status) => break status,
            None => thread::sleep(Duration::from_millis(20)),
        }
    };
    let out = stdout_handle
        .join()
        .map_err(|_| "agent-run stdout reader panicked".to_owned())?;
    let err = stderr_handle
        .join()
        .map_err(|_| "agent-run stderr reader panicked".to_owned())?;
    if let Some(error) = out.read_error {
        return Err(format!("agent-run stdout read failed: {error}"));
    }
    if let Some(error) = err.read_error {
        return Err(format!("agent-run stderr read failed: {error}"));
    }
    Ok(ChildOutput {
        stdout: out.data,
        stderr: err.data,
        status,
    })
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    limit: usize,
    over: Arc<AtomicBool>,
) -> thread::JoinHandle<StreamRead> {
    thread::spawn(move || {
        let mut data = Vec::new();
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    return StreamRead {
                        data,
                        read_error: None,
                    };
                }
                Ok(n) => {
                    if data.len().saturating_add(n) > limit {
                        over.store(true, Ordering::SeqCst);
                        let remaining = limit.saturating_sub(data.len());
                        if remaining > 0 {
                            data.extend_from_slice(&buf[..remaining]);
                        }
                    } else {
                        data.extend_from_slice(&buf[..n]);
                    }
                }
                Err(error) => {
                    return StreamRead {
                        data,
                        read_error: Some(error.to_string()),
                    };
                }
            }
        }
    })
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

fn parse_pi_jsonl(
    output: &str,
    expected_provider: &str,
    expected_model: &str,
) -> Result<String, String> {
    let mut final_record: Option<AssistantRecord> = None;
    let mut assistant_count = 0usize;
    let mut tool_after_terminal = false;
    let mut saw_agent_end = false;
    for (index, line) in output.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line)
            .map_err(|error| format!("agent-run malformed Pi JSONL line {}: {error}", index + 1))?;
        if saw_agent_end {
            if value.get("type").and_then(Value::as_str) == Some("agent_settled") {
                continue;
            }
            return Err(format!(
                "agent-run Pi JSONL contained events after agent_end at line {}",
                index + 1
            ));
        }
        if is_tool_event(&value) {
            if final_record.is_some() {
                tool_after_terminal = true;
            }
            continue;
        }
        if let Some(record) = assistant_event(&value)? {
            if record.stop_reason == "tooluse" {
                continue;
            }
            validate_terminal_assistant(&record, expected_provider, expected_model)?;
            if final_record.as_ref() == Some(&record) {
                continue;
            }
            assistant_count = assistant_count.saturating_add(1);
            final_record = Some(record);
            continue;
        }
        if let Some(record) = agent_end_record(&value)? {
            validate_terminal_assistant(&record, expected_provider, expected_model)?;
            if let Some(existing) = &final_record {
                if existing != &record {
                    return Err(
                        "agent-run Pi agent_end terminal assistant drifted from message_end"
                            .to_owned(),
                    );
                }
            } else {
                assistant_count = assistant_count.saturating_add(1);
                final_record = Some(record);
            }
            saw_agent_end = true;
        }
    }
    if !saw_agent_end {
        return Err("agent-run Pi JSONL lacked agent_end".to_owned());
    }
    if tool_after_terminal {
        return Err(
            "agent-run Pi JSONL had tool activity after terminal assistant result".to_owned(),
        );
    }
    match (assistant_count, final_record) {
        (1, Some(record)) if !record.text.trim().is_empty() => Ok(record.text),
        (0, _) => Err("agent-run Pi JSONL contained no final assistant result".to_owned()),
        (count, _) => Err(format!(
            "agent-run Pi JSONL contained {count} terminal assistant results; expected exactly one"
        )),
    }
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

fn is_tool_event(value: &Value) -> bool {
    value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.contains("tool"))
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

fn write_carrier(
    spec_path: &Path,
    spec_digest: &str,
    spec: &AgentRunSpec,
    assistant: &str,
) -> Result<(), String> {
    if spec.result_contract.0 == "autopilot.delivery_result.v1" {
        let mut carrier: DeliveryResult = serde_json::from_str(assistant)
            .map_err(|error| format!("agent-run delivery carrier JSON invalid: {error}"))?;
        validate_delivery_carrier(spec, &carrier)?;
        bind_delivery_carrier(spec_path, spec_digest, spec, &mut carrier)?;
        write_json_new(&spec.carrier_path.0, &carrier)
    } else {
        crate::runner::validate_child_boundary(&spec.boundary_id.0, assistant).map_err(
            |error| {
                format!(
                    "agent-run boundary rejection {}: {}",
                    error.boundary_id(),
                    error.actual()
                )
            },
        )?;
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
            "spec_path": super::path_to_string(spec_path).map_err(|error| error.to_string())?,
            "carrier_path": spec.carrier_path.0,
            "raw_output": assistant,
        });
        write_json_new(&spec.carrier_path.0, &carrier)
    }
}

fn bind_delivery_carrier(
    spec_path: &Path,
    spec_digest: &str,
    spec: &AgentRunSpec,
    carrier: &mut DeliveryResult,
) -> Result<(), String> {
    carrier.action_id = Some(spec.action_id.clone());
    carrier.prompt_path = Some(spec.prompt_path.clone());
    carrier.prompt_digest = Some(spec.prompt_digest.clone());
    carrier.spec_path = Some(kernel::generated::Path(
        super::path_to_string(spec_path).map_err(|error| error.to_string())?,
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

fn validate_delivery_carrier(spec: &AgentRunSpec, carrier: &DeliveryResult) -> Result<(), String> {
    let lane = spec
        .lane_id
        .as_ref()
        .ok_or_else(|| "agent-run missing lane identity".to_owned())?;
    let attempt = spec
        .attempt
        .ok_or_else(|| "agent-run missing attempt identity".to_owned())?;
    let base = spec
        .base_commit
        .as_ref()
        .ok_or_else(|| "agent-run missing base identity".to_owned())?;
    let worktree = spec
        .worktree
        .as_ref()
        .ok_or_else(|| "agent-run missing worktree identity".to_owned())?;
    if carrier.assignment_id != spec.assignment_id
        || carrier.role_id != spec.role_id
        || carrier.mode != spec.mode
        || carrier.run_revision != spec.run_revision
        || carrier.lane_id != *lane
        || carrier.attempt != attempt
        || carrier.base_commit != *base
        || carrier.worktree.0 != worktree.0
    {
        return Err("agent-run delivery carrier identity drift".to_owned());
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
        return Err("agent-run delivery carrier binding drift".to_owned());
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
