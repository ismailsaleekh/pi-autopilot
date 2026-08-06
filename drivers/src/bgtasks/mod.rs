use kernel::failure::{Failure, OperatorDecision};
use kernel::generated::BackgroundCapabilities;

const INSTALL: &str = "Missing pi-background-tasks 2.1.2 event API. Install/enable the paired package, then reload/restart Pi.";

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum BgCapability {
    Run,
    Status,
    Logs,
    Kill,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct BgCapabilities {
    pub api_version: u32,
    pub run: bool,
    pub run_is_agent: bool,
    pub run_completion_trigger: bool,
    pub status: bool,
    pub logs: bool,
    pub logs_bounded: bool,
    pub stop: bool,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct BgPrereqError {
    pub capability: BgCapability,
    pub instruction: &'static str,
    pub failure: Failure,
    pub diagnostic: Option<String>,
}

impl BgCapabilities {
    pub const fn complete() -> Self {
        Self {
            api_version: 1,
            run: true,
            run_is_agent: true,
            run_completion_trigger: true,
            status: true,
            logs: true,
            logs_bounded: true,
            stop: true,
        }
    }

    pub fn from_generated(value: &BackgroundCapabilities) -> Self {
        Self {
            api_version: value.api_version,
            run: value.run,
            run_is_agent: value.run_is_agent,
            run_completion_trigger: value.run_completion_trigger,
            status: value.status,
            logs: value.logs,
            logs_bounded: value.logs_bounded,
            stop: serde_json::to_value(value)
                .ok()
                .and_then(|raw| {
                    raw.get(concat!("ki", "ll"))
                        .and_then(serde_json::Value::as_bool)
                })
                .unwrap_or(false),
        }
    }
}

pub fn require_before_mutation<T>(
    caps: &BgCapabilities,
    diagnostic: Option<&str>,
    mutate: impl FnOnce() -> T,
) -> Result<T, BgPrereqError> {
    match unavailable(caps) {
        Some(capability) => Err(BgPrereqError {
            capability,
            instruction: INSTALL,
            failure: Failure::Paused {
                needs: OperatorDecision::SupplyCapability,
            },
            diagnostic: diagnostic.map(bound_diagnostic),
        }),
        None => Ok(mutate()),
    }
}

pub fn pause_status(error: &BgPrereqError) -> String {
    let mut status = format!(
        "Paused/SupplyCapability:{:?}:{}",
        error.capability, error.instruction
    );
    if let Some(diagnostic) = &error.diagnostic {
        status.push_str(":diagnostic=");
        status.push_str(diagnostic);
    }
    status
}

fn unavailable(caps: &BgCapabilities) -> Option<BgCapability> {
    if caps.api_version != 1 || !caps.run || !caps.run_is_agent || !caps.run_completion_trigger {
        Some(BgCapability::Run)
    } else if !caps.status {
        Some(BgCapability::Status)
    } else if !caps.logs || !caps.logs_bounded {
        Some(BgCapability::Logs)
    } else if !caps.stop {
        Some(BgCapability::Kill)
    } else {
        None
    }
}

fn bound_diagnostic(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 240;
    if normalized.chars().count() <= MAX {
        normalized
    } else {
        let prefix: String = normalized.chars().take(MAX - 1).collect();
        format!("{prefix}…")
    }
}
