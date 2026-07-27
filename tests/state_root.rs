use std::fs;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use drivers::state_root::{
    StateRoot, StateRootError, identity_for, repo_key, repo_key_from_canonical_bytes,
    run_id_from_parts,
};
use kernel::generated::{Id, RunIdentity};

#[test]
fn repo_key_derivation_is_exact_and_stable() -> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("repo-key")?;
    let common = root.join("repo.git");
    fs::create_dir_all(&common)?;
    let first = repo_key(&common)?;
    let second = repo_key(&common)?;
    assert_eq!(first, second);
    assert_eq!(first.0, expected_repo_key(&common)?);
    assert_eq!(
        repo_key_from_canonical_bytes(b"/tmp/repo.git").0,
        "r5j73cbpk42tkxpei7jtfrgjlfcpt6epdz5zijbxmq6xmzsroviq"
    );
    assert_eq!(first.0, first.0.to_ascii_lowercase());
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn run_id_is_uuidv7() {
    let id = run_id_from_parts(0x01890f476b9a, [0xab, 0xcd, 0xef, 1, 2, 3, 4, 5, 6, 7]);
    assert_eq!(id.0.len(), 36);
    assert!(id.0.starts_with("01890f47-6b9a"));
    assert_eq!(&id.0[14..15], "7");
    assert!(matches!(&id.0[19..20], "8" | "9" | "a" | "b"));
}

#[test]
fn one_nonterminal_run_is_enforced_by_repo_and_workstream() -> Result<(), Box<dyn std::error::Error>>
{
    let root = temp_root("active")?;
    let state = StateRoot::from_v2_root(root.join("v2"));
    let id = identity("repo-a", "run-a", "main");
    let lease = state.reserve(&id)?;
    assert!(matches!(state.reserve(&id), Err(StateRootError::ActiveRun)));
    let other = identity("repo-a", "run-b", "other");
    let other_lease = state.reserve(&other)?;
    other_lease.close()?;
    lease.close()?;
    let lease = state.reserve(&id)?;
    lease.close()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn materialized_paths_and_private_modes_are_under_temp_v2() -> Result<(), Box<dyn std::error::Error>>
{
    let home = temp_root("modes")?;
    let state = StateRoot::from_home(&home);
    let identity = identity("repo-a", "run-a", "main");
    let paths = state.materialize(&identity)?;
    assert!(paths.run_dir.starts_with(&home));
    assert!(paths.worktree_dir.starts_with(&home));
    assert!(paths.run_dir.to_string_lossy().contains("/v2/runs/"));
    assert!(
        paths
            .worktree_dir
            .to_string_lossy()
            .contains("/v2/worktrees/")
    );
    let prompt = state.write_private("runs/repo-a/run-a/prompt.md", b"secret prompt")?;
    #[cfg(unix)]
    {
        assert_eq!(
            fs::metadata(&paths.run_dir)?.permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&paths.worktree_dir)?.permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(fs::metadata(&prompt)?.permissions().mode() & 0o777, 0o600);
    }
    fs::remove_dir_all(home)?;
    Ok(())
}

#[test]
fn legacy_paths_are_not_touched_and_tests_use_temp_home() -> Result<(), Box<dyn std::error::Error>>
{
    let home = temp_root("legacy")?;
    assert!(
        !home
            .to_string_lossy()
            .contains("/.pi/agent/autopilot/v2/runs")
    );
    let legacy = home
        .join(".pi")
        .join("agent")
        .join("autopilot")
        .join("runs");
    fs::create_dir_all(&legacy)?;
    let sentinel = legacy.join("F012.readonly");
    fs::write(&sentinel, b"immutable")?;
    let state = StateRoot::from_home(&home);
    let identity = identity("repo-a", "run-a", "main");
    let paths = state.materialize(&identity)?;
    state.write_private("runs/repo-a/run-a/context.md", b"context")?;
    assert!(paths.run_dir.starts_with(&home));
    assert_eq!(fs::read(&sentinel)?, b"immutable");
    assert!(home.starts_with(std::env::temp_dir()));
    fs::remove_dir_all(home)?;
    Ok(())
}

#[test]
fn identity_generation_uses_v2_contract_types() -> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("identity")?;
    let common = root.join("repo.git");
    fs::create_dir_all(&common)?;
    let identity = identity_for(&common, "main")?;
    assert_eq!(identity.repo_key.0, expected_repo_key(&common)?);
    assert_eq!(identity.workstream.0, "main");
    assert_eq!(&identity.run_id.0[14..15], "7");
    fs::remove_dir_all(root)?;
    Ok(())
}

fn identity(repo: &str, run: &str, workstream: &str) -> RunIdentity {
    RunIdentity {
        repo_key: kernel::generated::Base32(repo.to_owned()),
        run_id: kernel::generated::Uuidv7(run.to_owned()),
        workstream: Id(workstream.to_owned()),
    }
}

fn expected_repo_key(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let real = fs::canonicalize(path)?;
    #[cfg(unix)]
    let key = repo_key_from_canonical_bytes(real.as_os_str().as_bytes()).0;
    #[cfg(not(unix))]
    let key = repo_key_from_canonical_bytes(real.to_string_lossy().as_bytes()).0;
    Ok(key)
}

fn temp_root(label: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "pi-autopilot-state-{label}-{}-{n}",
        std::process::id()
    ));
    fs::create_dir_all(&root)?;
    Ok(root)
}
