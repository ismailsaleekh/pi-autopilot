use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use drivers::vcs::{GitVcs, sim::MemoryVcs};
use kernel::failure::{Failure, HardBoundary, RecoveryRoute, RetryPolicy};

static NEXT: AtomicUsize = AtomicUsize::new(0);

#[test]
fn closure_g_classes_and_sparse_failure_has_no_full_fallback() {
    let scratch = Scratch::new("sparse-failure");
    let vcs = GitVcs::new(scratch.owner());
    fs::create_dir_all(scratch.owner()).expect("owner root");
    let source = scratch.owner().join("source");
    let head = vcs.init_fixture(&source).expect("fixture repo");

    assert_eq!(
        vcs.prepare(&scratch.root.join("escape"), &source, &head, &["keep.txt"]),
        Err(Failure::Unsafe {
            boundary: HardBoundary::OutOfScopeWrite
        })
    );

    assert_eq!(
        vcs.prepare(
            &scratch.owner().join("missing-wt"),
            &scratch.owner().join("missing"),
            &head,
            &["keep.txt"],
        ),
        Err(Failure::Transient {
            retry: RetryPolicy::Backoff
        })
    );

    let wt = scratch.owner().join("wt");
    vcs.prepare(&wt, &source, &head, &["keep.txt"])
        .expect("sparse view");
    assert!(vcs.is_limited(&wt).expect("limited checkout flag"));
    assert!(wt.join("keep.txt").exists());
    assert!(!wt.join("hidden/secret.txt").exists());

    assert_eq!(
        vcs.materialize(&wt, &["keep.txt"], &["hidden/secret.txt"]),
        Err(Failure::Recoverable {
            route: RecoveryRoute::Tier1
        })
    );

    assert!(vcs.is_limited(&wt).expect("still limited after failure"));
    assert!(!wt.join("hidden/secret.txt").exists());

    let mut sim = MemoryVcs::new();
    sim.prepare("view", &["keep.txt"]).expect("sim prepare");
    assert_eq!(sim.calls(), &["prepare:view:keep.txt".to_owned()]);
}

struct Scratch {
    root: PathBuf,
    owner: PathBuf,
}

impl Scratch {
    fn new(name: &str) -> Self {
        let id = NEXT.fetch_add(1, Ordering::SeqCst);
        let root =
            std::env::temp_dir().join(format!("pi-autopilot-{name}-{}-{id}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root).expect("clean stale temp root");
        }
        fs::create_dir_all(&root).expect("create temp root");
        let owner = root.join("owned");
        Self { root, owner }
    }

    fn owner(&self) -> &Path {
        &self.owner
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if self.root.exists() {
            fs::remove_dir_all(&self.root).expect("remove temp root");
        }
    }
}
