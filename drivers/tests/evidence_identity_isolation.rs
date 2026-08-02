use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use drivers::evidence::{EvidenceError, EvidenceIdentity};

static CWD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

struct CwdGuard {
    previous: PathBuf,
}

impl CwdGuard {
    fn enter(path: &Path) -> Self {
        let previous = std::env::current_dir().expect("current dir");
        std::env::set_current_dir(path).expect("set current dir");
        Self { previous }
    }
}

impl Drop for CwdGuard {
    fn drop(&mut self) {
        std::env::set_current_dir(&self.previous).expect("restore current dir");
    }
}

fn temp_root(label: &str) -> PathBuf {
    let pid = std::process::id();
    loop {
        let nonce = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = PathBuf::from("/private/tmp").join(format!(
            "pi-autopilot-evidence-identity-{label}-{pid}-{nonce}"
        ));
        match fs::create_dir(&path) {
            Ok(()) => return fs::canonicalize(path).expect("canonical temp root"),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("create temp root failed: {error}"),
        }
    }
}

fn source_tree_run_identities() -> Vec<PathBuf> {
    let drivers_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let package_root = drivers_root.parent().expect("package root").to_path_buf();
    [drivers_root, package_root]
        .into_iter()
        .flat_map(|root| find_run_identities(&root))
        .collect()
}

fn find_run_identities(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let pi_root = root.join(".pi");
    if pi_root.exists() {
        visit(&pi_root, &mut out);
    }
    out
}

fn visit(path: &Path, out: &mut Vec<PathBuf>) {
    let entries =
        fs::read_dir(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    for entry in entries {
        let entry = entry.expect("directory entry");
        let path = entry.path();
        let file_type = entry.file_type().expect("file type");
        if file_type.is_dir() {
            visit(&path, out);
        } else if entry.file_name() == "run-identity.json" {
            out.push(path);
        }
    }
}

#[test]
fn evidence_identity_writes_run_identity_only_under_isolated_test_cwd() {
    let _lock = CWD_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    assert_eq!(source_tree_run_identities(), Vec::<PathBuf>::new());
    let root = temp_root("isolated");
    {
        let _cwd = CwdGuard::enter(&root);
        let identity = EvidenceIdentity::for_workstream("main").expect("identity");
        assert_eq!(identity.workstream.0, "main");
    }
    assert!(root.join(".pi/autopilot/main/run-identity.json").exists());
    assert_eq!(source_tree_run_identities(), Vec::<PathBuf>::new());
    fs::remove_dir_all(root).expect("remove isolated temp root");
}

#[test]
fn evidence_identity_mismatched_repo_key_is_still_loudly_rejected() {
    let _lock = CWD_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let first = temp_root("first");
    let second = temp_root("second");
    {
        let _cwd = CwdGuard::enter(&first);
        EvidenceIdentity::for_workstream("main").expect("first identity");
    }
    let first_manifest = first.join(".pi/autopilot/main/run-identity.json");
    let second_manifest = second.join(".pi/autopilot/main/run-identity.json");
    fs::create_dir_all(second_manifest.parent().expect("manifest parent")).expect("manifest dir");
    fs::copy(&first_manifest, &second_manifest).expect("copy mismatched manifest");
    let error = {
        let _cwd = CwdGuard::enter(&second);
        EvidenceIdentity::for_workstream("main").expect_err("mismatch must reject")
    };
    assert!(
        matches!(error, EvidenceError::Store(ref message) if message == "run identity mismatch"),
        "unexpected error: {error:?}"
    );
    assert_eq!(source_tree_run_identities(), Vec::<PathBuf>::new());
    fs::remove_dir_all(first).expect("remove first temp root");
    fs::remove_dir_all(second).expect("remove second temp root");
}
