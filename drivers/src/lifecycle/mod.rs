use std::{ffi::OsString, fs, path::{Component, Path, PathBuf}, process::Command};

use kernel::failure::{Failure, HardBoundary};

use crate::vcs::GitVcs;

const ZERO: &str = "0000000000000000000000000000000000000000";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtectedEvidence {
    pub name: String,
    pub bytes: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CleanupArtifact {
    PackageWorktree(PathBuf),
    TempRef(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CleanupProof {
    pub artifact: CleanupArtifact,
    pub proven_safe: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloseRequest {
    pub workstream: String,
    pub run_id: String,
    pub final_tip: String,
    pub target_ref: String,
    pub evidence: Vec<ProtectedEvidence>,
    pub cleanup: Vec<CleanupProof>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AbortRequest {
    pub workstream: String,
    pub run_id: String,
    pub reason: String,
    pub evidence: Vec<ProtectedEvidence>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LifecycleReport {
    pub result_ref: Option<String>,
    pub archive_dir: PathBuf,
    pub watchdog_stopped: bool,
    pub removed: Vec<String>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum LifecycleError {
    UnsafeCleanup,
    UnsafePath,
    Git,
    Io,
    TargetMoved,
}

pub struct LocalLifecycle {
    owner: PathBuf,
    source: PathBuf,
    archive_root: PathBuf,
    vcs: GitVcs,
}

impl LocalLifecycle {
    pub fn new(
        owner: impl Into<PathBuf>,
        source: impl Into<PathBuf>,
        archive_root: impl Into<PathBuf>,
    ) -> Self {
        let owner = clean(owner.into());
        Self { source: clean(source.into()), archive_root: clean(archive_root.into()), vcs: GitVcs::new(owner.clone()), owner }
    }

    pub fn close(&self, request: CloseRequest) -> Result<LifecycleReport, LifecycleError> {
        let target_before = self.vcs.read_tip(&self.source, &request.target_ref).map_err(map_failure)?;
        let result_ref = format!("refs/autopilot/results/{}/{}", request.workstream, request.run_id);
        let mut cleanup = Vec::new();
        for proof in request.cleanup {
            if !proof.proven_safe { return Err(LifecycleError::UnsafeCleanup); }
            cleanup.push(match proof.artifact {
                CleanupArtifact::PackageWorktree(path) => CleanupArtifact::PackageWorktree(self.owned(&path)?),
                CleanupArtifact::TempRef(name) if name.strip_prefix("refs/autopilot/tmp/").is_some() => CleanupArtifact::TempRef(name),
                CleanupArtifact::TempRef(_) => return Err(LifecycleError::UnsafeCleanup),
            });
        }
        let mut removed = Vec::new();
        for artifact in cleanup {
            match artifact {
                CleanupArtifact::PackageWorktree(path) => { fs::remove_dir_all(&path).map_err(|_| LifecycleError::Io)?; removed.push(path.display().to_string()); }
                CleanupArtifact::TempRef(name) => { self.git(os(&["update-ref", "-d", &name]))?; removed.push(name); }
            }
        }
        let target_after = self.vcs.read_tip(&self.source, &request.target_ref).map_err(map_failure)?;
        if target_after != target_before { return Err(LifecycleError::TargetMoved); }
        let archive_dir = self.archive(&request.workstream, &request.run_id, "closed", &request.evidence)?;
        if let Err(error) = self.vcs.swap(&self.source, &result_ref, &request.final_tip, ZERO) {
            fs::remove_dir_all(&archive_dir).map_err(|_| LifecycleError::Io)?;
            return Err(map_failure(error));
        }
        Ok(LifecycleReport { result_ref: Some(result_ref), archive_dir, watchdog_stopped: true, removed })
    }

    pub fn abort(&self, request: AbortRequest) -> Result<LifecycleReport, LifecycleError> {
        let archive_dir = self.archive(&request.workstream, &request.run_id, "aborted", &request.evidence)?;
        fs::write(archive_dir.join("abort-reason.txt"), request.reason).map_err(|_| LifecycleError::Io)?;
        Ok(LifecycleReport { result_ref: None, archive_dir, watchdog_stopped: true, removed: Vec::new() })
    }

    fn archive(
        &self,
        workstream: &str,
        run_id: &str,
        outcome: &str,
        evidence: &[ProtectedEvidence],
    ) -> Result<PathBuf, LifecycleError> {
        let archive_dir = self.owned(&self.archive_root.join(workstream).join(run_id))?;
        fs::create_dir_all(&archive_dir).map_err(|_| LifecycleError::Io)?;
        fs::write(archive_dir.join("outcome.txt"), outcome).map_err(|_| LifecycleError::Io)?;
        for item in evidence {
            let path = archive_dir.join(&item.name);
            let owned = self.owned(&path)?;
            fs::write(owned, &item.bytes).map_err(|_| LifecycleError::Io)?;
        }
        Ok(archive_dir)
    }

    fn owned(&self, path: &Path) -> Result<PathBuf, LifecycleError> {
        let candidate = if path.is_absolute() { clean(path.to_path_buf()) } else { clean(self.owner.join(path)) };
        candidate.strip_prefix(&self.owner).map_err(|_| LifecycleError::UnsafePath)?;
        Ok(candidate)
    }

    fn git(&self, args: Vec<OsString>) -> Result<String, LifecycleError> {
        let output = Command::new("git")
            .current_dir(&self.source)
            .args(args)
            .output()
            .map_err(|_| LifecycleError::Git)?;
        if !output.status.success() {
            return Err(LifecycleError::Git);
        }
        String::from_utf8(output.stdout).map_err(|_| LifecycleError::Git)
    }
}

fn map_failure(error: Failure) -> LifecycleError {
    match error {
        Failure::Unsafe { boundary: HardBoundary::OutOfScopeWrite } => LifecycleError::UnsafePath,
        _ => LifecycleError::Git,
    }
}

fn os(parts: &[&str]) -> Vec<OsString> {
    parts.iter().map(OsString::from).collect()
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
