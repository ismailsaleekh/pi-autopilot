use std::path::{Path, PathBuf};

use crate::{
    integration::{CandidateKind, CandidateRequest, CheckCommand, IntegrationError, PreparedCandidate, ReleaseIntegrator},
    vcs::GitVcs,
};

pub const FINALIZATION_KDL: &str = include_str!("../../../data/finalization.kdl");

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct TargetSyncOutcome {
    pub target_tip: String,
    pub integrated: Option<PreparedCandidate>,
}

pub struct TargetSyncer {
    source: PathBuf,
    target_ref: String,
    vcs: GitVcs,
    integrator: ReleaseIntegrator,
}

impl TargetSyncer {
    pub fn new(
        owner: impl Into<PathBuf>,
        source: impl Into<PathBuf>,
        run_main_ref: impl Into<String>,
        target_ref: impl Into<String>,
    ) -> Self {
        let owner = owner.into();
        let source = source.into();
        Self {
            vcs: GitVcs::new(owner.clone()),
            integrator: ReleaseIntegrator::new(owner, source.clone(), run_main_ref),
            source,
            target_ref: target_ref.into(),
        }
    }

    pub fn reconcile(
        &self,
        recorded_target_base: &str,
        worktree_root: &Path,
        checks: &[CheckCommand],
    ) -> Result<TargetSyncOutcome, IntegrationError> {
        let target_tip = self
            .vcs
            .read_tip(&self.source, &self.target_ref)
            .map_err(|_| IntegrationError::Git)?;
        if target_tip == recorded_target_base {
            return Ok(TargetSyncOutcome { target_tip, integrated: None });
        }
        let prepared = self.integrator.merge_and_cas(
            CandidateRequest {
                candidate_id: "target-sync".to_owned(),
                enqueue_sequence: 0,
                kind: CandidateKind::FinalTargetSync,
                candidate_tip: target_tip.clone(),
            },
            worktree_root,
            checks,
        )?;
        let after = self
            .vcs
            .read_tip(&self.source, &self.target_ref)
            .map_err(|_| IntegrationError::Git)?;
        if after != target_tip {
            return Err(IntegrationError::Git);
        }
        Ok(TargetSyncOutcome { target_tip, integrated: Some(prepared) })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BughunterTriggers {
    pub implementation_lanes: u16,
    pub risk: RiskLevel,
    pub protected_security_data_or_migration: bool,
    pub semantic_conflict_resolution: bool,
    pub operator_required: bool,
}

impl BughunterTriggers {
    pub fn required(&self) -> bool {
        self.implementation_lanes > 1
            || matches!(self.risk, RiskLevel::High | RiskLevel::Critical)
            || self.protected_security_data_or_migration
            || self.semantic_conflict_resolution
            || self.operator_required
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TipEvidence {
    pub tip: String,
    pub passed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinalGateInput {
    pub final_tip: String,
    pub every_unit_closed: bool,
    pub no_mandatory_findings: bool,
    pub no_stale_required_proof: bool,
    pub no_active_or_unknown_jobs: bool,
    pub attributable_integrated_diff: bool,
    pub final_commands: TipEvidence,
    pub full_suite: TipEvidence,
    pub final_validator: TipEvidence,
    pub bughunter: Option<TipEvidence>,
    pub triggers: BughunterTriggers,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinalCondition {
    UnitsClosed,
    MandatoryFindings,
    RequiredProofFresh,
    JobsTerminal,
    AttributableDiff,
    FinalCommands,
    FullSuite,
    FinalValidator,
    RequiredBughunter,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinalVerificationPass {
    pub tip: String,
    pub bughunter_required: bool,
}

impl FinalCondition {
    pub const ALL: [Self; 9] = [
        Self::UnitsClosed,
        Self::MandatoryFindings,
        Self::RequiredProofFresh,
        Self::JobsTerminal,
        Self::AttributableDiff,
        Self::FinalCommands,
        Self::FullSuite,
        Self::FinalValidator,
        Self::RequiredBughunter,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::UnitsClosed => "units-closed",
            Self::MandatoryFindings => "mandatory-findings-zero",
            Self::RequiredProofFresh => "required-proof-fresh",
            Self::JobsTerminal => "jobs-terminal",
            Self::AttributableDiff => "attributable-integrated-diff",
            Self::FinalCommands => "final-commands-exact-tip",
            Self::FullSuite => "full-suite-exact-tip",
            Self::FinalValidator => "final-validator-exact-tip",
            Self::RequiredBughunter => "required-bughunter-exact-tip",
        }
    }
}

pub fn finalization_data_covers_gate() -> bool {
    FinalCondition::ALL
        .iter()
        .all(|condition| FINALIZATION_KDL.contains(condition.id()))
}

pub fn verify_final_gate(input: &FinalGateInput) -> Result<FinalVerificationPass, FinalCondition> {
    require(input.every_unit_closed, FinalCondition::UnitsClosed)?;
    require(input.no_mandatory_findings, FinalCondition::MandatoryFindings)?;
    require(input.no_stale_required_proof, FinalCondition::RequiredProofFresh)?;
    require(input.no_active_or_unknown_jobs, FinalCondition::JobsTerminal)?;
    require(input.attributable_integrated_diff, FinalCondition::AttributableDiff)?;
    require(evidence_current(&input.final_commands, &input.final_tip), FinalCondition::FinalCommands)?;
    require(evidence_current(&input.full_suite, &input.final_tip), FinalCondition::FullSuite)?;
    require(evidence_current(&input.final_validator, &input.final_tip), FinalCondition::FinalValidator)?;
    let bughunter_required = input.triggers.required();
    if bughunter_required {
        let current = input
            .bughunter
            .as_ref()
            .is_some_and(|evidence| evidence_current(evidence, &input.final_tip));
        require(current, FinalCondition::RequiredBughunter)?;
    }
    Ok(FinalVerificationPass { tip: input.final_tip.clone(), bughunter_required })
}

fn require(value: bool, condition: FinalCondition) -> Result<(), FinalCondition> {
    if value { Ok(()) } else { Err(condition) }
}

fn evidence_current(evidence: &TipEvidence, tip: &str) -> bool {
    evidence.passed && evidence.tip == tip
}
