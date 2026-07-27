use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use drivers::vcs::GitVcs;
use kernel::failure::{Failure, HardBoundary};

static NEXT: AtomicUsize = AtomicUsize::new(0);

#[test]
fn p7_refuses_remote_target_operator_and_agent_mutation_without_side_effects() {
    let scratch = Scratch::new("local-only");
    fs::create_dir_all(scratch.owner()).expect("owner root");
    let vcs = GitVcs::new(scratch.owner());
    let source = scratch.owner().join("source");
    let first = vcs.init_fixture(&source).expect("fixture repo");

    fs::write(source.join("next.txt"), "next\n").expect("write package content");
    vcs.stage_all(&source).expect("stage package content");
    let second = vcs
        .snapshot(&source, "package snapshot")
        .expect("package commit");
    assert_ne!(first, second);
    let config_before = fs::read_to_string(source.join(".git/config")).expect("config before");

    for refused in [vcs.push(), vcs.fetch(), vcs.mutate_remote()] {
        assert_eq!(
            refused,
            Err(Failure::Unsafe {
                boundary: HardBoundary::RemoteOrDestructiveNetwork
            })
        );
        assert_eq!(
            vcs.read_tip(&source, "refs/heads/main").expect("main tip"),
            second
        );
        assert_eq!(
            fs::read_to_string(source.join(".git/config")).expect("config after"),
            config_before
        );
    }

    let empty = "0000000000000000000000000000000000000000";
    vcs.swap(&source, "refs/autopilot/queue", &first, empty)
        .expect("create package queue ref");
    vcs.swap(&source, "refs/autopilot/queue", &second, &first)
        .expect("advance package queue ref");
    assert_eq!(
        vcs.read_tip(&source, "refs/autopilot/queue")
            .expect("queue ref moved"),
        second
    );

    assert_eq!(
        vcs.swap(&source, "refs/heads/main", &first, &second),
        Err(Failure::Unsafe {
            boundary: HardBoundary::OutOfScopeWrite
        })
    );
    assert_eq!(
        vcs.read_tip(&source, "refs/heads/main")
            .expect("main not moved"),
        second
    );

    let operator_checkout = scratch.root.join("operator-checkout");
    assert_eq!(
        vcs.prepare(&operator_checkout, &source, &second, &["keep.txt"]),
        Err(Failure::Unsafe {
            boundary: HardBoundary::OutOfScopeWrite
        })
    );
    assert!(!operator_checkout.exists());
    assert_eq!(
        vcs.read_tip(&source, "refs/heads/main")
            .expect("main still not moved"),
        second
    );

    assert_eq!(
        vcs.mutate_as_agent(),
        Err(Failure::Unsafe {
            boundary: HardBoundary::AgentVersionMutation
        })
    );
    assert_eq!(
        vcs.read_tip(&source, "refs/heads/main")
            .expect("agent refusal no move"),
        second
    );
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
