use std::{fs, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};

use drivers::{
    lifecycle::{AbortRequest, CleanupArtifact, CleanupProof, CloseRequest, LocalLifecycle, ProtectedEvidence},
    vcs::GitVcs,
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
const ZERO: &str = "0000000000000000000000000000000000000000";
const RUN_MAIN_REF: &str = "refs/heads/autopilot/run/run-close/main";

#[test]
fn close_creates_result_ref_and_does_not_push_land_move_target_or_write_operator_checkout() {
    let fixture = Fixture::new("close");
    let target_before = fixture.vcs.read_tip(&fixture.source, "refs/heads/main").expect("target before");
    let operator_checkout = fixture.root.join("operator-checkout");
    fs::create_dir_all(&operator_checkout).expect("operator dir");
    fs::write(operator_checkout.join("sentinel.txt"), "operator\n").expect("operator sentinel");
    let safe_tree = fixture.owner.join("worktrees/safe-terminal");
    fs::create_dir_all(&safe_tree).expect("safe tree");
    fs::write(safe_tree.join("done.txt"), "done\n").expect("safe content");
    let lifecycle = LocalLifecycle::new(&fixture.owner, &fixture.source, fixture.owner.join("archive"));
    let report = lifecycle
        .close(CloseRequest {
            workstream: "ws".to_owned(),
            run_id: "run-1".to_owned(),
            final_tip: fixture.base.clone(),
            target_ref: "refs/heads/main".to_owned(),
            evidence: vec![evidence("protected.txt", "proof\n")],
            cleanup: vec![
                CleanupProof { artifact: CleanupArtifact::PackageWorktree(safe_tree.clone()), proven_safe: true },
                CleanupProof { artifact: CleanupArtifact::TempRef("refs/autopilot/tmp/close".to_owned()), proven_safe: true },
            ],
        })
        .expect("close succeeds");

    let result_ref = report.result_ref.expect("result ref");
    assert_eq!(result_ref, "refs/autopilot/results/ws/run-1");
    assert_eq!(fixture.vcs.read_tip(&fixture.source, &result_ref).expect("retained result ref"), fixture.base);
    assert_eq!(fs::read_to_string(report.archive_dir.join("protected.txt")).expect("archived evidence"), "proof\n");
    assert!(report.watchdog_stopped);
    assert_eq!(report.removed.len(), 2);
    assert!(!safe_tree.exists(), "proven-safe package worktree was removed");
    assert!(fixture.vcs.read_tip(&fixture.source, "refs/autopilot/tmp/close").is_err());
    assert_eq!(fixture.vcs.read_tip(&fixture.source, &result_ref).expect("result still retained"), fixture.base);
    assert_eq!(
        fixture.vcs.read_tip(&fixture.source, "refs/heads/main").expect("target after"),
        target_before,
        "close does not land by moving the operator target"
    );
    assert_eq!(
        fs::read_to_string(operator_checkout.join("sentinel.txt")).expect("operator sentinel after"),
        "operator\n",
        "close does not mutate the operator checkout"
    );
}

#[test]
fn close_refuses_unproven_cleanup_and_leaves_that_work_present() {
    let fixture = Fixture::new("unsafe-close");
    let unsafe_tree = fixture.owner.join("worktrees/not-proven");
    fs::create_dir_all(&unsafe_tree).expect("unsafe tree");
    let lifecycle = LocalLifecycle::new(&fixture.owner, &fixture.source, fixture.owner.join("archive"));

    let result = lifecycle.close(CloseRequest {
        workstream: "ws".to_owned(),
        run_id: "run-unsafe".to_owned(),
        final_tip: fixture.base,
        target_ref: "refs/heads/main".to_owned(),
        evidence: Vec::new(),
        cleanup: vec![CleanupProof { artifact: CleanupArtifact::PackageWorktree(unsafe_tree.clone()), proven_safe: false }],
    });
    assert_eq!(result, Err(drivers::lifecycle::LifecycleError::UnsafeCleanup));
    assert!(unsafe_tree.exists(), "unproven cleanup is not removed");
    assert!(fixture.vcs.read_tip(&fixture.source, "refs/autopilot/results/ws/run-unsafe").is_err(), "failed close creates no result ref");
    assert!(!fixture.owner.join("archive/ws/run-unsafe").exists(), "failed close creates no closed archive");
}

#[test]
fn abort_preserves_dirty_work_refs_and_evidence_and_deletes_nothing() {
    let fixture = Fixture::new("abort");
    let run_main_before = fixture.base.clone();
    fixture.vcs.swap(&fixture.source, RUN_MAIN_REF, &fixture.base, ZERO).expect("D76 run main");
    let lane_ref = "refs/heads/autopilot/run/run-close/lane/lane-preserve/a1";
    fixture.vcs.swap(&fixture.source, lane_ref, &fixture.base, ZERO).expect("D76 lane ref");
    let dirty = fixture.owner.join("worktrees/dirty");
    fs::create_dir_all(&dirty).expect("dirty dir");
    fs::write(dirty.join("dirty.txt"), "uncommitted\n").expect("dirty file");

    let lifecycle = LocalLifecycle::new(&fixture.owner, &fixture.source, fixture.owner.join("archive"));
    let report = lifecycle
        .abort(AbortRequest {
            workstream: "ws".to_owned(),
            run_id: "run-abort".to_owned(),
            reason: "operator abort".to_owned(),
            evidence: vec![evidence("kept.txt", "kept\n")],
        })
        .expect("abort succeeds");

    assert_eq!(report.result_ref, None, "abort creates no result/merge ref");
    assert!(report.removed.is_empty(), "abort deletes nothing");
    assert_eq!(fs::read_to_string(dirty.join("dirty.txt")).expect("dirty after abort"), "uncommitted\n");
    assert_eq!(fixture.vcs.read_tip(&fixture.source, lane_ref).expect("D76 lane ref preserved"), fixture.base);
    assert_eq!(fixture.vcs.read_tip(&fixture.source, RUN_MAIN_REF).expect("D76 run main preserved"), run_main_before);
    assert_eq!(fs::read_to_string(report.archive_dir.join("kept.txt")).expect("evidence archived"), "kept\n");
    assert_eq!(fs::read_to_string(report.archive_dir.join("abort-reason.txt")).expect("abort reason"), "operator abort");
}

struct Fixture {
    root: PathBuf,
    owner: PathBuf,
    source: PathBuf,
    base: String,
    vcs: GitVcs,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = temp_root(name);
        let owner = root.join("owned");
        fs::create_dir_all(&owner).expect("owner root");
        let source = owner.join("repo");
        let vcs = GitVcs::new(&owner);
        let base = vcs.init_fixture(&source).expect("seed repo");
        Self { root, owner, source, base, vcs }
    }
}

fn evidence(name: &str, bytes: &str) -> ProtectedEvidence {
    ProtectedEvidence { name: name.to_owned(), bytes: bytes.to_owned() }
}

fn temp_root(name: &str) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("autopilot-{name}-{}-{n}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    root
}
