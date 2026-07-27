use std::{fs, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};

use drivers::{
    integration::{
        CandidateKind, CandidateRequest, CheckCommand, DeliveryLifecycle, ReleaseIntegrator,
    },
    vcs::GitVcs,
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
const ZERO: &str = "0000000000000000000000000000000000000000";

#[test]
fn successor_worktree_starts_from_release_updated_tip() {
    let fixture = Fixture::new("successor-new-main");
    let lane_tip = fixture.lane_commit();
    fs::create_dir_all(fixture.owner.join("integration")).expect("integration parent");
    let integrator = fixture.integrator();
    let prepared = integrator
        .merge_and_cas(
            CandidateRequest {
                candidate_id: "release-one".to_owned(),
                enqueue_sequence: 1,
                kind: CandidateKind::ForwardRelease,
                candidate_tip: lane_tip,
            },
            &fixture.owner.join("integration/release-one"),
            &[CheckCommand {
                program: "true".to_owned(),
                args: Vec::new(),
            }],
        )
        .expect("release merge");

    let successor = integrator
        .prepare_successor(&fixture.owner.join("successors/s1"), &["keep.txt"])
        .expect("successor worktree");
    assert_eq!(successor.base_tip, prepared.new_tip);
    assert_ne!(successor.base_tip, prepared.old_tip);
    assert_eq!(
        fixture
            .vcs
            .read_tip(&successor.root, "HEAD")
            .expect("successor head"),
        prepared.new_tip
    );
}

#[test]
fn forward_integrated_does_not_mean_closed() {
    let released_with_open_closure = DeliveryLifecycle {
        forward_integrated: true,
        closed: false,
    };
    assert!(!released_with_open_closure.final_result_allowed());

    let closed = DeliveryLifecycle {
        forward_integrated: true,
        closed: true,
    };
    assert!(closed.final_result_allowed());
}

struct Fixture {
    owner: PathBuf,
    source: PathBuf,
    base: String,
    vcs: GitVcs,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let owner = temp_root(name);
        let source = owner.join("repo");
        let vcs = GitVcs::new(&owner);
        let base = vcs.init_fixture(&source).expect("seed repo");
        vcs.swap(&source, "refs/autopilot/run-main", &base, ZERO)
            .expect("run-main ref");
        Self { owner, source, base, vcs }
    }

    fn integrator(&self) -> ReleaseIntegrator {
        ReleaseIntegrator::new(&self.owner, &self.source, "refs/autopilot/run-main")
    }

    fn lane_commit(&self) -> String {
        let root = self.owner.join("lane-worktree");
        self.vcs
            .prepare(&root, &self.source, &self.base, &["keep.txt"])
            .expect("lane worktree");
        fs::write(root.join("keep.txt"), "lane\n").expect("lane file");
        self.vcs.stage_all(&root).expect("stage lane");
        self.vcs.snapshot(&root, "lane").expect("lane commit")
    }
}

fn temp_root(name: &str) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("autopilot-{name}-{}-{n}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    root
}
