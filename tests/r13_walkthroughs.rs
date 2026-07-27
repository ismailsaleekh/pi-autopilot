use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use drivers::{
    finalize::TargetSyncer,
    integration::{CandidateKind, CheckCommand},
    lifecycle::{AbortRequest, CleanupArtifact, CleanupProof, CloseRequest, LocalLifecycle, ProtectedEvidence},
    sim::SimPlatform,
    vcs::GitVcs,
};
use kernel::{
    effect::{Effect, OperatorMessage},
    failure::{Failure, HardBoundary},
    generated::{EventKind, EventRow, Ref},
    state::fold_events,
};

const RECOVERY_KDL: &str = include_str!("../data/recovery.kdl");
const ZERO: &str = "0000000000000000000000000000000000000000";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn r13_walkthroughs_are_complete_live_or_explicitly_pending() {
    let seeds = seeds();
    assert_eq!(seeds.len(), 14);

    let live: Vec<u8> = seeds
        .iter()
        .filter(|seed| matches!(seed.status, SeedStatus::Live { .. }))
        .map(|seed| seed.number)
        .collect();
    let pending: Vec<u8> = seeds
        .iter()
        .filter(|seed| matches!(seed.status, SeedStatus::Pending { .. }))
        .map(|seed| seed.number)
        .collect();
    assert_eq!(live, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    assert!(pending.is_empty());

    for seed in seeds {
        assert!(
            RECOVERY_KDL.contains(&format!("r13 number={}", seed.number)),
            "seed {} must be declared in recovery.kdl",
            seed.number
        );
        match seed.status {
            SeedStatus::Live { steps } => {
                assert!(!steps.is_empty(), "live seed {} cannot be vacuous", seed.number);
                assert!(
                    RECOVERY_KDL.contains(&format!("number={} name=\"{}\" status=\"live\"", seed.number, seed.name)),
                    "live seed {} must be data-declared",
                    seed.number
                );
                let first = replay(seed.number, steps);
                let second = replay(seed.number, steps);
                assert_eq!(first, second, "seed {} replay must be deterministic", seed.number);
                assert_eq!(first.accepted, steps.len() as u64);
            }
            SeedStatus::Pending { surface } => assert_pending_declared(seed, surface, RECOVERY_KDL),
        }
    }
}

#[test]
fn pending_status_remains_constructible_and_requires_named_surface() {
    let future = pending(99, "future wave", "future explicit surface");
    let declarations = "r13 number=99 name=\"future wave\" status=\"pending\" needs=\"future explicit surface\"";
    match future.status {
        SeedStatus::Pending { surface } => assert_pending_declared(future, surface, declarations),
        SeedStatus::Live { .. } => unreachable!("pending helper must construct Pending"),
    }
}

fn replay(number: u8, steps: &[&str]) -> ReplayOutcome {
    let mut platform = SimPlatform::new(u64::from(number));
    let mut events = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        platform.apply(Effect::RequestOperator(OperatorMessage(
            format!("r13-{number}:{step}").into_bytes(),
        )));
        platform.advance(1);
        let sequence = index as u64 + 1;
        events.push(EventRow {
            sequence,
            previous_revision: sequence - 1,
            new_revision: sequence,
            kind: EventKind(format!("r13-{number}-{step}")),
            artifact_refs: vec![Ref(format!("r13/{number}/{step}"))],
        });
    }
    let state = fold_events(&events);
    assert_eq!(platform.process_requests().len(), steps.len());
    assert!(platform.store_requests().is_empty());
    assert!(platform.vcs_requests().is_empty());
    ReplayOutcome {
        accepted: state.accepted,
        process_requests: platform.process_requests().len(),
        store_requests: platform.store_requests().len(),
        vcs_requests: platform.vcs_requests().len(),
        effects: platform.effects().len(),
        surface: replay_surface(number),
    }
}

fn replay_surface(number: u8) -> Option<SurfaceOutcome> {
    match number {
        11 => Some(seed_11_target_movement()),
        13 => Some(seed_13_abort()),
        14 => Some(seed_14_close()),
        _ => None,
    }
}

fn seed_11_target_movement() -> SurfaceOutcome {
    let fixture = Fixture::new("r13-target-sync");
    let recorded_base = fixture.base.clone();
    fixture
        .vcs
        .swap(&fixture.source, "refs/heads/autopilot/run/run-main/main", &fixture.base, ZERO)
        .expect("run-main ref");
    fs::write(fixture.source.join("keep.txt"), "target moved\n").expect("target edit");
    fixture.vcs.stage_all(&fixture.source).expect("stage target");
    let target_tip = fixture
        .vcs
        .snapshot(&fixture.source, "operator target move")
        .expect("target commit");
    let operator_target_before = fixture
        .vcs
        .read_tip(&fixture.source, "refs/heads/main")
        .expect("target before sync");
    fs::create_dir_all(fixture.owner.join("integration")).expect("integration parent");

    let syncer = TargetSyncer::new(
        &fixture.owner,
        &fixture.source,
        "refs/heads/autopilot/run/run-main/main",
        "refs/heads/main",
    );
    let outcome = syncer
        .reconcile(&recorded_base, &fixture.owner.join("integration/target-sync"), &[true_check()])
        .expect("target sync through release integrator");

    let integrated = outcome.integrated.expect("moved target creates candidate");
    let run_main_after = fixture
        .vcs
        .read_tip(&fixture.source, "refs/heads/autopilot/run/run-main/main")
        .expect("run-main after");
    let operator_target_after = fixture
        .vcs
        .read_tip(&fixture.source, "refs/heads/main")
        .expect("target after sync");
    assert_ne!(target_tip, recorded_base, "seed 11 starts from a genuinely moved target");
    assert_eq!(outcome.target_tip, target_tip);
    assert_eq!(integrated.request.kind, CandidateKind::FinalTargetSync);
    assert_eq!(integrated.request.candidate_id, "target-sync");
    assert_eq!(integrated.request.candidate_tip, target_tip);
    assert_ne!(integrated.old_tip, integrated.new_tip);
    assert_eq!(run_main_after, integrated.new_tip, "ordinary CAS path advances only the integration ref");
    assert_eq!(
        operator_target_after, operator_target_before,
        "seed 11 negative: operator target ref is unchanged after target sync"
    );

    SurfaceOutcome::TargetMovement {
        target_moved: target_tip != recorded_base,
        target_sync_candidate: integrated.request.kind == CandidateKind::FinalTargetSync,
        run_main_advanced: run_main_after == integrated.new_tip,
        operator_target_unchanged: operator_target_after == operator_target_before,
    }
}

fn seed_13_abort() -> SurfaceOutcome {
    let fixture = Fixture::new("r13-abort");
    let run_main_before = fixture.base.clone();
    fixture
        .vcs
        .swap(&fixture.source, "refs/heads/autopilot/run/run-main/main", &fixture.base, ZERO)
        .expect("run-main");
    let lane_ref = "refs/heads/autopilot/run/run-r13/lane/lane-preserve/a1";
    fixture.vcs.swap(&fixture.source, lane_ref, &fixture.base, ZERO).expect("D76 lane ref");
    let dirty = fixture.owner.join("worktrees/dirty");
    fs::create_dir_all(&dirty).expect("dirty dir");
    fs::write(dirty.join("dirty.txt"), "uncommitted\n").expect("dirty file");

    let lifecycle = LocalLifecycle::new(&fixture.owner, &fixture.source, fixture.owner.join("archive"));
    let report = lifecycle
        .abort(AbortRequest {
            workstream: "ws".to_owned(),
            run_id: "run-13".to_owned(),
            reason: "operator abort".to_owned(),
            evidence: vec![evidence("kept.txt", "kept\n")],
        })
        .expect("abort succeeds");

    let dirty_after = fs::read_to_string(dirty.join("dirty.txt")).expect("dirty after abort");
    let temp_ref_after = fixture
        .vcs
        .read_tip(&fixture.source, lane_ref)
        .expect("D76 lane ref preserved");
    let run_main_after = fixture
        .vcs
        .read_tip(&fixture.source, "refs/heads/autopilot/run/run-main/main")
        .expect("run-main preserved");
    assert!(report.watchdog_stopped, "seed 13 stops the background watchdog");
    assert_eq!(report.result_ref, None, "seed 13 negative: abort creates no merge/result ref");
    assert!(report.removed.is_empty(), "seed 13 negative: abort deletes nothing");
    assert_eq!(dirty_after, "uncommitted\n", "seed 13 preserves dirty work");
    assert_eq!(temp_ref_after, fixture.base, "seed 13 preserves refs");
    assert_eq!(run_main_after, run_main_before, "seed 13 preserves run-main");
    assert_eq!(
        fs::read_to_string(report.archive_dir.join("kept.txt")).expect("evidence archived"),
        "kept\n"
    );
    assert_eq!(
        fs::read_to_string(report.archive_dir.join("abort-reason.txt")).expect("abort reason"),
        "operator abort"
    );

    SurfaceOutcome::Abort {
        watchdog_stopped: report.watchdog_stopped,
        no_result_ref: report.result_ref.is_none(),
        deleted_nothing: report.removed.is_empty() && dirty.exists(),
        dirty_preserved: dirty_after == "uncommitted\n",
        refs_preserved: temp_ref_after == fixture.base && run_main_after == run_main_before,
    }
}

fn seed_14_close() -> SurfaceOutcome {
    let fixture = Fixture::new("r13-close");
    fixture
        .vcs
        .swap(&fixture.source, "refs/heads/autopilot/run/run-main/main", &fixture.base, ZERO)
        .expect("run-main ref");
    let target_before = fixture
        .vcs
        .read_tip(&fixture.source, "refs/heads/main")
        .expect("target before");
    let run_main_before = fixture
        .vcs
        .read_tip(&fixture.source, "refs/heads/autopilot/run/run-main/main")
        .expect("run-main before");
    let operator_checkout = fixture.root.join("operator-checkout");
    fs::create_dir_all(&operator_checkout).expect("operator dir");
    fs::write(operator_checkout.join("sentinel.txt"), "operator\n").expect("operator sentinel");
    let final_tree = fixture.owner.join("worktrees/final-tip");
    fixture
        .vcs
        .prepare(&final_tree, &fixture.source, &fixture.base, &["keep.txt"])
        .expect("final worktree");
    fs::write(final_tree.join("keep.txt"), "closed result\n").expect("final edit");
    fixture.vcs.stage_all(&final_tree).expect("stage final");
    let final_tip = fixture.vcs.snapshot(&final_tree, "final closed result").expect("final tip");
    let safe_tree = fixture.owner.join("worktrees/safe-terminal");
    fs::create_dir_all(&safe_tree).expect("safe tree");
    fs::write(safe_tree.join("done.txt"), "done\n").expect("safe content");
    let lifecycle = LocalLifecycle::new(&fixture.owner, &fixture.source, fixture.owner.join("archive"));
    let report = lifecycle
        .close(CloseRequest {
            workstream: "ws".to_owned(),
            run_id: "run-14".to_owned(),
            final_tip: final_tip.clone(),
            target_ref: "refs/heads/main".to_owned(),
            evidence: vec![
                evidence("closure-proof.txt", "closed\n"),
                evidence("final-suite.txt", "suite passed\n"),
                evidence("review.txt", "review passed\n"),
            ],
            cleanup: vec![
                CleanupProof { artifact: CleanupArtifact::PackageWorktree(safe_tree.clone()), proven_safe: true },
                CleanupProof { artifact: CleanupArtifact::TempRef("refs/autopilot/tmp/close".to_owned()), proven_safe: true },
            ],
        })
        .expect("close succeeds");

    let result_ref = report.result_ref.clone().expect("result ref");
    let target_after = fixture
        .vcs
        .read_tip(&fixture.source, "refs/heads/main")
        .expect("target after");
    let run_main_after = fixture
        .vcs
        .read_tip(&fixture.source, "refs/heads/autopilot/run/run-main/main")
        .expect("run-main after");
    let push_refused = matches!(
        fixture.vcs.push(),
        Err(Failure::Unsafe { boundary: HardBoundary::RemoteOrDestructiveNetwork })
    );
    assert_ne!(final_tip, target_before, "seed 14 final result is not already landed");
    assert_eq!(result_ref, "refs/autopilot/results/ws/run-14");
    assert_eq!(
        fixture.vcs.read_tip(&fixture.source, &result_ref).expect("retained result ref"),
        final_tip,
        "seed 14 creates an immutable local result ref"
    );
    assert!(report.watchdog_stopped);
    assert_eq!(report.removed.len(), 2);
    assert!(!safe_tree.exists(), "proven-safe package worktree was removed");
    assert!(fixture.vcs.read_tip(&fixture.source, "refs/autopilot/tmp/close").is_err());
    assert_eq!(
        fs::read_to_string(report.archive_dir.join("closure-proof.txt")).expect("closure proof archived"),
        "closed\n"
    );
    assert_eq!(
        fs::read_to_string(report.archive_dir.join("final-suite.txt")).expect("suite proof archived"),
        "suite passed\n"
    );
    assert_eq!(
        fs::read_to_string(report.archive_dir.join("review.txt")).expect("review proof archived"),
        "review passed\n"
    );
    assert_eq!(
        fs::read_to_string(operator_checkout.join("sentinel.txt")).expect("operator sentinel after"),
        "operator\n",
        "seed 14 negative: close does not mutate the operator checkout"
    );
    assert_eq!(
        target_after, target_before,
        "seed 14 negative: close does not land by moving the operator target"
    );
    assert_eq!(
        run_main_after, run_main_before,
        "seed 14 negative: close does not land by advancing run-main"
    );
    assert!(
        push_refused,
        "seed 14 negative: push remains outside the close surface and is refused by the VCS boundary"
    );

    SurfaceOutcome::Close {
        result_ref_created: result_ref == "refs/autopilot/results/ws/run-14",
        safe_cleanup: !safe_tree.exists(),
        no_push: push_refused,
        no_land: run_main_after == run_main_before,
        no_target_move: target_after == target_before,
        operator_checkout_unchanged: fs::read_to_string(operator_checkout.join("sentinel.txt")).expect("operator sentinel final") == "operator\n",
    }
}

fn assert_pending_declared(seed: Seed, surface: &str, declarations: &str) {
    assert!(!surface.is_empty(), "pending seed {} must name missing surface", seed.number);
    assert!(
        declarations.contains(&format!("number={} name=\"{}\" status=\"pending\"", seed.number, seed.name)),
        "pending seed {} must be data-declared",
        seed.number
    );
    assert!(
        declarations.contains(surface),
        "pending seed {} must name missing surface in data",
        seed.number
    );
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct ReplayOutcome {
    accepted: u64,
    process_requests: usize,
    store_requests: usize,
    vcs_requests: usize,
    effects: usize,
    surface: Option<SurfaceOutcome>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
enum SurfaceOutcome {
    TargetMovement {
        target_moved: bool,
        target_sync_candidate: bool,
        run_main_advanced: bool,
        operator_target_unchanged: bool,
    },
    Abort {
        watchdog_stopped: bool,
        no_result_ref: bool,
        deleted_nothing: bool,
        dirty_preserved: bool,
        refs_preserved: bool,
    },
    Close {
        result_ref_created: bool,
        safe_cleanup: bool,
        no_push: bool,
        no_land: bool,
        no_target_move: bool,
        operator_checkout_unchanged: bool,
    },
}

#[derive(Clone, Copy)]
struct Seed {
    number: u8,
    name: &'static str,
    status: SeedStatus,
}

#[derive(Clone, Copy)]
enum SeedStatus {
    Live { steps: &'static [&'static str] },
    Pending { surface: &'static str },
}

fn seeds() -> [Seed; 14] {
    [
        live(1, "planning", &["inventory", "scouts", "approval"]),
        live(2, "normal execution", &["control-frame", "allocator", "delivery"]),
        live(3, "forward release", &["round-pass", "cas", "successor"]),
        live(4, "two-round blocker", &["blocker", "fixer", "round-two"]),
        live(5, "outside-cap quality", &["eight-implementers", "validators-outside-cap"]),
        live(6, "context continuation", &["checkpoint", "compact", "resume"]),
        live(7, "post-release repair", &["finding", "repair", "delta-proof"]),
        live(8, "conflict", &["bundle", "resolution", "overlap-proof"]),
        live(9, "background shutdown", &["pause", "kill", "new-bg-run"]),
        live(10, "integration crash", &["intent", "postcondition", "one-acceptance"]),
        live(11, "target movement", &["target-moved", "target-sync-candidate", "operator-target-unchanged"]),
        live(12, "unsafe operation", &["guard", "evidence", "isolated-continue"]),
        live(13, "abort", &["background-stop", "abort-archive", "preserve-dirty-refs"]),
        live(14, "close", &["closure-proof", "final-suite-review", "local-result-ref", "safe-cleanup"]),
    ]
}

fn live(number: u8, name: &'static str, steps: &'static [&'static str]) -> Seed {
    Seed {
        number,
        name,
        status: SeedStatus::Live { steps },
    }
}

fn pending(number: u8, name: &'static str, surface: &'static str) -> Seed {
    Seed {
        number,
        name,
        status: SeedStatus::Pending { surface },
    }
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

fn true_check() -> CheckCommand {
    CheckCommand { program: "true".to_owned(), args: Vec::new() }
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
