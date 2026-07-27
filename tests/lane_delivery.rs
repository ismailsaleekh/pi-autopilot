use std::{
    fs,
    path::{Path, PathBuf},
};

use drivers::allocation::{
    AllocationPolicy, AllocationSubmission, ApprovedUnit, validate_allocation,
};
use drivers::dispatch::{DispatchInput, LaneReadiness, launch_lanes, select_ready_lanes};
use drivers::runner::{
    DeliveryExpectation, DeliveryRejection, RunnerAssignment, accept_delivery,
    package_delivery_commit, refuse_agent_git_mutation,
};
use drivers::{sim::SimPlatform, vcs::GitVcs};
use kernel::generated::{
    DeliveryResult, DeliveryTerminalStatus, Id, ModeId, Path as ContractPath, Ref, Sha,
};
use kernel::schedule::ResourceFacts;

#[test]
fn lane_launch_uses_recorded_tip_at_dispatch_and_package_owned_commit_delivers() {
    let fixture = fixture("real-lane-commit");
    let vcs = GitVcs::new(&fixture.root);
    let source = fixture.root.join("source");
    let old_tip = vcs.init_fixture(&source).expect("seed repo");
    fs::write(source.join("keep.txt"), "updated before launch\n").expect("source edit");
    let new_tip = commit(&vcs, &source, "new integration tip");
    assert_ne!(old_tip, new_tip);

    let allocation = validate_allocation(
        &units(),
        &submission(),
        AllocationPolicy {
            parallel_cap: 8,
            active_implementers: 0,
        },
    )
    .expect("allocation valid");
    let selected = select_ready_lanes(&DispatchInput {
        lanes: allocation.lanes,
        readiness: vec![ready("l1"), ready("l2"), ready("l3")],
        active_implementers: 0,
        parallel_cap: 8,
        resources: resources(),
    });
    let launches = launch_lanes(
        &vcs,
        &source,
        &fixture.root.join("worktrees"),
        "HEAD",
        &selected[0..1],
        &["keep.txt"],
    )
    .expect("launch lane");
    assert_eq!(
        launches[0].base_commit, new_tip,
        "worktree ancestry is current tip at launch"
    );
    assert_eq!(
        vcs.read_tip(&launches[0].worktree, "HEAD")
            .expect("read launch tip"),
        new_tip
    );

    fs::write(launches[0].worktree.join("keep.txt"), "lane edit\n").expect("lane edit");
    let package_commit = package_delivery_commit(&vcs, &launches[0].worktree, "package delivery")
        .expect("package commit");
    let package_tree = Sha(
        vcs.read_tip(&launches[0].worktree, "HEAD^{tree}")
            .expect("read package tree"),
    );
    assert_eq!(
        vcs.read_tip(&launches[0].worktree, "HEAD")
            .expect("read package tip"),
        package_commit.0
    );

    let expected = expectation(&launches[0].worktree, &Sha(new_tip), 1);
    let accepted = accept_delivery(
        &[delivery(
            &expected,
            Some(package_commit.clone()),
            Some(package_tree.clone()),
        )],
        &expected,
    )
    .expect("delivery accepted");
    assert_eq!(accepted.package_commit, package_commit);
    assert_eq!(accepted.package_tree, package_tree);
    assert_eq!(accepted.changed_paths, vec!["keep.txt".to_owned()]);
}

#[test]
fn agent_git_mutation_and_incomplete_delivery_are_refused_without_side_effects() {
    let fixture = fixture("negative-delivery");
    let vcs = GitVcs::new(&fixture.root);
    let source = fixture.root.join("source");
    let tip = Sha(vcs.init_fixture(&source).expect("seed repo"));
    let before = vcs.read_tip(&source, "HEAD").expect("read source tip");
    assert_eq!(
        refuse_agent_git_mutation(&vcs),
        Err(DeliveryRejection::AgentGitMutation)
    );
    assert_eq!(
        vcs.read_tip(&source, "HEAD").expect("read source tip"),
        before,
        "refused agent mutation changed nothing"
    );

    let worktree = fixture.root.join("worktree");
    let expected = expectation(&worktree, &tip, 2);
    let missing_commit = delivery(&expected, None, Some(Sha("tree".to_owned())));
    assert_eq!(
        accept_delivery(&[missing_commit], &expected),
        Err(DeliveryRejection::MissingPackageCommit)
    );
    assert_eq!(
        vcs.read_tip(&source, "HEAD").expect("read source tip"),
        before,
        "bad delivery mutated nothing"
    );

    let mut missing_evidence = delivery(
        &expected,
        Some(Sha("commit".to_owned())),
        Some(Sha("tree".to_owned())),
    );
    missing_evidence.focused_evidence_refs = vec![Ref("evidence:one".to_owned())];
    assert_eq!(
        accept_delivery(&[missing_evidence], &expected),
        Err(DeliveryRejection::MissingFocusedEvidence)
    );
    assert_eq!(
        vcs.read_tip(&source, "HEAD").expect("read source tip"),
        before,
        "incomplete evidence mutated nothing"
    );

    let runner = RunnerAssignment {
        action_id: id("action"),
        assignment_id: expected.assignment_id.clone(),
        role_id: expected.role_id.clone(),
        mode: expected.mode.clone(),
        run_revision: expected.run_revision,
        lane_id: expected.lane_id.clone(),
        attempt: expected.attempt,
        base_commit: expected.base_commit.clone(),
        worktree,
        session_file: fixture.root.join("session.json"),
        roster_assignment: "openai-codex/gpt-subscription".to_owned(),
    };
    let action = drivers::runner::bg_action(&runner);
    assert!(action.command_bytes.0.contains("autopilot-agent-run"));
    assert!(action.command_bytes.0.contains("--no-auto-compact"));
    assert!(action.is_agent);
}

fn delivery(
    expected: &DeliveryExpectation,
    commit: Option<Sha>,
    tree: Option<Sha>,
) -> DeliveryResult {
    DeliveryResult {
        assignment_id: expected.assignment_id.clone(),
        role_id: expected.role_id.clone(),
        mode: expected.mode.clone(),
        run_revision: expected.run_revision,
        lane_id: expected.lane_id.clone(),
        attempt: expected.attempt,
        base_commit: expected.base_commit.clone(),
        worktree: ContractPath(expected.worktree.display().to_string()),
        package_commit: commit,
        package_tree: tree,
        actual_changed_paths: vec![ContractPath("keep.txt".to_owned())],
        execution_audit_ref: Ref("audit:1".to_owned()),
        focused_evidence_refs: vec![Ref("evidence:1".to_owned()), Ref("evidence:2".to_owned())],
        terminal_status: DeliveryTerminalStatus("done".to_owned()),
        hard_boundary_violations: Vec::new(),
    }
}

fn expectation(
    worktree: &Path,
    base: &Sha,
    required_focused_evidence: usize,
) -> DeliveryExpectation {
    DeliveryExpectation {
        assignment_id: id("assignment"),
        role_id: id("implementer"),
        mode: ModeId("lane-delivery".to_owned()),
        run_revision: 7,
        lane_id: id("l1"),
        attempt: 1,
        base_commit: base.clone(),
        worktree: worktree.to_path_buf(),
        required_focused_evidence,
    }
}

fn submission() -> AllocationSubmission {
    AllocationSubmission {
        lanes: vec![
            lane("l1", &["u1"], 0),
            lane("l2", &["u2"], 1),
            lane("l3", &["u3"], 2),
        ],
        future_units: Vec::new(),
        authority_echo: units(),
        ownership_claims: Vec::new(),
        overlap_blocks: Vec::new(),
    }
}

fn units() -> Vec<ApprovedUnit> {
    vec![
        unit("u1", 1, &[]),
        unit("u2", 2, &["u1"]),
        unit("u3", 3, &["u2"]),
    ]
}

fn unit(name: &str, order: u32, deps: &[&str]) -> ApprovedUnit {
    ApprovedUnit {
        id: id(name),
        operator_order: order,
        decisions: Vec::new(),
        criteria: vec![id(&format!("criterion-{name}"))],
        dependencies: ids(deps),
        predecessor_forward_criteria: if name == "u1" {
            Vec::new()
        } else {
            vec![id(&format!("fg-{name}"))]
        },
        downstream_release_edges: vec![id(&format!("edge-{name}"))],
    }
}

fn lane(name: &str, unit_ids: &[&str], wave: u32) -> kernel::generated::AllocationLaneProposal {
    let gates = unit_ids
        .iter()
        .filter(|unit| **unit != "u1")
        .map(|unit| id(&format!("fg-{unit}")))
        .collect();
    let edges = unit_ids
        .iter()
        .map(|unit| id(&format!("edge-{unit}")))
        .collect();
    kernel::generated::AllocationLaneProposal {
        lane_id: id(name),
        objective: name.to_owned(),
        ordered_unit_ids: ids(unit_ids),
        rationale: "cohesive".to_owned(),
        delivery_boundary: kernel::generated::DeliveryBoundary("terminal".to_owned()),
        predecessor_forward_criteria: gates,
        downstream_release_edges: edges,
        context_family_id: id("ctx"),
        context_estimate: 100,
        focused_tests: vec![kernel::generated::TestId("focused".to_owned())],
        launch_wave: wave,
        continue_existing_logical_lane: None,
    }
}

fn ready(name: &str) -> LaneReadiness {
    LaneReadiness {
        lane_id: id(name),
        predecessor_gates_met: true,
        blockers_clear: true,
        unit_free: true,
        route_ready: true,
        preflight_passed: true,
        pressure_delay: true,
    }
}

fn resources() -> ResourceFacts {
    ResourceFacts {
        free_storage_bytes: 20 * 1024 * 1024 * 1024,
        projected_storage_bytes: 1,
        available_memory_bytes: 8 * 1024 * 1024 * 1024,
        physical_memory_bytes: 16 * 1024 * 1024 * 1024,
    }
}

fn commit(vcs: &GitVcs, path: &Path, message: &str) -> String {
    vcs.stage_all(path).expect("stage");
    vcs.snapshot(path, message).expect("commit")
}

fn ids(values: &[&str]) -> Vec<Id> {
    values.iter().map(|value| id(value)).collect()
}

fn id(value: &str) -> Id {
    Id(value.to_owned())
}

struct Fixture {
    root: PathBuf,
}

fn fixture(name: &str) -> Fixture {
    let mut platform = SimPlatform::new(0xfeed_beef);
    platform.advance(name.len() as u64);
    let tick = kernel::platform::Platform::clock(&platform).read().0;
    let root = std::env::temp_dir().join(format!("pi-autopilot-{name}-{tick}"));
    if root.exists() {
        fs::remove_dir_all(&root).expect("clean fixture root");
    }
    fs::create_dir_all(&root).expect("fixture root");
    Fixture { root }
}
