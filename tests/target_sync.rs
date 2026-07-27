use std::{fs, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};

use drivers::{
    finalize::TargetSyncer,
    integration::CheckCommand,
    vcs::GitVcs,
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
const ZERO: &str = "0000000000000000000000000000000000000000";

#[test]
fn target_movement_is_integrated_as_isolated_candidate_without_moving_operator_target() {
    let fixture = Fixture::new("target-sync");
    let recorded_base = fixture.base.clone();
    fs::write(fixture.source.join("keep.txt"), "target moved\n").expect("target edit");
    fixture.vcs.stage_all(&fixture.source).expect("stage target");
    let target_tip = fixture.vcs.snapshot(&fixture.source, "operator target move").expect("target commit");
    let target_before = fixture.vcs.read_tip(&fixture.source, "refs/heads/main").expect("target before");
    fs::create_dir_all(fixture.owner.join("integration")).expect("integration parent");

    let syncer = TargetSyncer::new(
        &fixture.owner,
        &fixture.source,
        "refs/autopilot/run-main",
        "refs/heads/main",
    );
    let outcome = syncer
        .reconcile(&recorded_base, &fixture.owner.join("integration/target-sync"), &[true_check()])
        .expect("target sync through release integrator");

    let integrated = outcome.integrated.expect("moved target creates candidate");
    assert_eq!(outcome.target_tip, target_tip);
    assert_eq!(integrated.request.candidate_tip, target_tip);
    assert_ne!(integrated.old_tip, integrated.new_tip);
    assert_eq!(
        fixture.vcs.read_tip(&fixture.source, "refs/autopilot/run-main").expect("run-main after"),
        integrated.new_tip,
        "ordinary CAS path advances only the integration ref"
    );
    assert_eq!(
        fixture.vcs.read_tip(&fixture.source, "refs/heads/main").expect("target after"),
        target_before,
        "operator target ref is unchanged after sync"
    );
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
        vcs.swap(&source, "refs/autopilot/run-main", &base, ZERO).expect("run-main ref");
        Self { owner, source, base, vcs }
    }
}

fn true_check() -> CheckCommand {
    CheckCommand { program: "true".to_owned(), args: Vec::new() }
}

fn temp_root(name: &str) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("autopilot-{name}-{}-{n}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    root
}
