use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use drivers::{
    allocation::{AllocationPolicy, AllocationSubmission, ApprovedUnit, validate_allocation},
    dispatch::{DispatchInput, LaneReadiness, launch_lanes, select_ready_lanes},
    finalize::{
        BughunterTriggers, FinalCondition, FinalGateInput, RiskLevel, TipEvidence,
        verify_final_gate,
    },
    integration::{CandidateKind, CandidateRequest, CheckCommand, ReleaseIntegrator},
    lifecycle::{CleanupArtifact, CleanupProof, CloseRequest, LocalLifecycle, ProtectedEvidence},
    planning::{
        Atom, PlanningDeclarations, PlanningError, RepositoryEvidence, TaskAuthority,
        accept_plan_review, accept_questions, accept_scout_dossier, accept_task_atoms,
        accept_work_map, boundary_runtime, inline_task_input, p1_inventory, p2_ground,
        require_material_backlinks, require_total_dispositions,
    },
    runner::{
        DeliveryExpectation, DeliveryRejection, accept_delivery, package_delivery_commit,
        refuse_agent_git_mutation,
    },
    transcript::TranscriptStore,
    vcs::GitVcs,
};
use kernel::generated::{
    DeliveryResult, DeliveryTerminalStatus, Id, ModeId, Path as ContractPath, Ref, RunPhase, Sha,
};
use kernel::schedule::ResourceFacts;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
const ZERO: &str = "0000000000000000000000000000000000000000";
const STALE_TIP: &str = "stale-tip";

#[test]
fn p1_p2_p6_compose_against_throwaway_repo_and_recorded_transcripts() {
    let fixture = Fixture::new("live-end-to-end");
    fixture.write_task_document();

    let planning = drive_planning_to_ready(&fixture);
    assert_eq!(
        planning.phase,
        RunPhase::ReadyToExecute,
        "P1 planning phase reaches ready-to-execute after transcript replay"
    );
    assert!(
        planning.units.iter().any(|unit| !unit.criteria.is_empty()),
        "P1 approved plan contains at least one unit with acceptance criteria"
    );

    fixture
        .vcs
        .swap(
            &fixture.source,
            "refs/heads/autopilot/run/run-main/main",
            &fixture.base,
            ZERO,
        )
        .expect("run-main ref");
    let target_before = fixture
        .vcs
        .read_tip(&fixture.source, "refs/heads/main")
        .expect("target before");
    let operator_checkout = fixture.root.join("operator-checkout");
    fs::create_dir_all(&operator_checkout).expect("operator checkout");
    fs::write(operator_checkout.join("sentinel.txt"), "operator\n").expect("operator sentinel");

    let allocation = validate_allocation(
        &planning.units,
        &submission(&planning.units),
        AllocationPolicy {
            parallel_cap: 8,
            active_implementers: 0,
        },
    )
    .expect("allocation composes");
    let selected = select_ready_lanes(&DispatchInput {
        lanes: allocation.lanes,
        readiness: vec![ready("L1"), ready("L2"), ready("L3")],
        active_implementers: 0,
        parallel_cap: 8,
        resources: resources(),
    });
    assert_eq!(selected.first(), Some(&id("L1")));
    let launches = launch_lanes(
        &fixture.vcs,
        &fixture.source,
        &fixture.owner.join("worktrees"),
        "refs/heads/autopilot/run/run-main/main",
        &selected[0..1],
        &["keep.txt"],
    )
    .expect("dispatch launches lane worktree");
    let launch = &launches[0];

    fs::write(launch.worktree.join("keep.txt"), "lane delivery edit\n").expect("lane edit");
    let package_commit =
        package_delivery_commit(&fixture.vcs, &launch.worktree, "package delivery")
            .expect("package-owned delivery commit");
    assert_eq!(
        fixture
            .vcs
            .read_tip(
                &launch.worktree,
                &format!("{}^{{commit}}", package_commit.0)
            )
            .expect("read package commit object"),
        package_commit.0,
        "P2 real package delivery commit object exists in the throwaway repo"
    );
    assert_eq!(
        fixture
            .vcs
            .read_tip(&launch.worktree, "HEAD")
            .expect("lane head"),
        package_commit.0,
        "P2 delivery commit was created by package code through package_delivery_commit"
    );
    assert_eq!(
        refuse_agent_git_mutation(&fixture.vcs),
        Err(DeliveryRejection::AgentGitMutation),
        "P2 agent git mutation remains refused"
    );

    let package_tree = Sha(fixture
        .vcs
        .read_tip(&launch.worktree, "HEAD^{tree}")
        .expect("package tree"));
    let expected = expectation(&launch.worktree, &Sha(launch.base_commit.clone()));
    let accepted = accept_delivery(
        &[delivery(&expected, package_commit.clone(), package_tree)],
        &expected,
    )
    .expect("delivery accepted");
    assert_eq!(
        accepted.changed_paths,
        vec!["keep.txt".to_owned()],
        "P2 delivery carries changed paths"
    );
    assert_eq!(
        expected.base_commit.0, launch.base_commit,
        "P2 delivery carries exact dispatch base"
    );
    assert_eq!(
        accepted.audit_ref,
        Ref("audit:package-delivery".to_owned()),
        "P2 delivery carries execution audit"
    );

    let integrator = ReleaseIntegrator::new(
        &fixture.owner,
        &fixture.source,
        "refs/heads/autopilot/run/run-main/main",
    );
    let prepared = integrator
        .prepare_release(
            CandidateRequest {
                candidate_id: "L1".to_owned(),
                enqueue_sequence: 1,
                kind: CandidateKind::ForwardRelease,
                candidate_tip: accepted.package_commit.0.clone(),
            },
            &fixture.owner.join("integration/L1"),
            &[true_check()],
        )
        .expect("prepare release");
    assert_eq!(
        fixture
            .vcs
            .read_tip(&fixture.source, "refs/heads/autopilot/run/run-main/main")
            .expect("run-main after prepare"),
        prepared.old_tip,
        "P2 prepare_release does not advance integration tip before CAS"
    );
    integrator.cas_release(&prepared).expect("CAS release");
    let final_tip = fixture
        .vcs
        .read_tip(&fixture.source, "refs/heads/autopilot/run/run-main/main")
        .expect("run-main after CAS");
    assert_eq!(
        final_tip, prepared.new_tip,
        "P2 integration tip advances only via cas_release"
    );

    for (condition, make_stale) in [
        (
            FinalCondition::FinalCommands,
            stale_final_commands as fn(&mut FinalGateInput),
        ),
        (FinalCondition::FullSuite, stale_full_suite),
        (FinalCondition::FinalValidator, stale_final_validator),
        (FinalCondition::RequiredBughunter, stale_bughunter),
    ] {
        let mut input = final_input(&final_tip);
        make_stale(&mut input);
        assert_eq!(
            verify_final_gate(&input),
            Err(condition),
            "P6 final verification refuses stale evidence for {} while other evidence is current",
            condition.id()
        );
    }
    let mut current_input = final_input(&final_tip);
    require_current_bughunter(&mut current_input);
    let final_pass = verify_final_gate(&current_input).expect("final gate exact tip");
    assert_eq!(
        final_pass.tip, final_tip,
        "P6 final gate passes on the exact final tip"
    );
    assert!(
        final_pass.bughunter_required,
        "P6 positive case includes current required bughunter evidence"
    );

    let safe_worktree = fixture.owner.join("worktrees/safe-archive");
    fs::create_dir_all(&safe_worktree).expect("safe archive worktree");
    fs::write(safe_worktree.join("done.txt"), "done\n").expect("safe archive marker");
    let lifecycle = LocalLifecycle::new(
        &fixture.owner,
        &fixture.source,
        fixture.owner.join("archive"),
    );
    let report = lifecycle
        .close(CloseRequest {
            workstream: "ws-live".to_owned(),
            run_id: "run-live".to_owned(),
            final_tip: final_tip.clone(),
            target_ref: "refs/heads/main".to_owned(),
            evidence: vec![ProtectedEvidence {
                name: "final-proof.txt".to_owned(),
                bytes: "verified\n".to_owned(),
            }],
            cleanup: vec![
                CleanupProof {
                    artifact: CleanupArtifact::PackageWorktree(safe_worktree.clone()),
                    proven_safe: true,
                },
                CleanupProof {
                    artifact: CleanupArtifact::TempRef(
                        "refs/autopilot/tmp/live-end-to-end".to_owned(),
                    ),
                    proven_safe: true,
                },
            ],
        })
        .expect("lifecycle close");
    assert!(
        report.watchdog_stopped,
        "P6 watchdog is stopped during safe archive"
    );
    assert_eq!(
        report.removed.len(),
        2,
        "P6 safe archive removes only proven-safe artifacts"
    );
    assert!(
        !safe_worktree.exists(),
        "P6 proven-safe package worktree is archived then removed"
    );
    let result_ref = report.result_ref.expect("result ref returned");
    assert_eq!(
        result_ref, "refs/autopilot/results/ws-live/run-live",
        "P6 result ref name is deterministic"
    );
    assert_eq!(
        fixture
            .vcs
            .read_tip(&fixture.source, &result_ref)
            .expect("read result ref"),
        final_tip,
        "P6 result ref is created and readable"
    );
    assert_eq!(
        fs::read_to_string(report.archive_dir.join("final-proof.txt")).expect("archived evidence"),
        "verified\n",
        "P6 evidence is archived"
    );
    assert_eq!(
        fixture
            .vcs
            .read_tip(&fixture.source, "refs/heads/main")
            .expect("target after"),
        target_before,
        "P6 operator target ref is byte-identical before and after close"
    );
    assert_eq!(
        fs::read_to_string(operator_checkout.join("sentinel.txt"))
            .expect("operator checkout after"),
        "operator\n",
        "P6 close writes nothing into the operator checkout"
    );
}

struct PlanningOutcome {
    phase: RunPhase,
    units: Vec<ApprovedUnit>,
}

fn drive_planning_to_ready(fixture: &Fixture) -> PlanningOutcome {
    let declarations = PlanningDeclarations::parse(include_str!("../data/planning.kdl"))
        .expect("planning declarations");
    declarations
        .validate_p1_to_p6()
        .expect("P1-P6 planning declarations");

    let task_source = FileTaskAuthority {
        path: fixture.source.join("TASK.md"),
    };
    let inventory = p1_inventory(&task_source).expect("P1 inventory");
    let dossier = p2_ground(
        &GitRepoEvidence {
            repo: fixture.source.clone(),
        },
        &inventory,
    )
    .expect("P2 dossier");
    assert!(
        !dossier.verified_facts.is_empty(),
        "planning used repository evidence from the throwaway repo"
    );

    let store = TranscriptStore::new(transcript_root());
    let task_atoms = replay(&store, "planning.task-atoms.v1");
    let scout = replay(&store, "planning.scout-dossier.v1");
    let questions = replay(&store, "planning.questions.v1");
    let work_map = replay(&store, "planning.work-map.v1");
    let review = replay(&store, "planning.plan-review.v1");
    let allocation = replay(&store, "allocation.lane-proposal.v1");
    let allocation_json: serde_json::Value =
        serde_json::from_str(&allocation).expect("recorded allocator typed JSON");
    assert_eq!(allocation_json["lane_id"], "L1");
    assert_eq!(allocation_json["ordered_unit_ids"][0], "U1");

    let mut runtime = boundary_runtime("planning.task-atoms.v1");
    runtime.flip_to_enforce();
    let task_atoms = accept_task_atoms(&task_atoms, &runtime).expect("task atoms accepted");
    let mut runtime = boundary_runtime("planning.scout-dossier.v1");
    runtime.flip_to_enforce();
    accept_scout_dossier(&scout, &runtime).expect("scout dossier accepted");
    let mut runtime = boundary_runtime("planning.questions.v1");
    runtime.flip_to_enforce();
    accept_questions(&questions, &runtime).expect("questions accepted");
    let mut runtime = boundary_runtime("planning.work-map.v1");
    runtime.flip_to_enforce();
    let work_map = accept_work_map(&work_map, &runtime).expect("work map accepted");
    let mut runtime = boundary_runtime("planning.plan-review.v1");
    runtime.flip_to_enforce();
    accept_plan_review(&review, &runtime).expect("plan review accepted");

    let atoms = planned_atoms_with_dispositions(&task_atoms);
    require_total_dispositions(&atoms).expect("all atoms disposed");
    require_material_backlinks(&[drivers::planning::MaterialPlanElement {
        id: "U1".to_owned(),
        backlinks: vec![drivers::planning::Backlink::Atom("W1".to_owned())],
    }])
    .expect("material backlinks");
    let work_map_json: serde_json::Value =
        serde_json::from_str(&work_map).expect("recorded work-map typed JSON");
    assert!(
        work_map_json["units"][0]["criteria"]
            .as_array()
            .is_some_and(|criteria| !criteria.is_empty()),
        "approved plan has criteria from recorded transcript"
    );

    PlanningOutcome {
        phase: RunPhase::ReadyToExecute,
        units: approved_units(),
    }
}

struct FileTaskAuthority {
    path: PathBuf,
}

impl TaskAuthority for FileTaskAuthority {
    fn input_set(&self) -> Result<drivers::planning::TaskInputSet, PlanningError> {
        let body = fs::read_to_string(&self.path)
            .map_err(|error| PlanningError::BadDeclaration(error.to_string()))?;
        inline_task_input(body)
    }
}

struct GitRepoEvidence {
    repo: PathBuf,
}

impl RepositoryEvidence for GitRepoEvidence {
    fn facts_for_atoms(&self, atoms: &[Atom]) -> Result<Vec<String>, PlanningError> {
        let vcs = GitVcs::new(
            self.repo
                .parent()
                .ok_or_else(|| PlanningError::BadDeclaration("repo-parent".to_owned()))?,
        );
        let tip = vcs
            .read_tip(&self.repo, "HEAD")
            .map_err(|error| PlanningError::BadDeclaration(format!("{error:?}")))?;
        Ok(atoms
            .iter()
            .map(|atom| format!("{} grounded at {tip}", atom.id))
            .collect())
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
        Self {
            root,
            owner,
            source,
            base,
            vcs,
        }
    }

    fn write_task_document(&self) {
        fs::write(
            self.source.join("TASK.md"),
            "# Task\nAdd an opt-in utility JSON flag, preserve default output, and test both paths.\n",
        ).expect("task document");
        self.vcs.stage_all(&self.source).expect("stage task");
        self.vcs
            .snapshot(&self.source, "task document")
            .expect("task commit");
    }
}

fn replay(store: &TranscriptStore, boundary: &str) -> String {
    let records = store
        .load_boundary(boundary)
        .expect("load transcript boundary");
    assert_eq!(records.len(), 1, "one recorded transcript per boundary");
    records[0].replay().expect("replay transcript").to_owned()
}

fn transcript_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/transcripts")
}

fn planned_atoms_with_dispositions(raw: &str) -> Vec<Atom> {
    raw.lines()
        .filter(|line| line.starts_with("atom "))
        .map(|line| {
            let Some(atom_id) = line.split_whitespace().nth(1) else {
                panic!("recorded atom line has no id: {line}");
            };
            let id = atom_id.to_owned();
            Atom {
                id: id.clone(),
                kind: drivers::planning::AtomKind::Work,
                statement: line.to_owned(),
                disposition: Some(drivers::planning::Disposition {
                    kind: "implemented-by".to_owned(),
                    backlink: drivers::planning::Backlink::Atom(id),
                }),
            }
        })
        .collect()
}

fn approved_units() -> Vec<ApprovedUnit> {
    vec![
        unit("U1", 1, &[], &[], &["EDGE1"]),
        unit("U2", 2, &["U1"], &["unit-complete:U1"], &["EDGE2"]),
        unit("U3", 3, &["U2"], &["unit-complete:U2"], &["EDGE3"]),
    ]
}

fn submission(approved: &[ApprovedUnit]) -> AllocationSubmission {
    AllocationSubmission {
        lanes: vec![
            lane("L1", &["U1"], 0),
            lane("L2", &["U2"], 1),
            lane("L3", &["U3"], 2),
        ],
        future_units: Vec::new(),
        authority_echo: approved.to_vec(),
        ownership_claims: Vec::new(),
        overlap_blocks: Vec::new(),
    }
}

fn unit(name: &str, order: u32, deps: &[&str], gates: &[&str], edges: &[&str]) -> ApprovedUnit {
    let criterion_id = id(&format!("AC-{name}"));
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
        predecessor_forward_criteria: ids(gates),
        downstream_release_edges: ids(edges),
        files: Vec::new(),
        commands: Vec::new(),
    }
}

fn lane(name: &str, unit_ids: &[&str], wave: u32) -> kernel::generated::AllocationLaneProposal {
    let gates = unit_ids
        .iter()
        .flat_map(|unit| match *unit {
            "U1" => vec![],
            "U2" => vec!["unit-complete:U1"],
            _ => vec!["unit-complete:U2"],
        })
        .collect::<Vec<_>>();
    let edges = unit_ids
        .iter()
        .flat_map(|unit| match *unit {
            "U1" => vec!["EDGE1"],
            "U2" => vec!["EDGE2"],
            _ => vec!["EDGE3"],
        })
        .collect::<Vec<_>>();
    kernel::generated::AllocationLaneProposal {
        lane_id: id(name),
        objective: format!("deliver {name}"),
        ordered_unit_ids: ids(unit_ids),
        rationale: "single approved unit".to_owned(),
        delivery_boundary: kernel::generated::DeliveryBoundary("package delivery".to_owned()),
        predecessor_forward_criteria: ids(&gates),
        downstream_release_edges: ids(&edges),
        context_family_id: id("CF-UTILITY-JSON"),
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

fn expectation(worktree: &Path, base: &Sha) -> DeliveryExpectation {
    DeliveryExpectation {
        assignment_id: id("assignment-L1"),
        role_id: id("implementer"),
        mode: ModeId("lane-delivery".to_owned()),
        run_revision: 1,
        lane_id: id("L1"),
        attempt: 1,
        base_commit: base.clone(),
        worktree: worktree.to_path_buf(),
        required_focused_evidence: 1,
        binding: None,
    }
}

fn delivery(expected: &DeliveryExpectation, commit: Sha, tree: Sha) -> DeliveryResult {
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
        package_commit: Some(commit),
        package_tree: Some(tree),
        actual_changed_paths: vec![ContractPath("keep.txt".to_owned())],
        execution_audit_ref: Ref("audit:package-delivery".to_owned()),
        focused_evidence_refs: vec![Ref("evidence:focused".to_owned())],
        terminal_status: DeliveryTerminalStatus("done".to_owned()),
        hard_boundary_violations: Vec::new(),
    }
}

fn true_check() -> CheckCommand {
    CheckCommand {
        program: "true".to_owned(),
        args: Vec::new(),
    }
}

fn final_input(tip: &str) -> FinalGateInput {
    FinalGateInput {
        final_tip: tip.to_owned(),
        every_unit_closed: true,
        no_mandatory_findings: true,
        no_stale_required_proof: true,
        no_active_or_unknown_jobs: true,
        attributable_integrated_diff: true,
        final_commands: evidence(tip),
        full_suite: evidence(tip),
        final_validator: evidence(tip),
        bughunter: None,
        triggers: BughunterTriggers {
            implementation_lanes: 1,
            risk: RiskLevel::Low,
            protected_security_data_or_migration: false,
            semantic_conflict_resolution: false,
            operator_required: false,
        },
    }
}

fn evidence(tip: &str) -> TipEvidence {
    TipEvidence {
        tip: tip.to_owned(),
        passed: true,
    }
}

fn stale_final_commands(input: &mut FinalGateInput) {
    input.final_commands = evidence(STALE_TIP);
}

fn stale_full_suite(input: &mut FinalGateInput) {
    input.full_suite = evidence(STALE_TIP);
}

fn stale_final_validator(input: &mut FinalGateInput) {
    input.final_validator = evidence(STALE_TIP);
}

fn stale_bughunter(input: &mut FinalGateInput) {
    input.triggers.implementation_lanes = 2;
    input.bughunter = Some(evidence(STALE_TIP));
}

fn require_current_bughunter(input: &mut FinalGateInput) {
    input.triggers.implementation_lanes = 2;
    input.bughunter = Some(evidence(&input.final_tip));
}

fn ids(values: &[&str]) -> Vec<Id> {
    values.iter().map(|value| id(value)).collect()
}

fn id(value: &str) -> Id {
    Id(value.to_owned())
}

fn temp_root(name: &str) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("autopilot-{name}-{}-{n}", std::process::id()));
    if root.exists() {
        fs::remove_dir_all(&root).expect("clean temp root");
    }
    fs::create_dir_all(&root).expect("temp root");
    fs::canonicalize(root).expect("canonical temp root")
}
