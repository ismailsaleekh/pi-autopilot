use kernel::failure::Failure;
use kernel::generated::{Id, Ref, Sha};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub struct AssignmentState<L = Id, B = Sha, C = Sha> {
    pub assignment_id: Id,
    pub lane_id: L,
    pub run_revision: u64,
    pub base_commit: B,
    pub current_commit: C,
    pub dirty_paths: Vec<String>,
    pub completed: Vec<Id>,
    pub remaining: Vec<Id>,
    pub next_action: String,
    pub session_ref: Ref,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckpointInput {
    pub assignment_id: Id,
    pub run_revision: u64,
    pub session_ref: Ref,
    pub identity: AssignmentIdentity,
    pub handoff: AgentHandoff,
}

impl CheckpointInput {
    pub fn planning(
        assignment_id: Id,
        run_revision: u64,
        session_ref: Ref,
        handoff: AgentHandoff,
    ) -> Self {
        Self {
            assignment_id,
            run_revision,
            session_ref,
            identity: AssignmentIdentity::Planning,
            handoff,
        }
    }

    pub fn execution(
        assignment_id: Id,
        run_revision: u64,
        session_ref: Ref,
        lane_id: Id,
        base_commit: Sha,
        current_commit: Sha,
        preservation: PreservationEvidence,
        handoff: AgentHandoff,
    ) -> Self {
        Self {
            assignment_id,
            run_revision,
            session_ref,
            identity: AssignmentIdentity::Execution(ExecutionIdentity {
                lane_id,
                base_commit,
                current_commit,
                preservation,
            }),
            handoff,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentIdentity {
    Planning,
    Execution(ExecutionIdentity),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecutionIdentity {
    pub lane_id: Id,
    pub base_commit: Sha,
    pub current_commit: Sha,
    pub preservation: PreservationEvidence,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreservationEvidence {
    CleanCurrentCommit {
        commit: Sha,
    },
    VerifiedPreservationCommit {
        commit: Sha,
        dirty_paths: Vec<String>,
    },
    NoPreservationCommit {
        dirty_paths: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ContextPercent(f64);

impl ContextPercent {
    pub fn new(percent: f64) -> Result<Self, ContextBudgetError> {
        if !percent.is_finite() {
            return Err(ContextBudgetError::NonFinite);
        }
        if percent < 0.0 {
            return Err(ContextBudgetError::Negative { percent });
        }
        if percent > 100.0 {
            return Err(ContextBudgetError::AboveMaximum { percent });
        }
        Ok(Self(percent))
    }

    pub fn as_f64(self) -> f64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextBudget {
    Known(ContextPercent),
    Unknown,
}

impl ContextBudget {
    pub fn known(percent: f64) -> Result<Self, ContextBudgetError> {
        Ok(Self::Known(ContextPercent::new(percent)?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ContextBudgetError {
    NonFinite,
    Negative { percent: f64 },
    AboveMaximum { percent: f64 },
}

pub trait IntoContextBudget {
    fn into_context_budget(self) -> Result<ContextBudget, ContextBudgetError>;
}

impl IntoContextBudget for ContextBudget {
    fn into_context_budget(self) -> Result<ContextBudget, ContextBudgetError> {
        Ok(self)
    }
}

impl IntoContextBudget for ContextPercent {
    fn into_context_budget(self) -> Result<ContextBudget, ContextBudgetError> {
        Ok(ContextBudget::Known(self))
    }
}

impl IntoContextBudget for f64 {
    fn into_context_budget(self) -> Result<ContextBudget, ContextBudgetError> {
        ContextBudget::known(self)
    }
}

impl IntoContextBudget for i32 {
    fn into_context_budget(self) -> Result<ContextBudget, ContextBudgetError> {
        ContextBudget::known(f64::from(self))
    }
}

impl IntoContextBudget for u8 {
    fn into_context_budget(self) -> Result<ContextBudget, ContextBudgetError> {
        ContextBudget::known(f64::from(self))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckpointRecord {
    pub assignment_id: Id,
    pub context_percent: ContextPercent,
    pub identity: AssignmentIdentity,
    pub resume_overlay: ResumeOverlay,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResumeOverlay {
    pub assignment_id: Id,
    pub session_ref: Ref,
    pub run_revision: u64,
    pub handoff: AgentHandoff,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentHandoff {
    pub schema: HandoffSchema,
    pub completed: Vec<String>,
    pub remaining: Vec<String>,
    pub critical_state: BTreeMap<String, Value>,
    pub next_action: String,
    #[serde(flatten)]
    pub extras: BTreeMap<String, Value>,
}

impl AgentHandoff {
    pub fn new(
        completed: Vec<String>,
        remaining: Vec<String>,
        critical_state: BTreeMap<String, Value>,
        next_action: String,
    ) -> Self {
        Self {
            schema: HandoffSchema::V1,
            completed,
            remaining,
            critical_state,
            next_action,
            extras: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HandoffSchema {
    #[serde(rename = "autopilot.agent-handoff.v1")]
    V1,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ContextDecision {
    Continue,
    SoftWarning,
    CheckpointAndSettle(CheckpointRecord),
    Unknown(UnknownBudget),
}

impl ContextDecision {
    pub fn apply_action(
        &self,
        action: ContextAction,
    ) -> Result<ContextActionOutcome, ContextActionError> {
        match (self, action) {
            (Self::Continue | Self::SoftWarning, ContextAction::StartWork)
            | (Self::Continue | Self::SoftWarning, ContextAction::ClaimTerminalSuccess) => {
                Ok(ContextActionOutcome::Allowed)
            }
            (Self::CheckpointAndSettle(_), ContextAction::StartWork)
            | (Self::CheckpointAndSettle(_), ContextAction::ClaimTerminalSuccess) => {
                Err(ContextActionError::CheckpointRequired)
            }
            (Self::Unknown(_), ContextAction::StartWork) => {
                Err(ContextActionError::UnknownBlocksWork)
            }
            (Self::Unknown(_), ContextAction::ClaimTerminalSuccess) => {
                Err(ContextActionError::UnknownBlocksTerminalSuccess)
            }
            (Self::Unknown(_), ContextAction::InjectRetainedHandoff(overlay)) => {
                Ok(ContextActionOutcome::ResumeOnly { overlay })
            }
            (
                Self::Continue | Self::SoftWarning | Self::CheckpointAndSettle(_),
                ContextAction::InjectRetainedHandoff(_),
            ) => Err(ContextActionError::RecoveryOnlyWhenBudgetUnknown),
        }
    }

    pub fn allows_new_work(&self) -> bool {
        self.apply_action(ContextAction::StartWork).is_ok()
    }

    pub fn allows_terminal_success(&self) -> bool {
        self.apply_action(ContextAction::ClaimTerminalSuccess)
            .is_ok()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnknownBudget;

#[derive(Debug, Clone, PartialEq)]
pub enum ContextAction {
    StartWork,
    ClaimTerminalSuccess,
    InjectRetainedHandoff(ResumeOverlay),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ContextActionOutcome {
    Allowed,
    ResumeOnly { overlay: ResumeOverlay },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextActionError {
    UnknownBlocksWork,
    UnknownBlocksTerminalSuccess,
    CheckpointRequired,
    RecoveryOnlyWhenBudgetUnknown,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CheckpointError {
    Budget(ContextBudgetError),
    Identity(IdentityError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityError {
    PlanningCarriesLane,
    PlanningCarriesBaseCommit,
    PlanningCarriesCurrentCommit,
    PlanningCarriesDirtyPaths,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CompactionOutcome {
    Resumed {
        overlay: ResumeOverlay,
    },
    Recoverable {
        checkpoint: CheckpointRecord,
        failure: Failure,
    },
}

#[derive(Debug, Default, Clone, Eq, PartialEq)]
pub struct SideEffects {
    pub validation_started: usize,
    pub integration_started: usize,
    pub replacement_spawned: usize,
}

pub trait Compactor {
    fn compact_same_session(&mut self, checkpoint: &CheckpointRecord) -> Result<(), Failure>;
}

pub trait CheckpointSource {
    fn render_checkpoint(&self, percent: ContextPercent)
    -> Result<CheckpointRecord, IdentityError>;
}

pub fn observe_context<B, S>(budget: B, state: &S) -> Result<ContextDecision, CheckpointError>
where
    B: IntoContextBudget,
    S: CheckpointSource + ?Sized,
{
    let budget = budget
        .into_context_budget()
        .map_err(CheckpointError::Budget)?;
    match budget {
        ContextBudget::Unknown => Ok(ContextDecision::Unknown(UnknownBudget)),
        ContextBudget::Known(percent) if percent.as_f64() >= 85.0 => state
            .render_checkpoint(percent)
            .map(ContextDecision::CheckpointAndSettle)
            .map_err(CheckpointError::Identity),
        ContextBudget::Known(percent) if percent.as_f64() >= 75.0 => {
            Ok(ContextDecision::SoftWarning)
        }
        ContextBudget::Known(_) => Ok(ContextDecision::Continue),
    }
}

pub fn compact_and_resume(
    checkpoint: CheckpointRecord,
    compactor: &mut dyn Compactor,
    _effects: &mut SideEffects,
) -> CompactionOutcome {
    match compactor.compact_same_session(&checkpoint) {
        Ok(()) => CompactionOutcome::Resumed {
            overlay: checkpoint.resume_overlay,
        },
        Err(failure) => CompactionOutcome::Recoverable {
            checkpoint,
            failure,
        },
    }
}

impl CheckpointSource for CheckpointInput {
    fn render_checkpoint(
        &self,
        percent: ContextPercent,
    ) -> Result<CheckpointRecord, IdentityError> {
        Ok(CheckpointRecord {
            assignment_id: self.assignment_id.clone(),
            context_percent: percent,
            identity: self.identity.clone(),
            resume_overlay: ResumeOverlay {
                assignment_id: self.assignment_id.clone(),
                session_ref: self.session_ref.clone(),
                run_revision: self.run_revision,
                handoff: self.handoff.clone(),
            },
        })
    }
}

impl CheckpointSource for AssignmentState<Id, Sha, Sha> {
    fn render_checkpoint(
        &self,
        percent: ContextPercent,
    ) -> Result<CheckpointRecord, IdentityError> {
        let preservation = if self.dirty_paths.is_empty() {
            PreservationEvidence::CleanCurrentCommit {
                commit: self.current_commit.clone(),
            }
        } else {
            PreservationEvidence::NoPreservationCommit {
                dirty_paths: self.dirty_paths.clone(),
            }
        };
        let input = CheckpointInput::execution(
            self.assignment_id.clone(),
            self.run_revision,
            self.session_ref.clone(),
            self.lane_id.clone(),
            self.base_commit.clone(),
            self.current_commit.clone(),
            preservation,
            AgentHandoff::new(
                ids(&self.completed),
                ids(&self.remaining),
                BTreeMap::new(),
                self.next_action.clone(),
            ),
        );
        input.render_checkpoint(percent)
    }
}

impl CheckpointSource for AssignmentState<Option<Id>, Option<Sha>, Option<Sha>> {
    fn render_checkpoint(
        &self,
        percent: ContextPercent,
    ) -> Result<CheckpointRecord, IdentityError> {
        if self.lane_id.is_some() {
            return Err(IdentityError::PlanningCarriesLane);
        }
        if self.base_commit.is_some() {
            return Err(IdentityError::PlanningCarriesBaseCommit);
        }
        if self.current_commit.is_some() {
            return Err(IdentityError::PlanningCarriesCurrentCommit);
        }
        if !self.dirty_paths.is_empty() {
            return Err(IdentityError::PlanningCarriesDirtyPaths);
        }
        let input = CheckpointInput::planning(
            self.assignment_id.clone(),
            self.run_revision,
            self.session_ref.clone(),
            AgentHandoff::new(
                ids(&self.completed),
                ids(&self.remaining),
                BTreeMap::new(),
                self.next_action.clone(),
            ),
        );
        input.render_checkpoint(percent)
    }
}

fn ids(values: &[Id]) -> Vec<String> {
    values.iter().map(|value| value.0.clone()).collect()
}
