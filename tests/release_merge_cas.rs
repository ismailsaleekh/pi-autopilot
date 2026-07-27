use std::{fs, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};

use drivers::{
    integration::{
        CandidateKind, CandidateRequest, CheckCommand, IntegrationError, IntegrationQueue,
        ReleaseIntegrator,
    },
    vcs::GitVcs,
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
const ZERO: &str = "0000000000000000000000000000000000000000";

#[test]
fn release_merge_runs_no_ff_commit_checks_verification_and_cas() {
    let fixture = Fixture::new("release-merge");
    let lane_tip = fixture.lane_commit("lane edit\n", "lane");
    fs::create_dir_all(fixture.owner.join("integration")).expect("integration parent");
    let integrator = fixture.integrator();
    let prepared = integrator
        .merge_and_cas(
            request("candidate-a", CandidateKind::ForwardRelease, 1, &lane_tip),
            &fixture.owner.join("integration/candidate-a"),
            &[true_check()],
        )
        .expect("release merge and cas");

    let run_main = fixture
        .vcs
        .read_tip(&fixture.source, "refs/autopilot/run-main")
        .expect("run-main");
    assert_eq!(run_main, prepared.new_tip);
    assert_ne!(prepared.old_tip, prepared.new_tip);
    assert_eq!(
        fixture
            .vcs
            .read_tip(&fixture.source, "refs/autopilot/run-main^{tree}")
            .expect("run-main tree"),
        prepared.tree
    );
    assert_eq!(prepared.changed_paths, vec!["keep.txt".to_owned()]);
}

#[test]
fn stale_cas_fails_and_does_not_move_ref() {
    let fixture = Fixture::new("stale-cas");
    let lane_tip = fixture.lane_commit("lane edit\n", "lane");
    fs::create_dir_all(fixture.owner.join("integration")).expect("integration parent");
    let integrator = fixture.integrator();
    let prepared = integrator
        .prepare_release(
            request("candidate-stale", CandidateKind::ForwardRelease, 1, &lane_tip),
            &fixture.owner.join("integration/candidate-stale"),
            &[true_check()],
        )
        .expect("prepared candidate");

    let bump = fixture.lane_commit("intervening edit\n", "main-bump");
    fixture
        .vcs
        .swap(
            &fixture.source,
            "refs/autopilot/run-main",
            &bump,
            &prepared.old_tip,
        )
        .expect("intervening ref move");
    let error = integrator
        .cas_release(&prepared)
        .expect_err("stale compare-and-swap must fail");
    assert_eq!(error, IntegrationError::Git);
    assert_eq!(
        fixture
            .vcs
            .read_tip(&fixture.source, "refs/autopilot/run-main")
            .expect("read run-main"),
        bump,
        "failed stale CAS must leave the ref at the intervening tip"
    );
}

#[test]
fn serialized_queue_honours_six_level_priority() {
    let mut queue = IntegrationQueue::default();
    queue.enqueue(request("final", CandidateKind::FinalTargetSync, 0, "tip"));
    queue.enqueue(request("forward-b", CandidateKind::ForwardRelease, 1, "tip"));
    queue.enqueue(request("closure", CandidateKind::ClosureRepair, 0, "tip"));
    queue.enqueue(request("repair", CandidateKind::ReleasedContractRepair, 99, "tip"));
    queue.enqueue(request("forward-a", CandidateKind::ForwardRelease, 2, "tip"));
    queue.enqueue(request("forward-c", CandidateKind::ForwardRelease, 1, "tip"));

    assert_eq!(queue.start_next().expect("first").candidate_id, "repair");
    assert_eq!(queue.start_next().expect_err("serialized"), IntegrationError::SerializedBusy);
    queue.complete_active();
    assert_eq!(queue.start_next().expect("second").candidate_id, "forward-b");
    queue.complete_active();
    assert_eq!(queue.start_next().expect("third").candidate_id, "forward-c");
    queue.complete_active();
    assert_eq!(queue.start_next().expect("fourth").candidate_id, "forward-a");
    queue.complete_active();
    assert_eq!(queue.start_next().expect("fifth").candidate_id, "closure");
    queue.complete_active();
    assert_eq!(queue.start_next().expect("sixth").candidate_id, "final");
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

    fn lane_commit(&self, body: &str, label: &str) -> String {
        let root = self.owner.join(format!("worktrees/{label}"));
        self.vcs
            .prepare(&root, &self.source, &self.base, &["keep.txt"])
            .expect("lane worktree");
        fs::write(root.join("keep.txt"), body).expect("lane file");
        self.vcs.stage_all(&root).expect("stage lane");
        self.vcs.snapshot(&root, label).expect("lane commit")
    }
}

fn request(id: &str, kind: CandidateKind, sequence: u64, tip: &str) -> CandidateRequest {
    CandidateRequest {
        candidate_id: id.to_owned(),
        enqueue_sequence: sequence,
        kind,
        candidate_tip: tip.to_owned(),
    }
}

fn true_check() -> CheckCommand {
    CheckCommand {
        program: "true".to_owned(),
        args: Vec::new(),
    }
}

fn temp_root(name: &str) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("autopilot-{name}-{}-{n}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    root
}
