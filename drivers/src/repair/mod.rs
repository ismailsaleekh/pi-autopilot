use std::{collections::BTreeSet, path::Path};

use kernel::failure::{Failure, HardBoundary};

use crate::vcs::GitVcs;

const RECOVERY_POLICY: &str = include_str!("../../../data/recovery.kdl");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SemanticRecoveryPolicy {
    pub max_attempts: u32,
}

impl SemanticRecoveryPolicy {
    pub fn package() -> Result<Self, String> {
        Self::parse(RECOVERY_POLICY)
    }

    pub fn parse(source: &str) -> Result<Self, String> {
        let line = source
            .lines()
            .map(str::trim)
            .find_map(|line| line.strip_prefix("semantic_recovery "))
            .ok_or_else(|| "recovery policy missing semantic_recovery".to_owned())?;
        if !line.contains("scope=\"typed-model-rejection\"")
            || !line.contains("revalidation=\"same-gate\"")
            || !line.contains("exhaustion=\"paused-operator-decision\"")
            || !line.contains("session=\"fresh-recovery-assignment\"")
        {
            return Err("semantic_recovery posture is not fail-closed".to_owned());
        }
        let start = line
            .find("max_attempts=")
            .ok_or_else(|| "semantic_recovery missing max_attempts".to_owned())?
            + "max_attempts=".len();
        let rest = &line[start..];
        let end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        let max_attempts = rest[..end]
            .parse::<u32>()
            .map_err(|_| "semantic_recovery max_attempts is not a number".to_owned())?;
        if max_attempts != 1 {
            return Err("semantic_recovery must remain exactly one attempt".to_owned());
        }
        Ok(Self { max_attempts })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct CommitId(pub String);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepairMergeRequest {
    pub run_main: CommitId,
    pub repair_base: CommitId,
    pub repair_commits: Vec<CommitId>,
    pub original_lane_commits: Vec<CommitId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepairMergePlan {
    pub base: CommitId,
    pub commits_to_integrate: Vec<CommitId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RepairMergeError {
    RepairBaseNotRunMain,
    NoRepairCommit,
    LaneCommitWouldRepeat(CommitId),
}

pub fn plan_repair_merge(request: RepairMergeRequest) -> Result<RepairMergePlan, RepairMergeError> {
    if request.repair_base != request.run_main {
        return Err(RepairMergeError::RepairBaseNotRunMain);
    }
    if request.repair_commits.is_empty() {
        return Err(RepairMergeError::NoRepairCommit);
    }
    let lane: BTreeSet<CommitId> = request.original_lane_commits.into_iter().collect();
    for commit in &request.repair_commits {
        if lane.contains(commit) {
            return Err(RepairMergeError::LaneCommitWouldRepeat(commit.clone()));
        }
    }
    Ok(RepairMergePlan {
        base: request.run_main,
        commits_to_integrate: request.repair_commits,
    })
}

pub struct RepairWorktree<'a> {
    vcs: &'a GitVcs,
}

impl<'a> RepairWorktree<'a> {
    pub const fn new(vcs: &'a GitVcs) -> Self {
        Self { vcs }
    }

    pub fn prepare_from_run_main(
        &self,
        root: &Path,
        source: &Path,
        run_main_ref: &str,
        profile: &[&str],
    ) -> Result<(), Failure> {
        self.vcs.prepare(root, source, run_main_ref, profile)
    }

    pub fn commit_repair(&self, root: &Path, message: &str) -> Result<CommitId, Failure> {
        self.vcs.stage_all(root)?;
        self.vcs.snapshot(root, message).map(CommitId)
    }

    pub fn reject_remote_sync(&self) -> Result<(), Failure> {
        Err(Failure::Unsafe {
            boundary: HardBoundary::RemoteOrDestructiveNetwork,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForwardEdge {
    pub id: String,
    pub contract_surfaces: Vec<String>,
    pub dependent_merged: bool,
    pub dependent_work_id: String,
    pub criteria_ids: Vec<String>,
    pub evidence_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleasedContractChange {
    pub changed_surfaces: Vec<String>,
    pub replacement_contract_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractChangePlan {
    pub invalidated_edges: Vec<String>,
    pub paused_or_refreshed_dependents: Vec<DependentAction>,
    pub stale_evidence: Vec<String>,
    pub local_amendments: Vec<String>,
    pub unchanged_assumptions: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DependentAction {
    PauseAndRefresh { edge_id: String, work_id: String },
    TargetedAmendment { edge_id: String, work_id: String },
}

impl ContractChangePlan {
    pub fn every_affected_edge_has_action(&self) -> bool {
        self.invalidated_edges.iter().all(|edge_id| {
            self.paused_or_refreshed_dependents
                .iter()
                .any(|action| match action {
                    DependentAction::PauseAndRefresh { edge_id: id, .. }
                    | DependentAction::TargetedAmendment { edge_id: id, .. } => id == edge_id,
                })
        })
    }
}

pub fn route_released_contract_change(
    edges: &[ForwardEdge],
    change: &ReleasedContractChange,
) -> ContractChangePlan {
    let mut invalidated_edges = Vec::new();
    let mut paused_or_refreshed_dependents = Vec::new();
    let mut stale_evidence = Vec::new();
    let mut local_amendments = Vec::new();
    let mut unchanged_assumptions = Vec::new();
    for edge in edges {
        if overlap(&edge.contract_surfaces, &change.changed_surfaces) {
            invalidated_edges.push(edge.id.clone());
            if edge.dependent_merged {
                stale_evidence.extend(edge.evidence_ids.clone());
                local_amendments.extend(edge.criteria_ids.clone());
                paused_or_refreshed_dependents.push(DependentAction::TargetedAmendment {
                    edge_id: edge.id.clone(),
                    work_id: edge.dependent_work_id.clone(),
                });
            } else {
                paused_or_refreshed_dependents.push(DependentAction::PauseAndRefresh {
                    edge_id: edge.id.clone(),
                    work_id: edge.dependent_work_id.clone(),
                });
            }
        } else {
            unchanged_assumptions.push(edge.id.clone());
        }
    }
    ContractChangePlan {
        invalidated_edges,
        paused_or_refreshed_dependents,
        stale_evidence,
        local_amendments,
        unchanged_assumptions,
    }
}

fn overlap(left: &[String], right: &[String]) -> bool {
    left.iter()
        .any(|item| right.iter().any(|other| item == other))
}

#[cfg(test)]
#[path = "../../tests/unit/repair.rs"]
mod tests;
