use std::{fs, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};

use drivers::{
    validation::{
        decide_forward_round, result, select_forward_commands, submit_validation_verdict,
        CommandSpec, ForwardDecision, ForwardRound, RequiredCriterion, BOUNDARY_ID,
    },
    vcs::GitVcs,
};
use kernel::{
    boundary::{boundary_by_id, BoundaryMode, Producer},
    generated::{CriterionResult, CriterionVerdict, ForwardVerdict, Id, Path as CoveredPath, Sha, ValidationScope, ValidationVerdict},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
const ZERO: &str = "0000000000000000000000000000000000000000";

#[test]
fn validation_boundary_is_a_registered_model_boundary() {
    let descriptor = boundary_by_id(BOUNDARY_ID).expect("validation boundary registered");
    assert_eq!(descriptor.producer(), Producer::Model);
    // Mode is a lifecycle position, not an invariant: a Model boundary starts in Record
    // and is flipped one-way to Enforce once a real transcript exists (D79 4). Pinning
    // Record here would make that flip fail this test. A2 (boundary_coverage) enforces
    // the real rule: an Enforce boundary must have a recorded real-model transcript.
    assert!(matches!(
        descriptor.mode(),
        BoundaryMode::Record | BoundaryMode::Enforce
    ));
    let accepted = submit_validation_verdict(verdict(ForwardVerdict::FORWARDREADY, vec![pass("c1")]))
        .expect("well-formed verdict accepted in either mode");
    assert_eq!(accepted.validation_scope.0, "forward");
}

#[test]
fn round_one_pass_releases() {
    let decision = decide_forward_round(
        ForwardRound::One,
        &[required("c1")],
        &verdict(ForwardVerdict::FORWARDREADY, vec![pass("c1")]),
        &[],
    )
    .expect("round one ready");
    assert_eq!(decision, ForwardDecision::Release);
}

#[test]
fn round_one_blocker_gets_one_consolidated_fixer_then_round_two() {
    let first = decide_forward_round(
        ForwardRound::One,
        &[required("c1"), required("c2")],
        &verdict(
            ForwardVerdict::FORWARDBLOCKED,
            vec![fail("c1"), blocked("c2")],
        ),
        &[],
    )
    .expect("round one blocker routed");
    assert_eq!(
        first,
        ForwardDecision::ConsolidatedFixer {
            blocker_ids: vec![Id("c1".to_owned()), Id("c2".to_owned())]
        }
    );

    let second = decide_forward_round(
        ForwardRound::Two,
        &[required("c1"), required("c2")],
        &verdict(ForwardVerdict::FORWARDREADY, vec![pass("c1"), pass("c2")]),
        &[],
    )
    .expect("round two ready");
    assert_eq!(second, ForwardDecision::Release);
}

#[test]
fn round_two_remaining_blocker_routes_tier23_and_ref_stays_put() {
    let root = temp_root("round-two-no-merge");
    let source = root.join("repo");
    let vcs = GitVcs::new(&root);
    let old_tip = vcs.init_fixture(&source).expect("seed repo");
    vcs.swap(&source, "refs/autopilot/run-main", &old_tip, ZERO)
        .expect("run-main ref");

    let decision = decide_forward_round(
        ForwardRound::Two,
        &[required("c1")],
        &verdict(ForwardVerdict::FORWARDBLOCKED, vec![fail("c1")]),
        &[],
    )
    .expect("round two blocker routed");
    assert_eq!(
        decision,
        ForwardDecision::Tier23 {
            blocker_ids: vec![Id("c1".to_owned())]
        }
    );
    let after = vcs
        .read_tip(&source, "refs/autopilot/run-main")
        .expect("read run-main");
    assert_eq!(after, old_tip, "round 2 blocker must not auto-merge");
}

#[test]
fn overall_pass_with_unverdicted_required_criterion_is_rejected() {
    let error = decide_forward_round(
        ForwardRound::One,
        &[required("c1"), required("c2")],
        &verdict(ForwardVerdict::FORWARDREADY, vec![pass("c1")]),
        &[],
    )
    .expect_err("FORWARD_READY cannot hide an unverdicted required criterion");
    assert!(format!("{error:?}").contains("MissingCriterion"));
}

#[test]
fn command_selection_deduplicates_by_exact_tuple() {
    let command = CommandSpec {
        command: "cargo test --test forward_two_rounds".to_owned(),
        cwd: "packages/pi-autopilot".to_owned(),
        env_profile: "rust".to_owned(),
        commit: "abc".to_owned(),
    };
    let duplicate = CommandSpec {
        command: "cargo test --test forward_two_rounds".to_owned(),
        cwd: "packages/pi-autopilot".to_owned(),
        env_profile: "rust".to_owned(),
        commit: "abc".to_owned(),
    };
    let selected = select_forward_commands(&[command], &[duplicate]).expect("table-backed selection");
    assert_eq!(selected.len(), 1);
}

fn required(id: &str) -> RequiredCriterion {
    RequiredCriterion {
        id: Id(id.to_owned()),
        covered_paths: vec![CoveredPath(format!("src/{id}.rs"))],
        semantic_surface_ids: vec![Id(format!("surface-{id}"))],
        forward_edge_ids: vec![Id(format!("edge-{id}"))],
    }
}

fn pass(id: &str) -> CriterionResult {
    result(id, CriterionVerdict::PASS, "ev", &format!("src/{id}.rs"), &format!("surface-{id}"), &format!("edge-{id}"))
}

fn fail(id: &str) -> CriterionResult {
    result(id, CriterionVerdict::FAIL, "ev", &format!("src/{id}.rs"), &format!("surface-{id}"), &format!("edge-{id}"))
}

fn blocked(id: &str) -> CriterionResult {
    result(id, CriterionVerdict::BLOCKED, "ev", &format!("src/{id}.rs"), &format!("surface-{id}"), &format!("edge-{id}"))
}

fn verdict(forward_verdict: ForwardVerdict, criterion_results: Vec<CriterionResult>) -> ValidationVerdict {
    ValidationVerdict {
        assignment_id: Id("validator-a".to_owned()),
        validation_scope: ValidationScope("forward".to_owned()),
        exact_commit: Sha("commit".to_owned()),
        exact_tree: Sha("tree".to_owned()),
        forward_verdict: Some(forward_verdict),
        closure_verdict: None,
        criterion_results,
        finding_refs: Vec::new(),
    }
}

fn temp_root(name: &str) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("autopilot-{name}-{}-{n}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    root
}
