pub mod sim;

use kernel::failure::{Failure, HardBoundary, RecoveryRoute, RetryPolicy};
use std::{
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

#[derive(Debug)]
pub struct GitVcs {
    owner: PathBuf,
}

impl GitVcs {
    pub fn new(owner: impl Into<PathBuf>) -> Self {
        Self {
            owner: clean(owner.into()),
        }
    }

    pub fn init_fixture(&self, source: &Path) -> Result<String, Failure> {
        let source = self.owned(source)?;
        fs::create_dir_all(&source).map_err(transient)?;
        self.git(&source, os(&["init", "-b", "main"]))?;
        self.git(
            &source,
            os(&["config", "user.email", "package@example.invalid"]),
        )?;
        self.git(&source, os(&["config", "user.name", "Autopilot Package"]))?;
        fs::write(source.join("keep.txt"), "keep\n").map_err(transient)?;
        fs::create_dir_all(source.join("hidden")).map_err(transient)?;
        fs::write(source.join("hidden/secret.txt"), "secret\n").map_err(transient)?;
        self.stage_all(&source)?;
        self.snapshot(&source, "seed")
    }

    pub fn prepare(
        &self,
        root: &Path,
        source: &Path,
        point: &str,
        profile: &[&str],
    ) -> Result<(), Failure> {
        let root = self.owned(root)?;
        let source = self.owned(source)?;
        if let Some(parent) = root.parent() {
            fs::create_dir_all(parent).map_err(transient)?;
        }
        self.git(
            &source,
            vec![
                s("worktree"),
                s("add"),
                s("--detach"),
                s("--no-checkout"),
                root.clone().into_os_string(),
                s(point),
            ],
        )?;
        self.git(&root, os(&["sparse-checkout", "init", "--no-cone"]))?;
        self.apply_profile(&root, profile)?;
        self.git(&root, vec![s("checkout"), s("--detach"), s(point)])?;
        Ok(())
    }

    pub fn materialize(
        &self,
        root: &Path,
        profile: &[&str],
        required: &[&str],
    ) -> Result<(), Failure> {
        let root = self.owned(root)?;
        for item in required {
            guard_fragment(item)?;
            if !profile.iter().any(|entry| same_fragment(entry, item)) {
                return Err(recoverable());
            }
        }
        self.apply_profile(&root, profile)
    }

    pub fn read_tip(&self, source: &Path, name: &str) -> Result<String, Failure> {
        let source = self.owned(source)?;
        Ok(self
            .git(&source, os(&["rev-parse", "--verify", name]))?
            .trim()
            .to_owned())
    }

    pub fn is_limited(&self, root: &Path) -> Result<bool, Failure> {
        let root = self.owned(root)?;
        Ok(self
            .git(&root, os(&["config", "--bool", "core.sparseCheckout"]))?
            .trim()
            == "true")
    }

    pub fn stage_all(&self, root: &Path) -> Result<(), Failure> {
        let root = self.owned(root)?;
        self.git(&root, os(&["add", "-A"]))?;
        Ok(())
    }

    pub fn snapshot(&self, root: &Path, message: &str) -> Result<String, Failure> {
        let root = self.owned(root)?;
        self.git(&root, os(&["commit", "-m", message]))?;
        self.read_tip(&root, "HEAD")
    }

    pub fn swap(&self, source: &Path, name: &str, new: &str, old: &str) -> Result<(), Failure> {
        if !allowed_ref(name) {
            return Err(unsafe_boundary(HardBoundary::OutOfScopeWrite));
        }
        let source = self.owned(source)?;
        self.git(&source, os(&["update-ref", name, new, old]))?;
        Ok(())
    }

    pub fn fetch(&self) -> Result<(), Failure> {
        Err(unsafe_boundary(HardBoundary::RemoteOrDestructiveNetwork))
    }
    pub fn push(&self) -> Result<(), Failure> {
        Err(unsafe_boundary(HardBoundary::RemoteOrDestructiveNetwork))
    }
    pub fn mutate_remote(&self) -> Result<(), Failure> {
        Err(unsafe_boundary(HardBoundary::RemoteOrDestructiveNetwork))
    }
    pub fn mutate_as_agent(&self) -> Result<(), Failure> {
        Err(unsafe_boundary(HardBoundary::AgentVersionMutation))
    }

    fn apply_profile(&self, root: &Path, profile: &[&str]) -> Result<(), Failure> {
        if profile.is_empty() {
            return Err(recoverable());
        }
        let mut args = os(&["sparse-checkout", "set", "--no-cone", "--"]);
        for item in profile {
            guard_fragment(item)?;
            args.push(s(item));
        }
        self.git(root, args)?;
        Ok(())
    }

    fn owned(&self, path: &Path) -> Result<PathBuf, Failure> {
        let owner = fs::canonicalize(&self.owner).map_err(transient)?;
        let candidate = if path.is_absolute() {
            clean(path.to_path_buf())
        } else {
            clean(self.owner.join(path))
        };
        candidate
            .strip_prefix(&self.owner)
            .map_err(|_| unsafe_boundary(HardBoundary::OutOfScopeWrite))?;
        let mut probe = candidate.as_path();
        loop {
            match fs::canonicalize(probe) {
                Ok(real) => {
                    real.strip_prefix(&owner)
                        .map_err(|_| unsafe_boundary(HardBoundary::OutOfScopeWrite))?;
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    match probe.parent() {
                        Some(parent) => probe = parent,
                        None => return Err(transient_output()),
                    }
                }
                Err(error) => return Err(transient(error)),
            }
        }
        Ok(candidate)
    }

    fn git(&self, dir: &Path, args: Vec<OsString>) -> Result<String, Failure> {
        let output = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .map_err(transient)?;
        if !output.status.success() {
            return Err(transient_output());
        }
        String::from_utf8(output.stdout).map_err(transient)
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
fn allowed_ref(name: &str) -> bool {
    if let Some(rest) = name.strip_prefix("refs/autopilot/results/") {
        let parts = rest.split('/').collect::<Vec<_>>();
        return parts.len() == 2 && parts.iter().all(|part| !part.is_empty());
    }
    let Some(rest) = name.strip_prefix("refs/heads/autopilot/run/") else {
        return false;
    };
    let parts = rest.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        [run, "main"] => !run.is_empty(),
        [run, "lane", item, attempt] | [run, "repair", item, attempt] => {
            !run.is_empty() && !item.is_empty() && valid_attempt(attempt)
        }
        [run, "integration", item] => !run.is_empty() && !item.is_empty(),
        _ => false,
    }
}

fn valid_attempt(value: &str) -> bool {
    value
        .strip_prefix('a')
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

fn guard_fragment(item: &str) -> Result<(), Failure> {
    let path = Path::new(item);
    if path.is_absolute() {
        return Err(unsafe_boundary(HardBoundary::OutOfScopeWrite));
    }
    for part in path.components() {
        if matches!(part, Component::ParentDir) {
            return Err(unsafe_boundary(HardBoundary::OutOfScopeWrite));
        }
    }
    Ok(())
}
fn same_fragment(a: &str, b: &str) -> bool {
    clean(PathBuf::from(a)) == clean(PathBuf::from(b))
}
fn transient<E>(_error: E) -> Failure {
    transient_output()
}
fn transient_output() -> Failure {
    Failure::Transient {
        retry: RetryPolicy::Backoff,
    }
}
fn recoverable() -> Failure {
    Failure::Recoverable {
        route: RecoveryRoute::Tier1,
    }
}
fn unsafe_boundary(boundary: HardBoundary) -> Failure {
    Failure::Unsafe { boundary }
}
