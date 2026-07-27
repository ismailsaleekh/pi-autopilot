use std::{
    ffi::OsString,
    path::{Component, Path, PathBuf},
    process::Command,
};

use kernel::failure::{Failure, HardBoundary, RecoveryRoute, RetryPolicy};

use crate::vcs::GitVcs;

#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd)]
pub enum CandidateKind {
    ReleasedContractRepair,
    ForwardRelease,
    ClosureRepair,
    FinalTargetSync,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CandidateRequest {
    pub candidate_id: String,
    pub enqueue_sequence: u64,
    pub kind: CandidateKind,
    pub candidate_tip: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct PreparedCandidate {
    pub request: CandidateRequest,
    pub old_tip: String,
    pub new_tip: String,
    pub tree: String,
    pub changed_paths: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CheckCommand {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct SuccessorWorktree {
    pub root: PathBuf,
    pub base_tip: String,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct DeliveryLifecycle {
    pub forward_integrated: bool,
    pub closed: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub enum IntegrationError {
    EmptyQueue,
    SerializedBusy,
    UnsafePath,
    Git,
    FocusedCheckFailed(String),
    Ancestry,
    Tree,
    Diff,
}

#[derive(Debug, Default)]
pub struct IntegrationQueue {
    items: Vec<CandidateRequest>,
    active: bool,
}

impl CandidateKind {
    fn priority(self) -> u8 {
        match self {
            Self::ReleasedContractRepair => 0,
            Self::ForwardRelease => 1,
            Self::ClosureRepair => 2,
            Self::FinalTargetSync => 3,
        }
    }
}

impl IntegrationQueue {
    pub fn enqueue(&mut self, request: CandidateRequest) {
        self.items.push(request);
        self.items.sort_by(|left, right| {
            (
                left.kind.priority(),
                left.enqueue_sequence,
                left.candidate_id.as_str(),
            )
                .cmp(&(
                    right.kind.priority(),
                    right.enqueue_sequence,
                    right.candidate_id.as_str(),
                ))
        });
    }

    pub fn start_next(&mut self) -> Result<CandidateRequest, IntegrationError> {
        if self.active {
            return Err(IntegrationError::SerializedBusy);
        }
        if self.items.is_empty() {
            return Err(IntegrationError::EmptyQueue);
        }
        self.active = true;
        Ok(self.items.remove(0))
    }

    pub fn complete_active(&mut self) {
        self.active = false;
    }
}

impl DeliveryLifecycle {
    pub fn final_result_allowed(self) -> bool {
        self.forward_integrated && self.closed
    }
}

pub struct ReleaseIntegrator {
    owner: PathBuf,
    source: PathBuf,
    run_main_ref: String,
    vcs: GitVcs,
}

impl ReleaseIntegrator {
    pub fn new(
        owner: impl Into<PathBuf>,
        source: impl Into<PathBuf>,
        run_main_ref: impl Into<String>,
    ) -> Self {
        let owner = clean(owner.into());
        Self {
            vcs: GitVcs::new(owner.clone()),
            owner,
            source: clean(source.into()),
            run_main_ref: run_main_ref.into(),
        }
    }

    pub fn prepare_release(
        &self,
        request: CandidateRequest,
        worktree_root: &Path,
        checks: &[CheckCommand],
    ) -> Result<PreparedCandidate, IntegrationError> {
        let source = self.owned(&self.source)?;
        let root = self.owned(worktree_root)?;
        let old_tip = self
            .vcs
            .read_tip(&source, &self.run_main_ref)
            .map_err(map_failure)?;
        self.git(
            &source,
            vec![
                s("worktree"),
                s("add"),
                s("--detach"),
                root.clone().into_os_string(),
                s(&old_tip),
            ],
        )?;
        self.git(
            &root,
            os(&["merge", "--no-ff", "--no-commit", &request.candidate_tip]),
        )?;
        self.vcs
            .snapshot(&root, &format!("autopilot release {}", request.candidate_id))
            .map_err(map_failure)?;
        run_focused_checks(&root, checks)?;
        let new_tip = self.git(&root, os(&["rev-parse", "HEAD"]))?.trim().to_owned();
        let tree = self
            .git(&root, os(&["rev-parse", "HEAD^{tree}"]))?
            .trim()
            .to_owned();
        self.verify_merge(&root, &old_tip, &request.candidate_tip, &new_tip, &tree)?;
        let changed_paths = diff_paths(&self.git(&root, os(&["diff", "--name-only", &old_tip, &new_tip]))?);
        if changed_paths.is_empty() {
            return Err(IntegrationError::Diff);
        }
        Ok(PreparedCandidate {
            request,
            old_tip,
            new_tip,
            tree,
            changed_paths,
        })
    }

    pub fn cas_release(&self, prepared: &PreparedCandidate) -> Result<(), IntegrationError> {
        let source = self.owned(&self.source)?;
        self.vcs
            .swap(
                &source,
                &self.run_main_ref,
                &prepared.new_tip,
                &prepared.old_tip,
            )
            .map_err(map_failure)
    }

    pub fn merge_and_cas(
        &self,
        request: CandidateRequest,
        worktree_root: &Path,
        checks: &[CheckCommand],
    ) -> Result<PreparedCandidate, IntegrationError> {
        let prepared = self.prepare_release(request, worktree_root, checks)?;
        self.cas_release(&prepared)?;
        Ok(prepared)
    }

    pub fn prepare_successor(
        &self,
        root: &Path,
        profile: &[&str],
    ) -> Result<SuccessorWorktree, IntegrationError> {
        let source = self.owned(&self.source)?;
        let root = self.owned(root)?;
        let base_tip = self
            .vcs
            .read_tip(&source, &self.run_main_ref)
            .map_err(map_failure)?;
        self.vcs
            .prepare(&root, &source, &base_tip, profile)
            .map_err(map_failure)?;
        Ok(SuccessorWorktree { root, base_tip })
    }

    fn verify_merge(
        &self,
        root: &Path,
        old_tip: &str,
        candidate_tip: &str,
        new_tip: &str,
        tree: &str,
    ) -> Result<(), IntegrationError> {
        self.git(root, os(&["merge-base", "--is-ancestor", old_tip, new_tip]))?;
        self.git(
            root,
            os(&["merge-base", "--is-ancestor", candidate_tip, new_tip]),
        )?;
        let head_tree = self
            .git(root, os(&["rev-parse", "HEAD^{tree}"]))?
            .trim()
            .to_owned();
        if head_tree != tree {
            return Err(IntegrationError::Tree);
        }
        let diff_a = diff_paths(&self.git(root, os(&["diff", "--name-only", old_tip, new_tip]))?);
        let diff_b = diff_paths(&self.git(root, os(&["diff", "--name-only", old_tip, "HEAD"]))?);
        if diff_a != diff_b {
            return Err(IntegrationError::Diff);
        }
        Ok(())
    }

    fn owned(&self, path: &Path) -> Result<PathBuf, IntegrationError> {
        let candidate = if path.is_absolute() {
            clean(path.to_path_buf())
        } else {
            clean(self.owner.join(path))
        };
        candidate
            .strip_prefix(&self.owner)
            .map_err(|_| IntegrationError::UnsafePath)?;
        Ok(candidate)
    }

    fn git(&self, dir: &Path, args: Vec<OsString>) -> Result<String, IntegrationError> {
        let output = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .map_err(|_| IntegrationError::Git)?;
        if !output.status.success() {
            return Err(IntegrationError::Git);
        }
        String::from_utf8(output.stdout).map_err(|_| IntegrationError::Git)
    }
}

fn run_focused_checks(root: &Path, checks: &[CheckCommand]) -> Result<(), IntegrationError> {
    for check in checks {
        if check.program.is_empty() {
            return Err(IntegrationError::FocusedCheckFailed("empty-program".to_owned()));
        }
        let output = Command::new(&check.program)
            .current_dir(root)
            .args(&check.args)
            .output()
            .map_err(|_| IntegrationError::FocusedCheckFailed(check.program.clone()))?;
        if !output.status.success() {
            return Err(IntegrationError::FocusedCheckFailed(check.program.clone()));
        }
    }
    Ok(())
}

fn diff_paths(raw: &str) -> Vec<String> {
    raw.lines().map(ToOwned::to_owned).collect()
}

fn map_failure(error: Failure) -> IntegrationError {
    match error {
        Failure::Unsafe {
            boundary: HardBoundary::OutOfScopeWrite,
        } => IntegrationError::UnsafePath,
        Failure::Recoverable {
            route: RecoveryRoute::Tier1,
        } => IntegrationError::Git,
        Failure::Transient {
            retry: RetryPolicy::Backoff,
        } => IntegrationError::Git,
        _ => IntegrationError::Git,
    }
}

fn os(parts: &[&str]) -> Vec<OsString> {
    parts.iter().map(|part| s(part)).collect()
}

fn s(part: &str) -> OsString {
    OsString::from(part)
}

fn clean(path: PathBuf) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}
