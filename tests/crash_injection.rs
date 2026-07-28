use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use drivers::{
    integration::{CandidateKind, CandidateRequest, CheckCommand, ReleaseIntegrator},
    recovery::{IntegrationCrashDecision, reconcile_integration_crash, replay_after_crash},
    sim::SimPlatform,
    vcs::GitVcs,
};
use kernel::{
    effect::Effect,
    generated::{EventKind, EventRow, Ref},
    state::fold_events,
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
const ZERO: &str = "0000000000000000000000000000000000000000";

#[test]
fn crash_at_every_step_resumes_to_folded_state() {
    let steps = vec![
        event(1, 0, 1, "plan", &["plan/a"]),
        event(2, 1, 2, "launch", &["task/a"]),
        event(3, 2, 3, "checkpoint", &["checkpoint/a"]),
        event(4, 3, 4, "result", &["result/a", "evidence/a"]),
        event(5, 4, 5, "accept", &["commit/a"]),
    ];
    let expected = fold_events(&steps);

    for crash_after in 0..=steps.len() {
        let mut platform = SimPlatform::new(700 + crash_after as u64);
        platform.apply(Effect::ReturnIdle);
        platform.advance(crash_after as u64);

        let mut durable = steps[..crash_after].to_vec();
        let before_restart = replay_after_crash(&durable);
        assert_eq!(before_restart, fold_events(&steps[..crash_after]));

        durable.extend_from_slice(&steps[crash_after..]);
        let resumed = replay_after_crash(&durable);
        assert_eq!(
            resumed, expected,
            "restart after durable step {crash_after} must equal fold(events)"
        );
        assert_eq!(platform.process_requests(), &[Effect::ReturnIdle]);
    }
}

#[test]
fn integration_crash_between_merge_commit_and_ref_swap_accepts_once() {
    let fixture = Fixture::new("integration-crash");
    let lane_tip = fixture.lane_commit("lane edit\n", "lane");
    fs::create_dir_all(fixture.owner.join("integration")).expect("integration parent");
    let integrator = fixture.integrator();
    let prepared = integrator
        .prepare_release(
            request("candidate-a", CandidateKind::ForwardRelease, 1, &lane_tip),
            &fixture.owner.join("integration/candidate-a"),
            &[true_check()],
        )
        .expect("merge commit prepared before crash");

    let before_swap = fixture
        .vcs
        .read_tip(&fixture.source, "refs/heads/autopilot/run/run-main/main")
        .expect("run-main before swap");
    assert_eq!(
        reconcile_integration_crash(&prepared.old_tip, &prepared.new_tip, &before_swap),
        IntegrationCrashDecision::CasNeeded
    );

    let mut acceptances = 0;
    integrator
        .cas_release(&prepared)
        .expect("single CAS after restart");
    acceptances += 1;

    let after_swap = fixture
        .vcs
        .read_tip(&fixture.source, "refs/heads/autopilot/run/run-main/main")
        .expect("run-main after swap");
    assert_eq!(
        reconcile_integration_crash(&prepared.old_tip, &prepared.new_tip, &after_swap),
        IntegrationCrashDecision::AlreadyAccepted
    );
    if matches!(
        reconcile_integration_crash(&prepared.old_tip, &prepared.new_tip, &after_swap),
        IntegrationCrashDecision::CasNeeded
    ) {
        integrator.cas_release(&prepared).expect("duplicate CAS");
        acceptances += 1;
    }

    assert_eq!(
        acceptances, 1,
        "response-loss retry accepts neither zero nor two"
    );
    assert_eq!(after_swap, prepared.new_tip);
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
        vcs.swap(
            &source,
            "refs/heads/autopilot/run/run-main/main",
            &base,
            ZERO,
        )
        .expect("run-main ref");
        Self {
            owner,
            source,
            base,
            vcs,
        }
    }

    fn integrator(&self) -> ReleaseIntegrator {
        ReleaseIntegrator::new(
            &self.owner,
            &self.source,
            "refs/heads/autopilot/run/run-main/main",
        )
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

fn event(
    sequence: u64,
    previous_revision: u64,
    new_revision: u64,
    kind: &str,
    refs: &[&str],
) -> EventRow {
    EventRow {
        sequence,
        previous_revision,
        new_revision,
        kind: EventKind(kind.to_owned()),
        artifact_refs: refs.iter().map(|value| Ref((*value).to_owned())).collect(),
    }
}

fn temp_root(name: &str) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("autopilot-{name}-{}-{n}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    root
}
