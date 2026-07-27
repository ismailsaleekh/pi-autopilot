use kernel::failure::{Failure, OperatorDecision};

const INSTALL: &str =
    "Missing pi-background-tasks. Install from https://pi.dev/packages, then reload/restart Pi.";

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum BgCapability {
    Run,
    Status,
    Logs,
    Stop,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct BgCapabilities {
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
}

impl BgCapabilities {
    pub const fn complete() -> Self {
        Self {
            run: true,
            run_is_agent: true,
            run_completion_trigger: true,
            status: true,
            logs: true,
            logs_bounded: true,
            stop: true,
        }
    }
}

pub fn require_before_mutation<T>(
    caps: &BgCapabilities,
    mutate: impl FnOnce() -> T,
) -> Result<T, BgPrereqError> {
    match unavailable(caps) {
        Some(capability) => Err(BgPrereqError {
            capability,
            instruction: INSTALL,
            failure: Failure::Paused {
                needs: OperatorDecision::SupplyCapability,
            },
        }),
        None => Ok(mutate()),
    }
}

fn unavailable(caps: &BgCapabilities) -> Option<BgCapability> {
    if !caps.run || !caps.run_is_agent || !caps.run_completion_trigger {
        Some(BgCapability::Run)
    } else if !caps.status {
        Some(BgCapability::Status)
    } else if !caps.logs || !caps.logs_bounded {
        Some(BgCapability::Logs)
    } else if !caps.stop {
        Some(BgCapability::Stop)
    } else {
        None
    }
}
