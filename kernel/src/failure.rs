#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Failure {
    Transient { retry: RetryPolicy },
    Recoverable { route: RecoveryRoute },
    Paused { needs: OperatorDecision },
    Unsafe { boundary: HardBoundary },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetryPolicy {
    Immediate,
    Backoff,
    AfterRestart,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryRoute {
    Tier1,
    Tier2,
    Tier3,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperatorDecision {
    SupplyCapability,
    ChooseAfterExhaustion,
    ReissueDecision,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HardBoundary {
    OutOfScopeWrite,
    AgentVersionMutation,
    RemoteOrDestructiveNetwork,
    SecretMaterialAccess,
    UnissuedBackgroundLaunch,
    MeteredFrontierRoute,
    UnsafeCleanup,
    EvidenceThreateningMutation,
}

impl HardBoundary {
    pub const ALL: [Self; 8] = [
        Self::OutOfScopeWrite,
        Self::AgentVersionMutation,
        Self::RemoteOrDestructiveNetwork,
        Self::SecretMaterialAccess,
        Self::UnissuedBackgroundLaunch,
        Self::MeteredFrontierRoute,
        Self::UnsafeCleanup,
        Self::EvidenceThreateningMutation,
    ];
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Supervision {
    pub process: ProcessDisposition,
    pub operation: OperationDisposition,
    pub evidence: EvidenceDisposition,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessDisposition {
    Continue,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationDisposition {
    Continue,
    Halt(HardBoundary),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceDisposition {
    Preserve,
}

impl Failure {
    pub fn supervision(self) -> Supervision {
        match self {
            Self::Transient { retry } => {
                let _ = retry;
                Supervision::continue_with_evidence()
            }
            Self::Recoverable { route } => {
                let _ = route;
                Supervision::continue_with_evidence()
            }
            Self::Paused { needs } => {
                let _ = needs;
                Supervision::continue_with_evidence()
            }
            Self::Unsafe { boundary } => Supervision {
                process: ProcessDisposition::Continue,
                operation: OperationDisposition::Halt(boundary),
                evidence: EvidenceDisposition::Preserve,
            },
        }
    }
}

impl From<HardBoundary> for Failure {
    fn from(boundary: HardBoundary) -> Self {
        Self::Unsafe { boundary }
    }
}

impl Supervision {
    const fn continue_with_evidence() -> Self {
        Self {
            process: ProcessDisposition::Continue,
            operation: OperationDisposition::Continue,
            evidence: EvidenceDisposition::Preserve,
        }
    }
}
