use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitStatus;

use crate::generated::pi_rpc::{LAUNCH_FLAGS, LaunchFlagKind};

use super::RpcCommandKind;

pub const DEFAULT_STDERR_TAIL_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RpcSpawnConfig {
    pub cwd: PathBuf,
    pub provider: String,
    pub model: String,
    pub thinking: String,
    pub session_id: String,
    pub session_dir: PathBuf,
    pub tools: Vec<String>,
    pub runtime_addon: Option<PathBuf>,
    pub terminal_profile: Option<String>,
    pub carrier_binding: Option<String>,
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
            runtime_addon: None,
            terminal_profile: None,
            carrier_binding: None,
            pi_executable: OsString::from("pi"),
            stderr_tail_bytes: DEFAULT_STDERR_TAIL_BYTES,
            max_terminal_bytes: super::DEFAULT_MAX_TERMINAL_BYTES,
        }
    }
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
    EntryAppendedTooLarge {
        bytes: usize,
        limit: usize,
    },
    Shutdown(String),
}
impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(v) => write!(f, "rpc I/O error: {v}"),
            Self::Utf8(v) => write!(f, "rpc UTF-8 error: {v}"),
            Self::Json(v) => write!(f, "rpc JSON error: {v}"),
            Self::UnknownFrame(v) => write!(f, "unknown rpc frame: {v}"),
            Self::MalformedFrame(v) => write!(f, "malformed rpc frame: {v}"),
            Self::DuplicateRequest(v) => write!(f, "duplicate rpc request id: {v}"),
            Self::UnmatchedResponse(v) => write!(f, "unmatched rpc response id: {v}"),
            Self::MissingResponse(ids) => write!(f, "missing rpc responses: {}", ids.join(",")),
            Self::CommandMismatch {
                id,
                expected,
                actual,
            } => {
                write!(
                    f,
                    "rpc response command mismatch for {id}: expected {}, got {actual}",
                    expected.as_str()
                )
            }
            Self::ResponseError { id, command, error } => {
                write!(f, "rpc command {id}/{} failed: {error}", command.as_str())
            }
            Self::OutOfOrderEvent(v) => write!(f, "out-of-order rpc event: {v}"),
            Self::ProtocolViolation(v) => write!(f, "rpc protocol violation: {v}"),
            Self::TerminalPayloadTooLarge { bytes, limit } => {
                write!(f, "rpc terminal payload too large: {bytes} > {limit}")
            }
            Self::EntryAppendedTooLarge { bytes, limit } => {
                write!(f, "rpc entry_appended payload too large: {bytes} > {limit}")
            }
            Self::Shutdown(v) => write!(f, "rpc shutdown failed: {v}"),
        }
    }
}
impl std::error::Error for RpcError {}

pub fn launch_arguments(config: &RpcSpawnConfig) -> Vec<OsString> {
    let mut args = Vec::new();
    for row in LAUNCH_FLAGS {
        match row.kind {
            LaunchFlagKind::Bare => args.push(row.name.into()),
            LaunchFlagKind::Value => {
                args.push(row.name.into());
                args.push(value(row.value, config).expect("generated launch value row"));
            }
            LaunchFlagKind::OptionalAddon => {
                if let Some(path) = &config.runtime_addon {
                    args.push(row.name.into());
                    args.push(path.as_os_str().to_owned());
                }
            }
        }
    }
    args
}
pub(crate) fn settings_identity(with_addon: bool) -> String {
    let mut tokens = LAUNCH_FLAGS
        .iter()
        .filter(|row| with_addon || row.kind != LaunchFlagKind::OptionalAddon)
        .map(|row| row.identity_token)
        .collect::<Vec<_>>();
    if with_addon {
        tokens.push("env:AUTOPILOT_TERMINAL_PROFILE=<TerminalProfile>");
        tokens.push("env:AUTOPILOT_CARRIER_BINDING=<CarrierBinding>");
    }
    format!("agent-run-settings:{}:v3", tokens.join(","))
}
fn value(name: Option<&str>, config: &RpcSpawnConfig) -> Option<OsString> {
    Some(match name? {
        "rpc" => "rpc".into(),
        "session_id" => config.session_id.clone().into(),
        "session_dir" => config.session_dir.as_os_str().to_owned(),
        "provider" => config.provider.clone().into(),
        "model" => config.model.clone().into(),
        "thinking" => config.thinking.clone().into(),
        "tools_csv" => config.tools.join(",").into(),
        _ => return None,
    })
}
