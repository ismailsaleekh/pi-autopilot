#![allow(clippy::disallowed_types)]

use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Mutex, OnceLock},
};

use drivers::allocation::{
    AllocationPolicy, AllocationSubmission, ApprovedUnit, validate_allocation,
};
use drivers::dispatch::{DispatchInput, LaneReadiness, launch_lanes, select_ready_lanes};
use drivers::runner::{
    self, DeliveryExpectation, DeliveryRejection, PackageFacts, RunnerAssignment,
    RunnerTransportFacts, accept_delivery, accept_delivery_with_package_facts,
    delivery_bg_action_with_facts, delivery_issue_with_facts, establish_delivery_package,
    package_delivery_commit, refuse_agent_git_mutation,
};
use drivers::{sim::SimPlatform, vcs::GitVcs};
use kernel::generated::{
    CoreToHostSpawnPayload, DeliveryResult, DeliveryTerminalStatus, Id, ModeId,
    Path as ContractPath, Ref, SeamEnvelope, Sha,
};
use kernel::schedule::ResourceFacts;
use sha2::{Digest as ShaDigest, Sha256};

static CWD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

struct CwdGuard {
    previous: PathBuf,
}

impl CwdGuard {
    fn enter(path: &Path) -> Self {
        let previous = std::env::current_dir().expect("current dir");
        std::env::set_current_dir(path).expect("set current dir");
        Self { previous }
    }
}

impl Drop for CwdGuard {
    fn drop(&mut self) {
        std::env::set_current_dir(&self.previous).expect("restore current dir");
    }
}

#[test]
fn lane_delivery_launch_uses_recorded_tip_at_dispatch_and_package_owned_commit_delivers() {
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
    let package_tree = Sha(vcs
        .read_tip(&launches[0].worktree, "HEAD^{tree}")
        .expect("read package tree"));
    assert_eq!(
        vcs.read_tip(&launches[0].worktree, "HEAD")
            .expect("read package tip"),
        package_commit.0
    );

    let expected = expectation(&launches[0].worktree, &Sha(new_tip), 1);
    let runtime_facts = PackageFacts {
        package_commit: package_commit.clone(),
        package_tree: package_tree.clone(),
    };
    let model_shaped = delivery(&expected, None, None);
    let runtime_accepted =
        accept_delivery_with_package_facts(&[model_shaped], &expected, &runtime_facts)
            .expect("model-shaped delivery accepted with runtime package facts");
    assert_eq!(runtime_accepted.package_commit, package_commit);
    assert_eq!(runtime_accepted.package_tree, package_tree);
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

    let forged_commit = delivery(
        &expected,
        Some(Sha("0000000000000000000000000000000000000000".to_owned())),
        Some(package_tree.clone()),
    );
    assert_eq!(
        accept_delivery(&[forged_commit], &expected),
        Err(DeliveryRejection::GitState)
    );
    let mut forged_tree = delivery(
        &expected,
        Some(package_commit.clone()),
        Some(Sha("0000000000000000000000000000000000000000".to_owned())),
    );
    assert_eq!(
        accept_delivery(&[forged_tree.clone()], &expected),
        Err(DeliveryRejection::GitState)
    );
    forged_tree.package_tree = Some(package_tree);
    forged_tree.actual_changed_paths = vec![ContractPath("forged.rs".to_owned())];
    assert_eq!(
        accept_delivery(&[forged_tree], &expected),
        Err(DeliveryRejection::GitState)
    );
}

#[test]
fn lane_delivery_rejects_tracked_dirty_runner_artifact_but_tolerates_untracked_residue() {
    let fixture = fixture("tracked-runner-residue");
    let vcs = GitVcs::new(&fixture.root);
    let source = fixture.root.join("source");
    vcs.init_fixture(&source).expect("seed repo");
    fs::create_dir_all(source.join(".pi/autopilot/runner")).expect("runner dir");
    fs::write(
        source.join(".pi/autopilot/runner/tracked.txt"),
        "tracked at base\n",
    )
    .expect("tracked runner seed");
    let base = Sha(commit(&vcs, &source, "seed tracked runner artifact"));

    let worktree = fixture.root.join("worktree");
    vcs.prepare(
        &worktree,
        &source,
        &base.0,
        &["keep.txt", ".pi/autopilot/runner/tracked.txt"],
    )
    .expect("runner worktree");
    let worktree = fs::canonicalize(&worktree).expect("canonical worktree");
    fs::write(worktree.join("keep.txt"), "lane edit\n").expect("lane edit");
    let package_commit =
        package_delivery_commit(&vcs, &worktree, "package delivery").expect("package commit");
    let package_tree = Sha(vcs
        .read_tip(&worktree, "HEAD^{tree}")
        .expect("read package tree"));
    fs::write(
        worktree.join(".pi/autopilot/runner/tracked.txt"),
        "dirty tracked runner artifact\n",
    )
    .expect("dirty tracked runner artifact");
    fs::create_dir_all(worktree.join(".pi/autopilot/runner/carriers")).expect("carrier dir");
    fs::write(
        worktree.join(".pi/autopilot/runner/carriers/c.json"),
        "{}\n",
    )
    .expect("untracked runner residue");

    let expected = expectation(&worktree, &base, 2);
    let package = PackageFacts {
        package_commit: package_commit.clone(),
        package_tree: package_tree.clone(),
    };
    assert_eq!(
        accept_delivery_with_package_facts(&[delivery(&expected, None, None)], &expected, &package),
        Err(DeliveryRejection::GitState),
        "tracked runner artifact modifications must block delivery"
    );

    git_run(
        &worktree,
        &["checkout", "--", ".pi/autopilot/runner/tracked.txt"],
    );
    let accepted = accept_delivery_with_package_facts(
        &[delivery(&expected, None, None)],
        &expected,
        &PackageFacts {
            package_commit,
            package_tree,
        },
    )
    .expect("untracked runner residue is tolerated");
    assert_eq!(accepted.changed_paths, vec!["keep.txt".to_owned()]);
}

#[test]
fn lane_delivery_packages_quoted_unicode_space_and_nested_paths_exactly() {
    let fixture = fixture("unicode-delivery-paths");
    let vcs = GitVcs::new(&fixture.root);
    let source = fixture.root.join("source");
    let base = Sha(vcs.init_fixture(&source).expect("seed repo"));
    let worktree = fixture.root.join("worktree");
    let claimed = vec![
        "docs/file with spaces.txt".to_owned(),
        "docs/unicodé-☃.txt".to_owned(),
        "nested/deep/plain.txt".to_owned(),
        "docs/quote\"file.txt".to_owned(),
    ];
    let profile = claimed.iter().map(String::as_str).collect::<Vec<_>>();
    vcs.prepare(&worktree, &source, &base.0, &profile)
        .expect("runner worktree");
    let worktree = fs::canonicalize(&worktree).expect("canonical worktree");
    for path in &claimed {
        let full = worktree.join(path);
        fs::create_dir_all(full.parent().expect("claimed parent")).expect("claimed dir");
        fs::write(&full, format!("content for {path}\n")).expect("claimed file");
    }

    let expected = expectation(&worktree, &base, 2);
    let mut result = delivery(&expected, None, None);
    result.actual_changed_paths = claimed.iter().cloned().map(ContractPath).collect();
    let package = establish_delivery_package(&result, &expected).expect("runtime package");
    let accepted = accept_delivery_with_package_facts(&[result], &expected, &package)
        .expect("delivery accepted");
    let mut actual = accepted.changed_paths;
    let mut expected_paths = claimed;
    actual.sort();
    expected_paths.sort();
    assert_eq!(actual, expected_paths);
}

#[test]
fn lane_delivery_agent_git_mutation_and_incomplete_delivery_are_refused_without_side_effects() {
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
    let model_shaped_delivery = delivery(&expected, None, None);
    let package = PackageFacts {
        package_commit: tip.clone(),
        package_tree: Sha(vcs.read_tip(&source, "HEAD^{tree}").expect("source tree")),
    };
    assert_eq!(
        accept_delivery_with_package_facts(&[model_shaped_delivery], &expected, &package),
        Err(DeliveryRejection::GitState)
    );
    assert_eq!(
        vcs.read_tip(&source, "HEAD").expect("read source tip"),
        before,
        "bad delivery mutated nothing"
    );

    let mut missing_evidence = delivery(&expected, None, None);
    missing_evidence.focused_evidence_refs = vec![Ref("evidence:one".to_owned())];
    assert_eq!(
        accept_delivery_with_package_facts(&[missing_evidence], &expected, &package),
        Err(DeliveryRejection::MissingFocusedEvidence)
    );
    assert_eq!(
        vcs.read_tip(&source, "HEAD").expect("read source tip"),
        before,
        "incomplete evidence mutated nothing"
    );

    vcs.prepare(&worktree, &source, &tip.0, &["keep.txt"])
        .expect("runner delivery worktree");
    let worktree = fs::canonicalize(&worktree).expect("canonical runner worktree");
    let mut scoped_unit = unit("l1", 1, &[]);
    scoped_unit.objective = "deliver literal `````` backtick text safely".to_owned();
    let runner = RunnerAssignment {
        workstream: id("main"),
        action_id: id("action-main-l1"),
        assignment_id: id("assignment-main-l1"),
        role_id: expected.role_id.clone(),
        mode: expected.mode.clone(),
        run_revision: expected.run_revision,
        lane_id: id("l1"),
        attempt: expected.attempt,
        base_commit: expected.base_commit.clone(),
        worktree: worktree.clone(),
        session_file: fixture.root.join("session.json"),
        roster_assignment: "openai-codex/gpt-subscription".to_owned(),
        approved_units: vec![scoped_unit],
    };
    let node = fixture.root.join("node");
    let wrapper = fixture.root.join("bin/autopilot-agent-run.mjs");
    fs::write(&node, "node\n").expect("fake node");
    fs::create_dir_all(wrapper.parent().expect("wrapper parent")).expect("wrapper dir");
    fs::write(&wrapper, "runner\n").expect("fake wrapper");
    let facts = RunnerTransportFacts::new(node, wrapper).expect("facts");
    unsafe {
        std::env::set_var(
            "AUTOPILOT_CHILD_ADDON_PATH",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
        );
    }
    let _cwd_lock = CWD_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let _cwd = CwdGuard::enter(&fixture.root);
    let issue = delivery_issue_with_facts(&runner, &facts).expect("runner issue");
    let action = delivery_bg_action_with_facts(&runner, &facts).expect("runner action");
    assert!(action.bg_run.command.0.contains(" --spec "));
    assert!(action.bg_run.is_agent);
    assert_eq!(issue.binding.worktree.as_deref(), runner.worktree.to_str());
    let spec: serde_json::Value =
        serde_json::from_slice(&fs::read(&issue.binding.spec_path).expect("runner spec"))
            .expect("spec json");
    assert_eq!(
        spec["cwd"].as_str().expect("cwd"),
        runner.worktree.to_str().expect("worktree utf8")
    );
    assert_eq!(
        spec["worktree"].as_str().expect("worktree"),
        runner.worktree.to_str().expect("worktree utf8")
    );
    assert_eq!(spec["lane_id"], "l1");
    assert_eq!(spec["attempt"], expected.attempt);
    let assignment_path = spec["assignment_path"].as_str().expect("assignment path");
    let assignment_bytes = fs::read(assignment_path).expect("assignment artifact");
    assert_eq!(
        sha256_hex(&assignment_bytes),
        spec["assignment_digest"].as_str().unwrap()
    );
    let assignment_json: serde_json::Value =
        serde_json::from_slice(&assignment_bytes).expect("assignment json");
    assert_eq!(
        assignment_json["schema"],
        "autopilot.delivery_assignment.v1"
    );
    assert_eq!(
        assignment_json["ordered_units"][0]["files"],
        serde_json::json!(["keep.txt"])
    );
    let delivered_command = &assignment_json["ordered_units"][0]["commands"][0];
    assert_eq!(delivered_command["command"], "cargo test -q");
    assert_eq!(delivered_command["effect"], "no-effect");
    assert_eq!(delivered_command["generated_paths"], serde_json::json!([]));
    assert_eq!(delivered_command["handling"], "none");
    assert_eq!(
        delivered_command["scope_preservation"],
        "Final Git-visible state remains limited to the approved unit files."
    );
    let prompt = fs::read_to_string(spec["prompt_path"].as_str().expect("prompt")).expect("prompt");
    assert!(
        prompt.contains("```````json autopilot.delivery_assignment.v1"),
        "{prompt}"
    );
    assert!(
        prompt.contains("Verification command effect authority is binding"),
        "{prompt}"
    );
    fs::write(assignment_path, b"{\"schema\":\"drift\"}").expect("assignment tamper");
    let collision =
        delivery_issue_with_facts(&runner, &facts).expect_err("assignment collision must fail");
    assert!(
        collision
            .to_string()
            .contains("create-once artifact collision"),
        "{collision}"
    );
}

#[test]
fn lane_delivery_core_stdout_stays_json_when_runtime_packages_uncommitted_changes() {
    let (mut core, spawn, spec, carrier_path, worktree) = launched_core_delivery("stdout-purity");
    fs::write(
        worktree.join("README.md"),
        "delivery terminal fixture changed\n",
    )
    .expect("worktree edit");
    fs::write(worktree.join("Cargo.lock"), "# untracked residue\n").expect("residue");
    fs::create_dir_all(carrier_path.parent().expect("carrier parent")).expect("carrier dir");
    fs::write(
        &carrier_path,
        serde_json::to_vec_pretty(&delivery_carrier_without_package_for_core(&spec, 2))
            .expect("delivery carrier"),
    )
    .expect("carrier write");

    let accepted = core.send_json(serde_json::json!({"v":1,"id":2,"kind":"task-completed","payload":{"task_id":"task-stdout-purity","action_id":spawn.action.action_id,"assignment_id":spawn.action.assignment_id,"status":"completed"}}));
    assert_eq!(accepted.kind, "spawn", "accepted response: {accepted:?}");
    core.shutdown();
}

#[test]
fn lane_delivery_core_rejects_changed_path_outside_approved_unit_scope() {
    let (mut core, spawn, spec, carrier_path, worktree) =
        launched_core_delivery("outside-approved-scope");
    fs::write(worktree.join("outside.txt"), "out-of-scope delivery\n").expect("outside edit");
    fs::create_dir_all(carrier_path.parent().expect("carrier parent")).expect("carrier dir");
    fs::write(
        &carrier_path,
        serde_json::to_vec_pretty(&delivery_carrier_for_core_path(&spec, 2, "outside.txt"))
            .expect("delivery carrier"),
    )
    .expect("carrier write");

    let rejected = core.send_json(serde_json::json!({"v":1,"id":2,"kind":"task-completed","payload":{"task_id":"task-outside-approved-scope","action_id":spawn.action.action_id,"assignment_id":spawn.action.assignment_id,"status":"completed"}}));
    assert_eq!(rejected.kind, "done", "rejected response: {rejected:?}");
    assert!(
        done_status(&rejected)
            .contains("delivery changed path is outside approved unit scope: outside.txt"),
        "rejection did not name the out-of-scope path: {rejected:?}"
    );
    core.shutdown();
}

#[test]
fn delivery_submission_admission_accepts_blocked_and_rejects_mixed_shapes() {
    let assignment = runner::DeliveryAssignmentArtifact {
        schema: "autopilot.delivery_assignment.v1".to_owned(),
        workstream: id("main"),
        assignment_id: id("assignment-main-L1"),
        lane_id: id("L1"),
        attempt: 1,
        base_commit: Sha("0123456789abcdef0123456789abcdef01234567".to_owned()),
        worktree: "/tmp/worktree".to_owned(),
        ordered_units: vec![ApprovedUnit {
            files: vec![ContractPath("README.md".to_owned())],
            ..unit("U1", 1, &[])
        }],
    };
    let mut submission = kernel::generated::DeliverySubmissionV2 {
        actual_changed_paths: vec![ContractPath("README.md".to_owned())],
        execution_audit_ref: Ref("audit:delivery".to_owned()),
        focused_evidence_refs: vec![Ref("evidence:0".to_owned()), Ref("evidence:1".to_owned())],
        terminal_status: kernel::generated::DeliveryOutcome::Succeeded,
        hard_boundary_violations: Vec::new(),
    };
    assert_eq!(
        runner::admit_delivery_submission_with_assignment(&submission, &assignment, 2),
        Ok(runner::DeliverySubmissionOutcome::Succeeded)
    );
    submission.terminal_status = kernel::generated::DeliveryOutcome::Blocked;
    submission.actual_changed_paths.clear();
    submission.hard_boundary_violations.push(
        "approved command expected planning checkout root, assigned worktree differed".to_owned(),
    );
    assert_eq!(
        runner::admit_delivery_submission_with_assignment(&submission, &assignment, 2),
        Ok(runner::DeliverySubmissionOutcome::Blocked)
    );
    assert!(
        serde_json::from_value::<kernel::generated::DeliverySubmissionV2>(serde_json::json!({
            "actual_changed_paths":[],"execution_audit_ref":"audit:delivery","focused_evidence_refs":["evidence:0","evidence:1"],"terminal_status":"unknown","hard_boundary_violations":["blocked"]
        }))
        .is_err(),
        "unknown status must be rejected by the generated enum"
    );

    let mut mixed = submission.clone();
    mixed.actual_changed_paths = vec![ContractPath("README.md".to_owned())];
    assert!(runner::admit_delivery_submission_with_assignment(&mixed, &assignment, 2).is_err());
    let mut mixed = submission.clone();
    mixed.hard_boundary_violations.clear();
    assert!(runner::admit_delivery_submission_with_assignment(&mixed, &assignment, 2).is_err());
    let mut mixed = submission.clone();
    mixed.terminal_status = kernel::generated::DeliveryOutcome::Succeeded;
    assert!(runner::admit_delivery_submission_with_assignment(&mixed, &assignment, 2).is_err());
}

#[test]
fn lane_delivery_core_consumes_blocked_without_packaging() {
    let (mut core, spawn, spec, carrier_path, worktree) =
        launched_core_delivery("blocked-delivery");
    fs::create_dir_all(carrier_path.parent().expect("carrier parent")).expect("carrier dir");
    fs::write(
        &carrier_path,
        serde_json::to_vec_pretty(&delivery_blocked_carrier_for_core(&spec, 2))
            .expect("blocked carrier"),
    )
    .expect("carrier write");

    let rejected = core.send_json(serde_json::json!({"v":1,"id":2,"kind":"task-completed","payload":{"task_id":"task-blocked-delivery","action_id":spawn.action.action_id,"assignment_id":spawn.action.assignment_id,"status":"completed"}}));
    assert_eq!(rejected.kind, "done", "blocked response: {rejected:?}");
    assert!(
        done_status(&rejected).contains("rejection:delivery-blocked:assignment-main-L1"),
        "blocked status was not visible: {rejected:?}"
    );
    let head = git_stdout(&worktree, &["rev-parse", "--verify", "HEAD^{commit}"]);
    assert_eq!(
        head.trim(),
        spec["base_commit"].as_str().expect("base commit")
    );
    assert_eq!(git_stdout(&worktree, &["status", "--porcelain=v1"]), "");
    let events = fs::read_to_string(core.event_log()).expect("events");
    assert!(events.contains("agent:delivery-blocked"), "{events}");
    assert!(!events.contains("agent:delivery-accepted"), "{events}");
    assert!(!events.contains("validation:required"), "{events}");
    core.shutdown();
}

#[test]
fn lane_delivery_core_accepts_captured_spec_when_runner_spec_and_prompt_are_transient() {
    let (mut core, spawn, spec, carrier_path, worktree) =
        launched_core_delivery("transient-runner-files");
    fs::write(
        worktree.join("README.md"),
        "delivery terminal fixture changed\n",
    )
    .expect("worktree edit");
    fs::create_dir_all(carrier_path.parent().expect("carrier parent")).expect("carrier dir");
    fs::write(
        &carrier_path,
        serde_json::to_vec_pretty(&delivery_carrier_without_package_for_core(&spec, 2))
            .expect("delivery carrier"),
    )
    .expect("carrier write");
    remove_runner_spec_and_prompt_dirs(&spec);

    let accepted = core.send_json(serde_json::json!({"v":1,"id":2,"kind":"task-completed","payload":{"task_id":"task-transient-runner-files","action_id":spawn.action.action_id,"assignment_id":spawn.action.assignment_id,"status":"completed"}}));
    assert_eq!(accepted.kind, "spawn", "accepted response: {accepted:?}");
    core.shutdown();
}

#[test]
fn lane_delivery_core_rejects_oversized_terminal_carrier_before_parsing() {
    let (mut core, spawn, _spec, carrier_path, _worktree) =
        launched_core_delivery("oversized-terminal-carrier");
    fs::create_dir_all(carrier_path.parent().expect("carrier parent")).expect("carrier dir");
    fs::write(
        &carrier_path,
        vec![b'x'; drivers::seam::MAX_TERMINAL_CARRIER_BYTES + 1],
    )
    .expect("oversized carrier write");

    let rejected = core.send_json(serde_json::json!({"v":1,"id":2,"kind":"task-completed","payload":{"task_id":"task-oversized-terminal-carrier","action_id":spawn.action.action_id,"assignment_id":spawn.action.assignment_id,"status":"completed"}}));
    assert_eq!(rejected.kind, "done", "rejected response: {rejected:?}");
    let status = done_status(&rejected);
    assert!(status.contains("bounded read oversized"), "{status}");
    assert!(status.contains("delivery-carrier"), "{status}");
    core.shutdown();
}

#[test]
fn lane_delivery_core_rejects_oversized_assignment_artifact_before_digesting() {
    let (mut core, spawn, spec, carrier_path, worktree) =
        launched_core_delivery("oversized-assignment-read");
    fs::write(
        worktree.join("README.md"),
        "delivery terminal fixture changed\n",
    )
    .expect("worktree edit");
    fs::create_dir_all(carrier_path.parent().expect("carrier parent")).expect("carrier dir");
    fs::write(
        &carrier_path,
        serde_json::to_vec_pretty(&delivery_carrier_without_package_for_core(&spec, 2))
            .expect("delivery carrier"),
    )
    .expect("carrier write");
    let assignment_path = spec["assignment_path"].as_str().expect("assignment path");
    fs::write(
        assignment_path,
        vec![b'x'; runner::DELIVERY_ASSIGNMENT_MAX_BYTES + 1],
    )
    .expect("oversized assignment write");

    let rejected = core.send_json(serde_json::json!({"v":1,"id":2,"kind":"task-completed","payload":{"task_id":"task-oversized-assignment-read","action_id":spawn.action.action_id,"assignment_id":spawn.action.assignment_id,"status":"completed"}}));
    assert_eq!(rejected.kind, "done", "rejected response: {rejected:?}");
    let status = done_status(&rejected);
    assert!(status.contains("bounded read oversized"), "{status}");
    assert!(status.contains("assignment-main-L1.json"), "{status}");
    core.shutdown();
}

#[test]
fn lane_delivery_core_rejects_captured_spec_bytes_digest_drift() {
    let (mut core, spawn, spec, carrier_path, worktree) =
        launched_core_delivery("captured-spec-drift");
    fs::write(
        worktree.join("README.md"),
        "delivery terminal fixture changed\n",
    )
    .expect("worktree edit");
    let mut carrier = delivery_carrier_without_package_for_core(&spec, 2);
    carrier["spec_bytes"] = serde_json::json!("{}");
    fs::create_dir_all(carrier_path.parent().expect("carrier parent")).expect("carrier dir");
    fs::write(
        &carrier_path,
        serde_json::to_vec_pretty(&carrier).expect("delivery carrier"),
    )
    .expect("carrier write");
    remove_runner_spec_and_prompt_dirs(&spec);

    let rejected = core.send_json(serde_json::json!({"v":1,"id":2,"kind":"task-completed","payload":{"task_id":"task-captured-spec-drift","action_id":spawn.action.action_id,"assignment_id":spawn.action.assignment_id,"status":"completed"}}));
    assert_eq!(rejected.kind, "done", "rejected response: {rejected:?}");
    assert!(
        done_status(&rejected)
            .contains("rejection:delivery-carrier-binding:delivery spec receipt mismatch"),
        "rejection did not report spec drift: {rejected:?}"
    );
    core.shutdown();
}

fn launched_core_delivery(
    fixture_name: &str,
) -> (
    CoreProcess,
    CoreToHostSpawnPayload,
    serde_json::Value,
    PathBuf,
    PathBuf,
) {
    let fixture = fixture(fixture_name);
    let root = fixture.root;
    fs::write(root.join("README.md"), "delivery terminal fixture\n").expect("fixture file");
    git_init_for_core(&root);
    let repo_authority =
        runner::repository_authority_binding(&root, "main").expect("repo authority");
    fs::create_dir_all(root.join(".pi/autopilot/main")).expect("plan dir");
    fs::write(
        root.join(".pi/autopilot/main/approved-plan.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "repository_authority": {
                "manifest_path": repo_authority.path,
                "manifest_digest": repo_authority.digest,
                "head_commit": repo_authority.manifest.head_commit,
                "head_tree": repo_authority.manifest.head_tree,
            },
            "units":[
                {"id":"U1","kind":"implementation","objective":"deliver U1","operator_order":1,"decisions":[],"criteria":["AC1"],"criterion_text":[{"id":"AC1","text":"criterion text AC1"}],"dependencies":[],"predecessor_forward_criteria":[],"downstream_release_edges":["EDGE1"],"files":["README.md"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}]}
            ]
        }))
        .expect("approved json"),
    )
    .expect("approved plan");

    let mut core = CoreProcess::spawn(&root);
    let launch = core.send_json(serde_json::json!({"v":1,"id":1,"kind":"command","payload":{"raw":"autopilot main","background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true}}}));
    assert_eq!(launch.kind, "spawn", "launch response: {launch:?}");
    let spawn: CoreToHostSpawnPayload =
        serde_json::from_value(launch.payload).expect("delivery spawn payload");
    let spec_path = root
        .join(".pi/autopilot/main/worktrees/L1/.pi/autopilot/runner/specs/assignment-main-L1.json");
    let spec: serde_json::Value =
        serde_json::from_slice(&fs::read(&spec_path).expect("delivery spec"))
            .expect("delivery spec json");
    let carrier_path = PathBuf::from(spec["carrier_path"].as_str().expect("carrier path"));
    let worktree = PathBuf::from(spec["worktree"].as_str().expect("worktree path"));
    (core, spawn, spec, carrier_path, worktree)
}

fn remove_runner_spec_and_prompt_dirs(spec: &serde_json::Value) {
    for key in ["spec_path", "prompt_path"] {
        let dir = Path::new(spec[key].as_str().expect("runner path"))
            .parent()
            .expect("runner parent");
        fs::remove_dir_all(dir).expect("remove transient runner directory");
        assert!(
            !dir.exists(),
            "runner directory survived: {}",
            dir.display()
        );
    }
}

fn done_status(envelope: &SeamEnvelope) -> &str {
    envelope.payload["status"]
        .as_str()
        .expect("done payload status")
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
        action_id: None,
        prompt_path: None,
        prompt_digest: None,
        spec_path: None,
        spec_digest: None,
        carrier_path: None,
        boundary_digest: None,
        result_contract_digest: None,
        settings_digest: None,
        context_digest: None,
        skills_digest: None,
        subscription_digest: None,
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
        binding: None,
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
    let criterion_id = id(&format!("criterion-{name}"));
    ApprovedUnit {
        id: id(name),
        kind: kernel::generated::PlanUnitKind::Implementation,
        objective: format!("deliver {name}"),
        operator_order: order,
        decisions: Vec::new(),
        criteria: vec![criterion_id.clone()],
        criterion_text: vec![drivers::allocation::ApprovedCriterion {
            id: criterion_id,
            text: format!("criterion text for {name}"),
        }],
        dependencies: ids(deps),
        predecessor_forward_criteria: if name == "u1" {
            Vec::new()
        } else {
            vec![id(&format!("fg-{name}"))]
        },
        downstream_release_edges: vec![id(&format!("edge-{name}"))],
        files: vec![ContractPath("keep.txt".to_owned())],
        commands: vec![kernel::generated::PlanUnitCommand {
            command: "cargo test -q".to_owned(),
            expected: "pass".to_owned(),
            effect: kernel::generated::CommandEffect::NoEffect,
            generated_paths: Vec::new(),
            handling: kernel::generated::CommandEffectHandling::None,
            scope_preservation:
                "Final Git-visible state remains limited to the approved unit files.".to_owned(),
        }],
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

fn delivery_carrier_without_package_for_core(
    spec: &serde_json::Value,
    evidence_count: usize,
) -> serde_json::Value {
    delivery_carrier_for_core_path(spec, evidence_count, "README.md")
}

fn delivery_carrier_for_core_path(
    spec: &serde_json::Value,
    evidence_count: usize,
    changed_path: &str,
) -> serde_json::Value {
    let typed: kernel::generated::AgentRunSpec =
        serde_json::from_value(spec.clone()).expect("typed runner spec");
    let profile = kernel::generated::TERMINAL_PROFILES
        .iter()
        .find(|profile| profile.0 == "delivery-status.v2")
        .expect("delivery profile");
    let submission = serde_json::json!({
        "actual_changed_paths": [changed_path],
        "execution_audit_ref": "audit:delivery",
        "focused_evidence_refs": (0..evidence_count)
            .map(|index| serde_json::json!(format!("evidence:{index}")))
            .collect::<Vec<_>>(),
        "terminal_status": "succeeded",
        "hard_boundary_violations": []
    });
    let submission_digest = sha256_hex(&serde_json::to_vec(&submission).expect("submission"));
    let tool_call_id = "delivery-tool-call-1";
    let binding = drivers::runner::child::carrier_binding(&typed);
    let audit = serde_json::json!({
        "schema":"autopilot.tool_audit.v1",
        "tool_call_id":tool_call_id,
        "profile_id":profile.0,
        "tool_name":profile.1,
        "boundary_id":profile.2,
        "result_contract":profile.3,
        "schema_digest":profile.4,
        "binding":binding,
        "submission_digest":submission_digest,
        "delivery_policy":{
            "version":drivers::runner::DELIVERY_POLICY_VERSION,
            "assignment_path":typed.assignment_path.as_ref().expect("assignment path").0.clone(),
            "assignment_digest":typed.assignment_digest.as_ref().expect("assignment digest").0.clone(),
            "worktree":typed.worktree.as_ref().expect("worktree").0.clone(),
            "cwd":typed.cwd.0.clone(),
            "policy_digest":drivers::runner::delivery_policy_digest(
                &typed.assignment_path.as_ref().expect("assignment path").0,
                &typed.assignment_digest.as_ref().expect("assignment digest").0,
                &typed.worktree.as_ref().expect("worktree").0,
                &typed.cwd.0,
            ),
            "active_overrides":["bash","edit","write"],
        },
    });
    let spec_bytes =
        fs::read_to_string(spec["spec_path"].as_str().expect("spec path")).expect("spec bytes");
    let carrier_path = PathBuf::from(spec["carrier_path"].as_str().expect("carrier path"));
    let audit_path = carrier_path.with_extension("tool-audit.json");
    let audit_bytes = serde_json::to_vec_pretty(&audit).expect("audit");
    fs::create_dir_all(audit_path.parent().expect("audit parent")).expect("audit dir");
    fs::write(&audit_path, &audit_bytes).expect("audit write");
    serde_json::json!({
        "schema":"autopilot.delivery_result.v2",
        "assignment_id":spec["assignment_id"],"role_id":spec["role_id"],"mode":spec["mode"],
        "run_revision":spec["run_revision"],"workstream":spec["workstream"],"lane_id":spec["lane_id"],
        "attempt":spec["attempt"],"base_commit":spec["base_commit"],"worktree":spec["worktree"],
        "action_id":spec["action_id"],"prompt_path":spec["prompt_path"],"prompt_digest":spec["prompt_digest"],
        "spec_path":spec["spec_path"],
        "spec_digest":sha256_hex(spec_bytes.as_bytes()),
        "spec_bytes":spec_bytes,
        "carrier_path":spec["carrier_path"],"boundary_id":spec["boundary_id"],"boundary_digest":spec["boundary_digest"],
        "result_contract":spec["result_contract"],"result_contract_digest":spec["result_contract_digest"],
        "settings_digest":spec["settings_digest"],"context_digest":spec["context_digest"],
        "skills_digest":spec["skills_digest"],"subscription_digest":spec["subscription_digest"],
        "runtime_extension_digest":spec["runtime_extension_digest"],"terminal_profile_id":profile.0,
        "tool_name":profile.1,"tool_schema_digest":profile.4,"carrier_binding":binding,"tool_call_id":tool_call_id,
        "tool_audit_ref":audit_path.display().to_string(),"tool_audit_digest":sha256_hex(&audit_bytes),
        "submission_digest":submission_digest,"submission":submission
    })
}

fn delivery_blocked_carrier_for_core(
    spec: &serde_json::Value,
    evidence_count: usize,
) -> serde_json::Value {
    let typed: kernel::generated::AgentRunSpec =
        serde_json::from_value(spec.clone()).expect("typed runner spec");
    let profile = kernel::generated::TERMINAL_PROFILES
        .iter()
        .find(|profile| profile.0 == "delivery-status.v2")
        .expect("delivery profile");
    let submission = serde_json::json!({
        "actual_changed_paths": [],
        "execution_audit_ref": "audit:delivery-blocked",
        "focused_evidence_refs": (0..evidence_count)
            .map(|index| serde_json::json!(format!("evidence:{index}")))
            .collect::<Vec<_>>(),
        "terminal_status": "blocked",
        "hard_boundary_violations": ["approved command expected a different checkout root; no mutation performed"]
    });
    let submission_digest = sha256_hex(&serde_json::to_vec(&submission).expect("submission"));
    let tool_call_id = "delivery-tool-call-blocked";
    let binding = drivers::runner::child::carrier_binding(&typed);
    let audit = serde_json::json!({
        "schema":"autopilot.tool_audit.v1",
        "tool_call_id":tool_call_id,
        "profile_id":profile.0,
        "tool_name":profile.1,
        "boundary_id":profile.2,
        "result_contract":profile.3,
        "schema_digest":profile.4,
        "binding":binding,
        "submission_digest":submission_digest,
        "delivery_policy":{
            "version":drivers::runner::DELIVERY_POLICY_VERSION,
            "assignment_path":typed.assignment_path.as_ref().expect("assignment path").0.clone(),
            "assignment_digest":typed.assignment_digest.as_ref().expect("assignment digest").0.clone(),
            "worktree":typed.worktree.as_ref().expect("worktree").0.clone(),
            "cwd":typed.cwd.0.clone(),
            "policy_digest":drivers::runner::delivery_policy_digest(
                &typed.assignment_path.as_ref().expect("assignment path").0,
                &typed.assignment_digest.as_ref().expect("assignment digest").0,
                &typed.worktree.as_ref().expect("worktree").0,
                &typed.cwd.0,
            ),
            "active_overrides":["bash","edit","write"],
        },
    });
    let spec_bytes =
        fs::read_to_string(spec["spec_path"].as_str().expect("spec path")).expect("spec bytes");
    let carrier_path = PathBuf::from(spec["carrier_path"].as_str().expect("carrier path"));
    let audit_path = carrier_path.with_extension("tool-audit.json");
    let audit_bytes = serde_json::to_vec_pretty(&audit).expect("audit");
    fs::create_dir_all(audit_path.parent().expect("audit parent")).expect("audit dir");
    fs::write(&audit_path, &audit_bytes).expect("audit write");
    serde_json::json!({
        "schema":"autopilot.delivery_result.v2",
        "assignment_id":spec["assignment_id"],"role_id":spec["role_id"],"mode":spec["mode"],
        "run_revision":spec["run_revision"],"workstream":spec["workstream"],"lane_id":spec["lane_id"],
        "attempt":spec["attempt"],"base_commit":spec["base_commit"],"worktree":spec["worktree"],
        "action_id":spec["action_id"],"prompt_path":spec["prompt_path"],"prompt_digest":spec["prompt_digest"],
        "spec_path":spec["spec_path"],
        "spec_digest":sha256_hex(spec_bytes.as_bytes()),
        "spec_bytes":spec_bytes,
        "carrier_path":spec["carrier_path"],"boundary_id":spec["boundary_id"],"boundary_digest":spec["boundary_digest"],
        "result_contract":spec["result_contract"],"result_contract_digest":spec["result_contract_digest"],
        "settings_digest":spec["settings_digest"],"context_digest":spec["context_digest"],
        "skills_digest":spec["skills_digest"],"subscription_digest":spec["subscription_digest"],
        "runtime_extension_digest":spec["runtime_extension_digest"],"terminal_profile_id":profile.0,
        "tool_name":profile.1,"tool_schema_digest":profile.4,"carrier_binding":binding,"tool_call_id":tool_call_id,
        "tool_audit_ref":audit_path.display().to_string(),"tool_audit_digest":sha256_hex(&audit_bytes),
        "submission_digest":submission_digest,"submission":submission
    })
}

fn git_init_for_core(root: &Path) {
    git_run(root, &["init", "-b", "main"]);
    fs::write(root.join(".gitignore"), ".pi/autopilot/\n.pi/tasks/\n").expect("gitignore");
    git_run(
        root,
        &["config", "user.email", "lane-delivery@example.invalid"],
    );
    git_run(root, &["config", "user.name", "Lane Delivery"]);
    git_run(root, &["add", "."]);
    git_run(root, &["commit", "-m", "seed"]);
}

fn git_run(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .expect("git");
    assert!(
        output.status.success(),
        "git {:?} failed: {}{}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_stdout(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .expect("git");
    assert!(
        output.status.success(),
        "git {:?} failed: {}{}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("git stdout UTF-8")
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

struct CoreProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    event_log: PathBuf,
}

impl CoreProcess {
    fn spawn(cwd: &Path) -> Self {
        let event_log = cwd.join(".pi/autopilot/main/events.jsonl");
        let mut child = Command::new(env!("CARGO_BIN_EXE_autopilot-core"))
            .current_dir(cwd)
            .env("AUTOPILOT_CORE_EVENT_LOG", &event_log)
            .env(
                "AUTOPILOT_NODE_EXECUTABLE",
                std::env::current_exe().expect("test exe"),
            )
            .env(
                "AUTOPILOT_AGENT_RUNNER_WRAPPER",
                std::env::current_exe().expect("test exe"),
            )
            .env(
                "AUTOPILOT_CHILD_ADDON_PATH",
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
            )
            .env(
                "AUTOPILOT_VALIDATOR_COMMAND",
                std::env::current_exe().expect("test exe"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn autopilot-core");
        let stdin = child.stdin.take().expect("core stdin");
        let stdout = BufReader::new(child.stdout.take().expect("core stdout"));
        Self {
            child,
            stdin: Some(stdin),
            stdout,
            event_log,
        }
    }

    fn send_json(&mut self, frame: serde_json::Value) -> SeamEnvelope {
        let stdin = self.stdin.as_mut().expect("core stdin open");
        writeln!(stdin, "{frame}").expect("write frame");
        stdin.flush().expect("flush frame");
        self.read_json_line()
    }

    fn read_json_line(&mut self) -> SeamEnvelope {
        let mut line = String::new();
        let bytes = self.stdout.read_line(&mut line).expect("read core stdout");
        assert_ne!(bytes, 0, "autopilot-core closed stdout before response");
        serde_json::from_str(line.trim_end()).unwrap_or_else(|error| {
            panic!(
                "autopilot-core stdout line was not JSON: {error}; line={:?}",
                line.trim_end()
            )
        })
    }

    fn event_log(&self) -> &Path {
        &self.event_log
    }

    fn shutdown(mut self) {
        let _ = self.send_json(serde_json::json!({"v":1,"id":99,"kind":"shutdown","payload":{"reason":"stdout-purity-test"}}));
        drop(self.stdin.take());
        let status = self.child.wait().expect("wait autopilot-core");
        assert!(status.success(), "autopilot-core exited with {status}");
    }
}

impl Drop for CoreProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
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
    Fixture {
        root: fs::canonicalize(root).expect("canonical fixture root"),
    }
}
