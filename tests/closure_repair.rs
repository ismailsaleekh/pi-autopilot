use std::{fs, path::PathBuf};

use drivers::{
    closure::{
        Criterion, CriterionObservation, DeepValidationBundle, FindingEffect, MaterialFinding,
        RepairLedger, RepairPolicy, RepairRouting, Verdict, criteria_for_delta,
    },
    repair::{
        CommitId, ForwardEdge, ReleasedContractChange, RepairMergeRequest, RepairWorktree,
        plan_repair_merge, route_released_contract_change,
    },
    sim::SimPlatform,
    vcs::GitVcs,
};
use kernel::failure::{Failure, OperatorDecision, RecoveryRoute};

#[test]
fn deep_validation_emits_one_bundle_and_delta_revalidates_only_affected_criteria() {
    let criteria = criteria();
    let bundle = DeepValidationBundle::build(
        "commit-a",
        &criteria,
        vec![
            observation("c-api", Verdict::Pass, vec![]),
            observation(
                "c-db",
                Verdict::Fail,
                vec![finding("normalized-db-failure", "log-a")],
            ),
            observation("c-ui", Verdict::Blocked, vec![]),
        ],
    )
    .expect("one bundle is accepted");

    assert_eq!(bundle.criteria.len(), 3, "all criteria are in the one bundle");
    assert_eq!(bundle.ledger.len(), 1, "findings are ledgered inside that bundle");
    assert_eq!(bundle.material_findings()[0].normalized, "normalized-db-failure");

    let delta = criteria_for_delta(
        &criteria,
        &["src/db.rs".to_owned()],
        &[],
        &["c-ui".to_owned()],
    );
    assert_eq!(delta, vec!["c-db".to_owned(), "c-ui".to_owned()]);
    assert!(!delta.contains(&"c-api".to_owned()), "unchanged current evidence is reused");
}

#[test]
fn same_material_finding_after_two_attempts_routes_tier2_and_budget_exhaustion_pauses() {
    let criteria = criteria();
    let first = failing_bundle(&criteria, "log-a");
    let second = failing_bundle(&criteria, "log-a");
    let mut ledger = RepairLedger::new(RepairPolicy {
        max_attempts: 5,
        tier2_after_survivals: 2,
    });

    assert_eq!(ledger.record_fix_attempt(&first), RepairRouting::Continue);
    assert_eq!(
        ledger.record_fix_attempt(&second),
        RepairRouting::Failure(Failure::Recoverable {
            route: RecoveryRoute::Tier2,
        }),
        "the second surviving normalized finding routes Tier 2 instead of looping"
    );

    let mut exhausted = RepairLedger::new(RepairPolicy {
        max_attempts: 1,
        tier2_after_survivals: 9,
    });
    assert_eq!(exhausted.record_fix_attempt(&first), RepairRouting::Continue);
    assert_eq!(
        exhausted.record_fix_attempt(&failing_bundle(&criteria, "log-b")),
        RepairRouting::Failure(Failure::Paused {
            needs: OperatorDecision::ChooseAfterExhaustion,
        }),
        "exhausted repair budget pauses rather than silently giving up"
    );
}

#[test]
fn released_contract_change_invalidates_affected_edges_without_silent_downstream_change() {
    let plan = route_released_contract_change(
        &[
            edge("edge-open", &["api"], false),
            edge("edge-merged", &["api"], true),
            edge("edge-other", &["ui"], true),
        ],
        &ReleasedContractChange {
            changed_surfaces: vec!["api".to_owned()],
            replacement_contract_id: "contract-v2".to_owned(),
        },
    );

    assert_eq!(
        plan.invalidated_edges,
        vec!["edge-open".to_owned(), "edge-merged".to_owned()]
    );
    assert_eq!(plan.stale_evidence, vec!["ev-edge-merged".to_owned()]);
    assert_eq!(plan.local_amendments, vec!["crit-edge-merged".to_owned()]);
    assert!(plan.every_affected_edge_has_action());
    assert_eq!(plan.unchanged_assumptions, vec!["edge-other".to_owned()]);
}

#[test]
fn repair_merge_uses_throwaway_repo_and_integrates_only_new_repair_commits() {
    let fixture = fixture("closure-repair-merge");
    let vcs = GitVcs::new(&fixture.root);
    let source = fixture.root.join("source");
    let run_main = vcs.init_fixture(&source).expect("seed repository");
    let repair_root = fixture.root.join("repair-worktree");
    let repair = RepairWorktree::new(&vcs);
    repair
        .prepare_from_run_main(&repair_root, &source, "HEAD", &["keep.txt"])
        .expect("prepare repair worktree from current run-main");

    fs::write(repair_root.join("keep.txt"), "cohesive repair\n").expect("repair edit");
    let repair_commit = repair
        .commit_repair(&repair_root, "post-release repair")
        .expect("package repair commit");
    assert_ne!(repair_commit.0, run_main);

    let plan = plan_repair_merge(RepairMergeRequest {
        run_main: CommitId(run_main.clone()),
        repair_base: CommitId(run_main.clone()),
        repair_commits: vec![repair_commit.clone()],
        original_lane_commits: vec![CommitId("old-lane-delivery".to_owned())],
    })
    .expect("repair merge plan");
    assert_eq!(plan.base, CommitId(run_main));
    assert_eq!(plan.commits_to_integrate, vec![repair_commit]);

    let repeat_lane = plan_repair_merge(RepairMergeRequest {
        run_main: CommitId("main".to_owned()),
        repair_base: CommitId("main".to_owned()),
        repair_commits: vec![CommitId("lane".to_owned())],
        original_lane_commits: vec![CommitId("lane".to_owned())],
    });
    assert!(repeat_lane.is_err(), "original lane commits are never merged twice");
}

fn criteria() -> Vec<Criterion> {
    vec![
        criterion("c-api", &["src/api.rs"], &["api"]),
        criterion("c-db", &["src/db.rs"], &["storage"]),
        criterion("c-ui", &["src/ui.rs"], &["ui"]),
    ]
}

fn criterion(id: &str, paths: &[&str], surfaces: &[&str]) -> Criterion {
    Criterion {
        id: id.to_owned(),
        paths: strings(paths),
        surfaces: strings(surfaces),
        witness_ids: vec![format!("wit-{id}")],
    }
}

fn observation(
    criterion_id: &str,
    verdict: Verdict,
    findings: Vec<MaterialFinding>,
) -> CriterionObservation {
    CriterionObservation {
        criterion_id: criterion_id.to_owned(),
        verdict,
        findings,
        evidence_id: format!("ev-{criterion_id}"),
    }
}

fn finding(normalized: &str, marker: &str) -> MaterialFinding {
    MaterialFinding {
        normalized: normalized.to_owned(),
        effect: FindingEffect::ClosureBlocking,
        evidence_marker: marker.to_owned(),
    }
}

fn failing_bundle(criteria: &[Criterion], marker: &str) -> DeepValidationBundle {
    DeepValidationBundle::build(
        "commit-a",
        criteria,
        vec![
            observation("c-api", Verdict::Pass, vec![]),
            observation(
                "c-db",
                Verdict::Fail,
                vec![finding("normalized-db-failure", marker)],
            ),
            observation("c-ui", Verdict::Pass, vec![]),
        ],
    )
    .expect("failing bundle")
}

fn edge(id: &str, surfaces: &[&str], merged: bool) -> ForwardEdge {
    ForwardEdge {
        id: id.to_owned(),
        contract_surfaces: strings(surfaces),
        dependent_merged: merged,
        dependent_work_id: format!("work-{id}"),
        criteria_ids: vec![format!("crit-{id}")],
        evidence_ids: vec![format!("ev-{id}")],
    }
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

struct Fixture {
    root: PathBuf,
}

fn fixture(name: &str) -> Fixture {
    let mut platform = SimPlatform::new(0x6_2);
    platform.advance(name.len() as u64);
    let tick = kernel::platform::Platform::clock(&platform).read().0;
    let root = std::env::temp_dir().join(format!("pi-autopilot-{name}-{tick}"));
    if root.exists() {
        fs::remove_dir_all(&root).expect("clean fixture root");
    }
    fs::create_dir_all(&root).expect("fixture root");
    Fixture { root }
}
