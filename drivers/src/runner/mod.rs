use std::path::{Path, PathBuf};

use kernel::failure::{Failure, HardBoundary};
use kernel::generated::{
    BackgroundAction, Bytes, DeliveryResult, Id, ModeId, Ref, Sha, SupersessionState,
};

use crate::vcs::GitVcs;

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RunnerAssignment {
    pub action_id: Id,
    pub assignment_id: Id,
    pub role_id: Id,
    pub mode: ModeId,
    pub run_revision: u64,
    pub lane_id: Id,
    pub attempt: u32,
    pub base_commit: Sha,
    pub worktree: PathBuf,
    pub session_file: PathBuf,
    pub roster_assignment: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct DeliveryExpectation {
    pub assignment_id: Id,
    pub role_id: Id,
    pub mode: ModeId,
    pub run_revision: u64,
    pub lane_id: Id,
    pub attempt: u32,
    pub base_commit: Sha,
    pub worktree: PathBuf,
    pub required_focused_evidence: usize,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct AcceptedDelivery {
    pub package_commit: Sha,
    pub package_tree: Sha,
    pub changed_paths: Vec<String>,
    pub audit_ref: Ref,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum DeliveryRejection {
    CarrierCount,
    Identity,
    BaseOrWorktree,
    MissingPackageCommit,
    MissingChangedPaths,
    MissingAudit,
    MissingFocusedEvidence,
    HardBoundaryViolation,
    AgentGitMutation,
}

pub fn bg_action(assignment: &RunnerAssignment) -> BackgroundAction {
    let command = format!(
        "autopilot-agent-run --assignment {} --session {} --no-auto-compact --role {} --mode {} --roster {}",
        assignment.assignment_id.0,
        assignment.session_file.display(),
        assignment.role_id.0,
        assignment.mode.0,
        assignment.roster_assignment
    );
    BackgroundAction {
        action_id: assignment.action_id.clone(),
        assignment_id: assignment.assignment_id.clone(),
        kind: kernel::generated::ActionKind::LaunchBackground,
        command_bytes: Bytes(command),
        display_name: "autopilot-agent-run".to_owned(),
        is_agent: true,
        timeout: None,
        notify_on_completion: true,
        trigger_on_completion: true,
        run_revision: assignment.run_revision,
        expires_at: None,
        supersession_state: SupersessionState("live".to_owned()),
    }
}

pub fn package_delivery_commit(
    vcs: &GitVcs,
    worktree: &Path,
    message: &str,
) -> Result<Sha, Failure> {
    vcs.stage_all(worktree)?;
    vcs.snapshot(worktree, message).map(Sha)
}

pub fn refuse_agent_git_mutation(vcs: &GitVcs) -> Result<(), DeliveryRejection> {
    match vcs.mutate_as_agent() {
        Err(Failure::Unsafe {
            boundary: HardBoundary::AgentVersionMutation,
        }) => Err(DeliveryRejection::AgentGitMutation),
        Ok(()) => Ok(()),
        Err(_) => Err(DeliveryRejection::AgentGitMutation),
    }
}

pub fn accept_delivery(
    carriers: &[DeliveryResult],
    expected: &DeliveryExpectation,
) -> Result<AcceptedDelivery, DeliveryRejection> {
    if carriers.len() != 1 {
        return Err(DeliveryRejection::CarrierCount);
    }
    let result = &carriers[0];
    if result.assignment_id != expected.assignment_id
        || result.role_id != expected.role_id
        || result.mode != expected.mode
        || result.run_revision != expected.run_revision
        || result.lane_id != expected.lane_id
        || result.attempt != expected.attempt
    {
        return Err(DeliveryRejection::Identity);
    }
    if result.base_commit != expected.base_commit
        || Path::new(&result.worktree.0) != expected.worktree
    {
        return Err(DeliveryRejection::BaseOrWorktree);
    }
    if !result.hard_boundary_violations.is_empty() {
        return Err(DeliveryRejection::HardBoundaryViolation);
    }
    let package_commit = match &result.package_commit {
        Some(value) if !value.0.trim().is_empty() => value.clone(),
        _ => return Err(DeliveryRejection::MissingPackageCommit),
    };
    let package_tree = match &result.package_tree {
        Some(value) if !value.0.trim().is_empty() => value.clone(),
        _ => return Err(DeliveryRejection::MissingPackageCommit),
    };
    if result.actual_changed_paths.is_empty() {
        return Err(DeliveryRejection::MissingChangedPaths);
    }
    if result.execution_audit_ref.0.trim().is_empty() {
        return Err(DeliveryRejection::MissingAudit);
    }
    if result.focused_evidence_refs.len() < expected.required_focused_evidence {
        return Err(DeliveryRejection::MissingFocusedEvidence);
    }
    Ok(AcceptedDelivery {
        package_commit,
        package_tree,
        changed_paths: result
            .actual_changed_paths
            .iter()
            .map(|path| path.0.clone())
            .collect(),
        audit_ref: result.execution_audit_ref.clone(),
    })
}
