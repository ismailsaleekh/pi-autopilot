#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt, chown, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use drivers::planning::{self, WorkMapV2AdmissionContext};
use drivers::runner::{
    self, CoreMaterializationBindingV1, CoreMaterializationRequestV4, DeliveryAssignmentArtifactV4,
    DeliveryExpectation, DeliverySubmissionOutcome, RecoveryDirective, RunnerAssignmentV4,
    RunnerTransportFacts,
};
use drivers::seam;
use kernel::generated::{
    AgentRunSpec, ContractId, DeliveryOutcome, DeliveryResult, DeliverySubmissionV2,
    DeliveryTerminalStatus, Digest as ContractDigest, GitOid, Id, ModeId, Path as ContractPath,
    PlanningAtomKind, PlanningAtomRegistryAtom, Ref, SchemaId, SessionContinuity, Sha,
    TerminalRoute, ThinkingLevel, ToolName, ValidationAssignmentKind,
};
use sha2::{Digest, Sha256};

static NEXT: AtomicU64 = AtomicU64::new(0);
static CWD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const TEST_BROKER_CAPABILITY: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn broker_socket() -> PathBuf {
    use std::io::ErrorKind;
    use std::os::unix::net::UnixListener;

    let root = PathBuf::from("/tmp/.pi-ap");
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let dir = loop {
        let candidate = root.join(format!("{:010x}", NEXT.fetch_add(1, Ordering::Relaxed)));
        match fs::create_dir(&candidate) {
            Ok(()) => break candidate,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("broker socket directory {candidate:?}: {error}"),
        }
    };
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    let path = dir.join("s");
    let listener = UnixListener::bind(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    drop(listener);
    path
}

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

fn with_fixture_cwd<T>(root: &Path, issue: impl FnOnce() -> T) -> T {
    let _cwd_lock = CWD_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("cwd lock");
    let _cwd = CwdGuard::enter(root);
    issue()
}

struct Fixture {
    root: PathBuf,
    worktree: PathBuf,
    approved: seam::ApprovedPlanArtifactV2,
    request: CoreMaterializationRequestV4,
    base: Sha,
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn independently_recomputed_proof_subject_digest(receipt: &serde_json::Value) -> String {
    let mut receipt = receipt.clone();
    receipt["proof_subject_digest"] = serde_json::Value::String(String::new());
    let canonical = serde_json::to_vec(&receipt).unwrap();
    let mut digest = Sha256::new();
    digest.update(b"autopilot.core_v2_package_proof.subject.v1\0");
    digest.update((canonical.len() as u64).to_be_bytes());
    digest.update(canonical);
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_text(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn set_exact_special_mode(path: &Path, mode: u32) {
    let group_probe = std::env::temp_dir().join(format!(
        "autopilot-v4-mode-group-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&group_probe, b"group probe").unwrap();
    let effective_group = fs::metadata(&group_probe).unwrap().gid();
    fs::remove_file(&group_probe).unwrap();
    chown(path, None, Some(effective_group)).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o7777,
        mode,
        "test fixture must retain the requested special mode"
    );
}

fn repository() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/v4-materializer-fixtures")
        .join(format!(
            "repo-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    fs::create_dir_all(root.join("upstream")).unwrap();
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("upstream/source.bin"), b"immutable\0non-utf8\xff").unwrap();
    fs::set_permissions(
        root.join("upstream/source.bin"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    fs::write(
        root.join("upstream/executable.bin"),
        b"executable\0non-utf8\xfe",
    )
    .unwrap();
    fs::set_permissions(
        root.join("upstream/executable.bin"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(root.join("src/authored.rs"), b"before materialization\n").unwrap();
    fs::write(root.join("foreign-tracked.txt"), b"foreign\n").unwrap();
    git(&root, &["init", "--quiet"]);
    git(&root, &["config", "user.email", "v4@example.invalid"]);
    git(&root, &["config", "user.name", "V4"]);
    git(&root, &["add", "."]);
    git(&root, &["commit", "--quiet", "-m", "actual v2 fixture"]);
    fs::canonicalize(root).unwrap()
}

fn atom_registry(root: &Path) -> (PathBuf, String) {
    let bytes = planning::atom_registry_bytes(
        "main",
        "v4-fixture",
        vec![Id("producer".into())],
        vec![PlanningAtomRegistryAtom {
            id: Id("atom-1".into()),
            producer_assignment_id: Id("producer".into()),
            kind: PlanningAtomKind::Work,
            text: "actual V2 authority atom".into(),
            sources: vec![Ref("source:fixture".into())],
        }],
    )
    .unwrap();
    let path = root.join(".pi/autopilot/main/planning/atoms.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, &bytes).unwrap();
    (path, sha(&bytes))
}

fn actual_carrier_named(root: &Path, name: &str, raw: &str) -> PathBuf {
    let (atom_path, atom_digest) = atom_registry(root);
    let assignment_id = Id(format!("planning-v4-{}", name.replace('.', "-")));
    let paths = runner::planning_paths(root, "main", &assignment_id);
    fs::create_dir_all(paths.carrier_path.parent().unwrap()).unwrap();
    fs::create_dir_all(paths.spec_path.parent().unwrap()).unwrap();
    fs::create_dir_all(paths.prompt_path.parent().unwrap()).unwrap();
    fs::write(&paths.prompt_path, "actual V2 fixture prompt\n").unwrap();
    let route = TerminalRoute {
        version: "v2".into(),
        profile_id: "planning.work-map.v2:autopilot_submit_synthesis".into(),
        tool_name: ToolName("autopilot_submit_synthesis".into()),
        boundary_id: ContractId("planning.work-map.v2".into()),
        result_contract: ContractId("planning.work-map.v2".into()),
        schema_digest: ContractDigest(
            "4f341cc4aade90ac13c4584898f29b42d054d4ea4b5c126117841550e680ae75".into(),
        ),
    };
    let spec = AgentRunSpec {
        schema: SchemaId("autopilot.agent_run_spec.v4".into()),
        assignment_kind: ValidationAssignmentKind::PlanningReview,
        action_id: Id(format!("action-{}", assignment_id.0)),
        assignment_id: assignment_id.clone(),
        run_id: Id("fixture-run".into()),
        run_revision: 1,
        workstream: Id("main".into()),
        role_id: Id("plan-synthesizer".into()),
        mode: ModeId("initial-plan".into()),
        provider: "fixture".into(),
        model: "fixture".into(),
        thinking: ThinkingLevel("low".into()),
        route: "fixture".into(),
        cwd: ContractPath(root.display().to_string()),
        allowed_tools: vec![route.tool_name.clone()],
        spec_path: ContractPath(paths.spec_path.display().to_string()),
        prompt_path: ContractPath(paths.prompt_path.display().to_string()),
        prompt_digest: ContractDigest("a".repeat(64)),
        boundary_id: ContractId("planning.work-map.v2".into()),
        boundary_digest: ContractDigest("b".repeat(64)),
        result_contract: ContractId("planning.work-map.v2".into()),
        result_contract_digest: ContractDigest("c".repeat(64)),
        carrier_path: ContractPath(paths.carrier_path.display().to_string()),
        session_id: Id("fixture-session".into()),
        session_dir: ContractPath(
            root.join(".pi/autopilot/main/sessions")
                .display()
                .to_string(),
        ),
        session_continuity: SessionContinuity::Fresh,
        settings_digest: ContractDigest("d".repeat(64)),
        context_digest: ContractDigest("e".repeat(64)),
        skills_digest: ContractDigest("f".repeat(64)),
        subscription_digest: ContractDigest("0".repeat(64)),
        lane_id: None,
        attempt: None,
        base_commit: None,
        worktree: None,
        required_focused_evidence: None,
        authority_set_id: None,
        authority_documents: None,
        context_document: None,
        context_documents: None,
        assignment_path: None,
        assignment_digest: None,
        context_manifest_path: None,
        context_manifest_digest: None,
        runtime_extension_path: Some(ContractPath(
            root.join(".pi/autopilot/main/addon.ts")
                .display()
                .to_string(),
        )),
        runtime_extension_digest: Some(ContractDigest(
            kernel::generated::CHILD_ADDON_DIGEST.into(),
        )),
        terminal_profile_id: Some(route.profile_id.clone()),
        terminal_route: Some(route.clone()),
        unavailable_tools: None,
        producer_assignment_ids: None,
        validation_id: None,
        validation_attempt: None,
        semantic_round: None,
        model_submission_path: None,
        atom_id_prefix: None,
        atom_registry_path: Some(ContractPath(atom_path.display().to_string())),
        atom_registry_digest: Some(ContractDigest(atom_digest.clone())),
        planning_inputs_path: None,
        planning_inputs_digest: None,
    };
    let spec_bytes = serde_json::to_vec(&spec).unwrap();
    fs::write(&paths.spec_path, &spec_bytes).unwrap();
    let carrier = serde_json::json!({
        "schema":"autopilot.planning_carrier.v2", "action_id":spec.action_id.0, "assignment_id":assignment_id.0,
        "run_revision":1, "workstream":"main", "role_id":"plan-synthesizer", "mode":"initial-plan",
        "boundary_id":"planning.work-map.v2", "result_contract":"planning.work-map.v2", "prompt_path":paths.prompt_path,
        "prompt_digest":"a".repeat(64), "boundary_digest":"b".repeat(64), "result_contract_digest":"c".repeat(64),
        "settings_digest":"d".repeat(64), "context_digest":"e".repeat(64), "skills_digest":"f".repeat(64),
        "subscription_digest":"0".repeat(64), "runtime_extension_digest":kernel::generated::CHILD_ADDON_DIGEST,
        "spec_digest":sha(&spec_bytes), "spec_path":paths.spec_path, "carrier_path":paths.carrier_path, "carrier_channel":"tool",
        "tool_name":route.tool_name.0, "tool_schema_digest":route.schema_digest.0, "carrier_binding":runner::child::carrier_binding(&spec),
        "pi_version":"pi test-only 0.84.1", "terminal_route":route, "atom_registry_path":atom_path, "atom_registry_digest":atom_digest,
        "raw_output":raw,
    });
    fs::write(&paths.carrier_path, serde_json::to_vec(&carrier).unwrap()).unwrap();
    paths.carrier_path
}

fn command() -> serde_json::Value {
    serde_json::json!({"command":"true","expected":"passes","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"leaves no state"})
}

fn plan(_root: &Path, empty: bool) -> String {
    if empty {
        return serde_json::json!({"schema":"planning.work-map.v2","units":[{
            "id":"U1","kind":"implementation","objective":"author mutable leaf","criteria":["authored"],"depends_on":[],
            "files":["src/authored.rs"],"package_scope_files":[],"commands":[command()],
            "package_proofs":[],"vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom-1"]
        }]}).to_string();
    }
    serde_json::json!({"schema":"planning.work-map.v2","units":[{
        "id":"U1","kind":"implementation","objective":"materialize binary sources and author mutable leaf","criteria":["exact"],"depends_on":[],
        "files":["vendor/z.bin","vendor/a.bin","manifests/provenance.tsv","src/authored.rs"],
        "package_scope_files":["vendor/z.bin","vendor/a.bin","manifests/provenance.tsv","src/authored.rs"],"commands":[command()],
        "package_proofs":[{"proof_id":"clean","kind":"clean-exact-package-tip","criterion_ordinals":[1],"expected":"clean exact tip","vendor_binding_ids":[]},{"proof_id":"vendor","kind":"vendored-bytes-match-origin","criterion_ordinals":[1],"expected":"exact bytes","vendor_binding_ids":["binding-a","binding-z"]}],
        "vendor_bindings":[
          {"binding_id":"binding-z","origin_path":"upstream/source.bin","destination":"vendor/z.bin"},
          {"binding_id":"binding-a","origin_path":"upstream/executable.bin","destination":"vendor/a.bin"}
        ],"provenance_manifest_destination":"manifests/provenance.tsv","links":["atom-1"]
    }]}).to_string()
}

fn fixture(empty: bool) -> Fixture {
    let root = repository();
    let (atoms, atom_digest) = atom_registry(&root);
    let raw = plan(&root, empty);
    let carrier = actual_carrier_named(&root, if empty { "empty" } else { "vendor" }, &raw);
    let admitted = planning::work_map_v2::admit_work_map_v2_actual_carrier_for_test_only(
        &carrier,
        WorkMapV2AdmissionContext {
            atom_registry_path: &atoms,
            atom_registry_digest: &atom_digest,
            recovery_subject: None,
        },
    )
    .unwrap();
    let image = root.join(".pi/autopilot/main/approved-v2.json");
    let binding = root.join(".pi/autopilot/main/approved-v2-binding.json");
    let promotion =
        seam::write_approved_plan_v2_for_test_only("main", &image, &binding, &admitted).unwrap();
    let approved = seam::read_approved_plan_v2(&binding, &promotion.binding_sha256).unwrap();
    let base = Sha(git_text(&root, &["rev-parse", "HEAD"]).trim().to_owned());
    let worktree = root.parent().unwrap().join(format!(
        "delivery-worktree-{}",
        root.file_name().unwrap().to_string_lossy(),
    ));
    git(
        &root,
        &[
            "worktree",
            "add",
            "--detach",
            "--quiet",
            worktree.to_str().unwrap(),
            &base.0,
        ],
    );
    let worktree = fs::canonicalize(worktree).unwrap();
    // Materialization reads the lane worktree, so make its fixture sources
    // explicitly satisfy the only supported regular-file modes even under a
    // restrictive parent umask.
    fs::set_permissions(
        worktree.join("upstream/source.bin"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    fs::set_permissions(
        worktree.join("upstream/executable.bin"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let request = CoreMaterializationRequestV4 {
        workstream: Id("main".into()),
        assignment_id: Id("assignment-main-L1".into()),
        lane_id: Id("L1".into()),
        attempt: 1,
        base_commit: base.clone(),
        worktree: worktree.clone(),
        approved_plan_binding_path: binding.display().to_string(),
        approved_plan_binding_digest: promotion.binding_sha256,
        approved_image_digest: promotion.approved_plan_sha256,
        selected_units: approved.units.clone(),
        selected_vendoring: approved.vendoring.clone(),
    };
    Fixture {
        root,
        worktree,
        approved,
        request,
        base,
    }
}

fn materialize(fixture: &Fixture) -> CoreMaterializationBindingV1 {
    runner::materializer_v4::materialize_v4(&fixture.request, &fixture.approved).unwrap()
}

fn ordinary_artifact(
    fixture: &Fixture,
    materialization: CoreMaterializationBindingV1,
) -> DeliveryAssignmentArtifactV4 {
    DeliveryAssignmentArtifactV4 {
        schema: "autopilot.delivery_assignment.v4".into(),
        workstream: fixture.request.workstream.clone(),
        assignment_id: fixture.request.assignment_id.clone(),
        lane_id: fixture.request.lane_id.clone(),
        attempt: fixture.request.attempt,
        base_commit: fixture.base.clone(),
        worktree: fixture.worktree.display().to_string(),
        ordered_units: fixture.approved.units.clone(),
        approved_commands: runner::approved_command_bindings(&fixture.approved.units),
        recovery: None,
        approved_plan_binding_path: fixture.request.approved_plan_binding_path.clone(),
        approved_plan_binding_digest: fixture.request.approved_plan_binding_digest.clone(),
        approved_image_digest: fixture.request.approved_image_digest.clone(),
        selected_vendoring: fixture.approved.vendoring.clone(),
        materialization,
    }
}

fn expectation(worktree: &Path, base: &Sha, recovery: bool) -> DeliveryExpectation {
    DeliveryExpectation {
        assignment_id: Id(if recovery {
            "recovery-assignment-main-L1-a1"
        } else {
            "assignment-main-L1"
        }
        .into()),
        role_id: Id(if recovery {
            "recovery-engineer"
        } else {
            "implementer"
        }
        .into()),
        mode: ModeId(
            if recovery {
                "forward-critical"
            } else {
                "lane-delivery"
            }
            .into(),
        ),
        run_revision: if recovery { 2 } else { 1 },
        lane_id: Id("L1".into()),
        attempt: 1,
        base_commit: base.clone(),
        worktree: worktree.to_path_buf(),
        required_focused_evidence: 2,
        binding: None,
    }
}

fn result(expected: &DeliveryExpectation, path: &str) -> DeliveryResult {
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
        package_commit: None,
        package_tree: None,
        actual_changed_paths: vec![ContractPath(path.into())],
        execution_audit_ref: Ref("audit:v4".into()),
        focused_evidence_refs: vec![Ref("e1".into()), Ref("e2".into())],
        terminal_status: DeliveryTerminalStatus("done".into()),
        hard_boundary_violations: Vec::new(),
    }
}

fn submission(path: &str) -> DeliverySubmissionV2 {
    DeliverySubmissionV2 {
        actual_changed_paths: vec![ContractPath(path.into())],
        execution_audit_ref: Ref("audit:v4".into()),
        focused_evidence_refs: vec![Ref("e1".into()), Ref("e2".into())],
        terminal_status: DeliveryOutcome::Succeeded,
        hard_boundary_violations: Vec::new(),
        blocker_class: None,
        recovery_disposition: None,
    }
}

fn receipt_exists(binding: &CoreMaterializationBindingV1) -> bool {
    Path::new(&binding.receipt_path).exists()
}

#[test]
fn actual_v2_materializes_exact_bytes_modes_manifest_and_replays_under_restrictive_umask() {
    let fixture = fixture(false);
    let binding = materialize(&fixture);
    assert_eq!(
        fs::read(fixture.worktree.join("vendor/z.bin")).unwrap(),
        b"immutable\0non-utf8\xff"
    );
    assert_eq!(
        fs::read(fixture.worktree.join("vendor/a.bin")).unwrap(),
        b"executable\0non-utf8\xfe"
    );
    assert_eq!(
        fs::metadata(fixture.worktree.join("vendor/z.bin"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
    assert_eq!(
        fs::metadata(fixture.worktree.join("vendor/a.bin"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    let manifest = fs::read(fixture.worktree.join("manifests/provenance.tsv")).unwrap();
    let digest_a = sha(b"executable\0non-utf8\xfe");
    let digest_z = sha(b"immutable\0non-utf8\xff");
    let manifest_digest = sha(&manifest);
    assert_eq!(manifest, format!("upstream/executable.bin\tvendor/a.bin\tsha256:{digest_a}\nupstream/source.bin\tvendor/z.bin\tsha256:{digest_z}\n").into_bytes());
    let intention: runner::CoreMaterializationIntentionV1 =
        serde_json::from_slice(&fs::read(&binding.intention_path).unwrap()).unwrap();
    let receipt: runner::CoreMaterializationReceiptV1 =
        serde_json::from_slice(&fs::read(&binding.receipt_path).unwrap()).unwrap();
    assert_eq!(
        drivers::evidence::canonical_json(&intention).unwrap(),
        fs::read(&binding.intention_path).unwrap()
    );
    assert_eq!(
        drivers::evidence::canonical_json(&receipt).unwrap(),
        fs::read(&binding.receipt_path).unwrap()
    );
    assert_eq!(
        sha(&fs::read(&binding.intention_path).unwrap()),
        binding.intention_digest
    );
    assert_eq!(
        sha(&fs::read(&binding.receipt_path).unwrap()),
        binding.receipt_digest
    );
    assert_eq!(receipt.intention_digest, binding.intention_digest);
    assert_eq!(receipt.completed_baseline, binding.baseline);
    assert_eq!(
        binding
            .baseline
            .iter()
            .map(|leaf| (
                leaf.destination.0.as_str(),
                leaf.mode.as_str(),
                leaf.bytes_sha256.as_str()
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                "manifests/provenance.tsv",
                "100644",
                manifest_digest.as_str()
            ),
            ("vendor/a.bin", "100755", digest_a.as_str()),
            ("vendor/z.bin", "100644", digest_z.as_str()),
        ],
        "the receipt records exact lane-worktree bytes and modes"
    );
    assert_eq!(
        materialize(&fixture),
        binding,
        "only a complete pair replays idempotently"
    );

    let helper = Command::new("sh")
        .args([
            "-c",
            "umask 077; exec \"$0\" --exact v4_restrictive_umask_subprocess --nocapture",
            std::env::current_exe().unwrap().to_str().unwrap(),
        ])
        .env("V4_RESTRICTIVE_UMASK_SUBPROCESS", "1")
        .output()
        .unwrap();
    assert!(
        helper.status.success(),
        "umask helper stderr: {}",
        String::from_utf8_lossy(&helper.stderr)
    );
}

#[test]
fn materialization_replay_uses_receipted_baseline_without_reading_origins() {
    let fixture = fixture(false);
    let binding = materialize(&fixture);
    let artifact = ordinary_artifact(&fixture, binding);
    fs::remove_file(fixture.worktree.join("upstream/source.bin")).unwrap();
    fs::remove_file(fixture.worktree.join("upstream/executable.bin")).unwrap();

    assert!(
        runner::materializer_v4::replay_v4_materialization(&artifact).is_ok(),
        "receipt replay validates protected baseline leaves without reopening origins"
    );
}

#[test]
fn materializer_reads_only_exact_lane_worktree_sources_and_rejects_unsafe_leaves() {
    for label in [
        "symlink",
        "directory",
        "missing",
        "oversized",
        "setuid",
        "setgid",
        "sticky",
    ] {
        let fixture = fixture(false);
        let source = fixture.worktree.join("upstream/executable.bin");
        match label {
            "symlink" => {
                fs::remove_file(&source).unwrap();
                symlink(fixture.root.join("foreign-tracked.txt"), &source).unwrap();
            }
            "directory" => {
                fs::remove_file(&source).unwrap();
                fs::create_dir(&source).unwrap();
            }
            "missing" => fs::remove_file(&source).unwrap(),
            "oversized" => {
                fs::write(&source, vec![b'x'; runner::MAX_AUTHORITY_SOURCE_BYTES + 1]).unwrap();
                fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
            }
            "setuid" => set_exact_special_mode(&source, 0o4755),
            "setgid" => set_exact_special_mode(&source, 0o2755),
            "sticky" => set_exact_special_mode(&source, 0o1755),
            _ => unreachable!(),
        }
        assert!(
            runner::materializer_v4::materialize_v4(&fixture.request, &fixture.approved).is_err(),
            "selected {label} source must be refused"
        );
    }

    let fixture = fixture(false);
    let mut unsafe_request = fixture.request.clone();
    unsafe_request.selected_vendoring[0].vendor_bindings[0].origin_path =
        ContractPath("../outside".into());
    assert!(
        runner::materializer_v4::materialize_v4(&unsafe_request, &fixture.approved).is_err(),
        "Core must refuse a selected unsafe origin path"
    );
}

#[test]
fn v4_restrictive_umask_subprocess() {
    if std::env::var_os("V4_RESTRICTIVE_UMASK_SUBPROCESS").is_none() {
        return;
    }
    let fixture = fixture(false);
    materialize(&fixture);
    assert_eq!(
        fs::metadata(fixture.worktree.join("vendor/z.bin"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
    assert_eq!(
        fs::metadata(fixture.worktree.join("vendor/a.bin"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
}

#[test]
fn actual_v2_crash_filesystem_and_authority_matrix_fails_closed_without_adoption() {
    let intention_only = fixture(false);
    let complete = materialize(&intention_only);
    fs::remove_file(&complete.receipt_path).unwrap();
    assert!(
        runner::materializer_v4::materialize_v4(&intention_only.request, &intention_only.approved)
            .is_err(),
        "intention-only"
    );
    assert!(!receipt_exists(&complete));

    let receipt_only = fixture(false);
    let complete = materialize(&receipt_only);
    fs::remove_file(&complete.intention_path).unwrap();
    assert!(
        runner::materializer_v4::materialize_v4(&receipt_only.request, &receipt_only.approved)
            .is_err(),
        "receipt-only"
    );

    for label in ["exact", "oversized", "socket"] {
        let fixture = fixture(false);
        let path = fixture.worktree.join("vendor/a.bin");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        match label {
            "exact" => fs::write(&path, b"executable\0non-utf8\xfe").unwrap(),
            "oversized" => {
                fs::write(&path, vec![b'x'; runner::MAX_AUTHORITY_SOURCE_BYTES + 1]).unwrap()
            }
            "socket" => {
                let status = Command::new("mkfifo").arg(&path).status().unwrap();
                assert!(status.success());
                assert!(
                    runner::materializer_v4::materialize_v4(&fixture.request, &fixture.approved)
                        .is_err(),
                    "{label}"
                );
                assert!(!fixture.worktree.join(".pi/autopilot/runner/core-materialization/assignment-main-L1.receipt.v1.json").exists());
                continue;
            }
            _ => unreachable!(),
        }
        let before = fs::read(&path).unwrap();
        assert!(
            runner::materializer_v4::materialize_v4(&fixture.request, &fixture.approved).is_err(),
            "preexisting {label}"
        );
        assert_eq!(
            fs::read(&path).unwrap(),
            before,
            "{label} was not adopted or cleaned up"
        );
        assert!(
            !fixture
                .worktree
                .join(
                    ".pi/autopilot/runner/core-materialization/assignment-main-L1.receipt.v1.json"
                )
                .exists()
        );
    }

    for label in ["byte", "mode", "setuid", "setgid", "sticky", "symlink"] {
        let fixture = fixture(false);
        let complete = materialize(&fixture);
        let path = fixture.worktree.join("vendor/a.bin");
        match label {
            "byte" => fs::write(&path, b"drift\0").unwrap(),
            "mode" => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
            "setuid" => set_exact_special_mode(&path, 0o4755),
            "setgid" => set_exact_special_mode(&path, 0o2755),
            "sticky" => set_exact_special_mode(&path, 0o1755),
            "symlink" => {
                fs::remove_file(&path).unwrap();
                symlink(fixture.root.join("foreign-tracked.txt"), &path).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            runner::materializer_v4::materialize_v4(&fixture.request, &fixture.approved).is_err(),
            "{label} drift"
        );
        assert!(
            receipt_exists(&complete),
            "complete receipt is never cleaned up"
        );
    }

    let authority_fixture = fixture(false);
    let mut wrong_binding = authority_fixture.request.clone();
    wrong_binding.approved_plan_binding_digest = "a".repeat(64);
    let mut wrong_root = authority_fixture.request.clone();
    wrong_root.approved_plan_binding_path = authority_fixture
        .root
        .join("foreign-tracked.txt")
        .display()
        .to_string();
    let mut wrong_selected = authority_fixture.request.clone();
    wrong_selected.selected_vendoring[0].vendor_bindings[0].destination =
        ContractPath("vendor/wrong.bin".into());
    for request in [wrong_binding, wrong_root, wrong_selected] {
        assert!(
            runner::materializer_v4::materialize_v4(&request, &authority_fixture.approved).is_err()
        );
    }

    let unrelated_state = fixture(false);
    fs::write(
        unrelated_state.worktree.join("src/authored.rs"),
        b"new unrelated HEAD\n",
    )
    .unwrap();
    git(&unrelated_state.worktree, &["add", "src/authored.rs"]);
    git(
        &unrelated_state.worktree,
        &["commit", "--quiet", "-m", "move unrelated lane HEAD"],
    );
    fs::write(
        unrelated_state.worktree.join("foreign-tracked.txt"),
        b"dirty unrelated tracked leaf\n",
    )
    .unwrap();
    fs::create_dir_all(unrelated_state.worktree.join(".pi")).unwrap();
    fs::write(
        unrelated_state.worktree.join(".pi/foreign.txt"),
        b"unrelated untracked residue",
    )
    .unwrap();
    symlink(
        unrelated_state.root.join("foreign-tracked.txt"),
        unrelated_state.worktree.join("unrelated-link"),
    )
    .unwrap();
    let binding = materialize(&unrelated_state);
    assert_eq!(
        fs::read(unrelated_state.worktree.join("vendor/a.bin")).unwrap(),
        b"executable\0non-utf8\xfe"
    );
    assert_eq!(
        materialize(&unrelated_state),
        binding,
        "replay must not enumerate unrelated repository state"
    );
}

#[test]
fn actual_v2_empty_selected_row_materializes_empty_pair_and_admits_only_mutable_leaf() {
    let fixture = fixture(true);
    let binding = materialize(&fixture);
    assert!(binding.baseline.is_empty());
    let intention: runner::CoreMaterializationIntentionV1 =
        serde_json::from_slice(&fs::read(&binding.intention_path).unwrap()).unwrap();
    let receipt: runner::CoreMaterializationReceiptV1 =
        serde_json::from_slice(&fs::read(&binding.receipt_path).unwrap()).unwrap();
    assert_eq!(intention.selected_vendoring.len(), 1);
    assert!(intention.selected_vendoring[0].vendor_bindings.is_empty());
    assert!(intention.intended_baseline.is_empty() && receipt.completed_baseline.is_empty());
    let artifact = ordinary_artifact(&fixture, binding);
    assert_eq!(
        runner::materializer_v4::admit_delivery_submission_v4(
            &submission("src/authored.rs"),
            &artifact,
            2
        ),
        Ok(DeliverySubmissionOutcome::Succeeded)
    );
    assert!(
        runner::materializer_v4::admit_delivery_submission_v4(
            &submission("vendor/a.bin"),
            &artifact,
            2
        )
        .is_err()
    );
}

#[test]
fn actual_v2_no_proofs_emits_zero_v2_records_and_issues_v3() {
    let fixture = fixture(true);
    let artifact = ordinary_artifact(&fixture, materialize(&fixture));
    fs::write(
        fixture.worktree.join("src/authored.rs"),
        b"no proof package\n",
    )
    .unwrap();
    let expected = expectation(&fixture.worktree, &fixture.base, false);
    let delivery = result(&expected, "src/authored.rs");
    let package = runner::establish_delivery_package_v4(&delivery, &expected, &artifact).unwrap();
    let accepted =
        runner::accept_delivery_v4_with_package_facts(&delivery, &expected, &artifact, &package)
            .unwrap();
    let assignment_digest = persist_v4_artifact(&fixture, &artifact);
    let scope =
        runner::delivery_scope_snapshot_digest(&fixture.worktree, &artifact.ordered_units).unwrap();
    let executions = runner::approved_command_bindings(&artifact.ordered_units)
        .into_iter()
        .enumerate()
        .map(|(index, binding)| runner::VerifiedCommandExecution {
            execution_id: format!("no-proof-execution-{index}"),
            command_id: binding.command_id,
            command_digest: binding.command_digest,
            result_digest: "a".repeat(64),
            scope_snapshot_digest: scope.clone(),
        })
        .collect();
    let validation = with_fixture_cwd(&fixture.root, || {
        runner::validation_issue_v3(
            &runner::ValidationRunnerRequest {
                workstream: Id("main".into()),
                action_id: Id("action-validator-no-proofs".into()),
                assignment_id: Id("validator-assignment-no-proofs".into()),
                run_revision: 2,
                producer_assignment_ids: vec![artifact.assignment_id.clone()],
                exact_commit: accepted.package_commit.0.clone(),
                exact_tree: accepted.package_tree.0.clone(),
                candidate_root: fixture.worktree.clone(),
                changed_paths: accepted.changed_paths.clone(),
                unchanged_recovery: false,
                execution_audit_ref: accepted.audit_ref,
                evidence_refs: accepted.focused_evidence_refs,
                lane_id: artifact.lane_id.clone(),
                attempt: artifact.attempt,
                validation_attempt: 1,
                semantic_round: 1,
                base_commit: artifact.base_commit.clone(),
                worktree: fixture.worktree.clone(),
                approved_units: artifact.ordered_units.clone(),
                producer_assignment_digest: assignment_digest,
                approved_command_executions: executions,
                package_authority: runner::ValidationPackageAuthority::RootedV4(Box::new(
                    artifact.clone(),
                )),
            },
            &transport(&fixture.root),
        )
    })
    .unwrap();
    let authority_path = Path::new(&validation.binding.spec_path)
        .parent()
        .unwrap()
        .join("authority.v3.json");
    let authority: serde_json::Value =
        serde_json::from_slice(&fs::read(&authority_path).unwrap()).unwrap();
    assert_eq!(authority["package_check_receipts"], serde_json::json!([]));
    let expected_digest = authority["authority_digest"].as_str().unwrap();
    let request = runner::ValidationRunnerRequest {
        workstream: Id("main".into()),
        action_id: Id("action-validator-no-proofs".into()),
        assignment_id: Id("validator-assignment-no-proofs".into()),
        run_revision: 2,
        producer_assignment_ids: vec![artifact.assignment_id.clone()],
        exact_commit: accepted.package_commit.0,
        exact_tree: accepted.package_tree.0,
        candidate_root: fixture.worktree.clone(),
        changed_paths: accepted.changed_paths,
        unchanged_recovery: false,
        execution_audit_ref: Ref("audit:v4".into()),
        evidence_refs: vec![Ref("e1".into()), Ref("e2".into())],
        lane_id: artifact.lane_id.clone(),
        attempt: artifact.attempt,
        validation_attempt: 1,
        semantic_round: 1,
        base_commit: artifact.base_commit.clone(),
        worktree: fixture.worktree.clone(),
        approved_units: artifact.ordered_units.clone(),
        producer_assignment_digest: persist_v4_artifact(&fixture, &artifact),
        approved_command_executions: Vec::new(),
        package_authority: runner::ValidationPackageAuthority::RootedV4(Box::new(artifact)),
    };
    assert!(
        load_v2_authority(&authority_path, expected_digest, &request).is_ok(),
        "strict no-proofs authority remains loadable"
    );
}

#[test]
fn actual_v2_packages_exact_initial_and_validation_triggered_recovery_deltas() {
    let fixture = fixture(false);
    let binding = materialize(&fixture);
    let ordinary = ordinary_artifact(&fixture, binding.clone());
    let first_expected = expectation(&fixture.worktree, &fixture.base, false);
    fs::write(
        fixture.worktree.join("src/authored.rs"),
        b"first package authored change\n",
    )
    .unwrap();
    let first = result(&first_expected, "src/authored.rs");
    let first_package =
        runner::establish_delivery_package_v4(&first, &first_expected, &ordinary).unwrap();
    let first_accepted = runner::accept_delivery_v4_with_package_facts(
        &first,
        &first_expected,
        &ordinary,
        &first_package,
    )
    .unwrap();
    assert_eq!(
        first_accepted.changed_paths,
        vec![
            "manifests/provenance.tsv",
            "src/authored.rs",
            "vendor/a.bin",
            "vendor/z.bin"
        ]
    );
    assert_eq!(
        git_text(
            &fixture.worktree,
            &[
                "diff-tree",
                "--no-commit-id",
                "--name-only",
                "-r",
                &first_package.package_commit.0
            ]
        )
        .lines()
        .collect::<Vec<_>>(),
        first_accepted.changed_paths
    );

    let foreign = result(&first_expected, "src/authored.rs");
    fs::write(
        fixture.worktree.join("foreign-tracked.txt"),
        b"foreign tracked drift\n",
    )
    .unwrap();
    assert!(runner::establish_delivery_package_v4(&foreign, &first_expected, &ordinary).is_err());
    git(
        &fixture.worktree,
        &["checkout", "--", "foreign-tracked.txt"],
    );
    fs::write(
        fixture.worktree.join("foreign-untracked.txt"),
        b"foreign untracked\n",
    )
    .unwrap();
    assert!(runner::establish_delivery_package_v4(&foreign, &first_expected, &ordinary).is_err());
    fs::remove_file(fixture.worktree.join("foreign-untracked.txt")).unwrap();
    fs::create_dir_all(fixture.worktree.join(".pi")).unwrap();
    fs::write(fixture.worktree.join(".pi/foreign.txt"), b"foreign pi\n").unwrap();
    assert!(runner::establish_delivery_package_v4(&foreign, &first_expected, &ordinary).is_err());
    fs::remove_file(fixture.worktree.join(".pi/foreign.txt")).unwrap();

    let trigger = Id("validator-main-L1-validation-r1".into());
    assert_ne!(trigger, ordinary.assignment_id);
    let recovery_id = Id("recovery-assignment-main-L1-a1".into());
    assert_ne!(trigger, recovery_id);
    let recovery = DeliveryAssignmentArtifactV4 {
        assignment_id: recovery_id.clone(),
        base_commit: first_package.package_commit.clone(),
        recovery: Some(RecoveryDirective {
            schema: "autopilot.recovery_directive.v1".into(),
            trigger_phase: "validation".into(),
            repair_mode: ModeId("forward-critical".into()),
            trigger_assignment_id: trigger,
            diagnosis_refs: vec![Ref("validator:diagnosis".into())],
            diagnosis_ids: vec![Id("criterion:U1".into())],
            diagnosis_details: vec!["validated defect".into()],
            original_gate: "validator:gate".into(),
            attempt_budget: 1,
        }),
        ..ordinary.clone()
    };
    assert_eq!(
        recovery.materialization, binding,
        "recovery retains source materialization identity"
    );
    assert!(runner::materializer_v4::replay_v4_materialization(&recovery).is_ok());
    let recovery_expected = expectation(&fixture.worktree, &first_package.package_commit, true);
    assert_eq!(
        recovery_expected.assignment_id, recovery_id,
        "expected_delivery_identity(main, L1, recovery-engineer, 1)"
    );
    fs::write(
        fixture.worktree.join("src/authored.rs"),
        b"recovery authored change\n",
    )
    .unwrap();
    let second = result(&recovery_expected, "src/authored.rs");
    let second_package =
        runner::establish_delivery_package_v4(&second, &recovery_expected, &recovery).unwrap();
    let second_accepted = runner::accept_delivery_v4_with_package_facts(
        &second,
        &recovery_expected,
        &recovery,
        &second_package,
    )
    .unwrap();
    assert_eq!(second_accepted.changed_paths, vec!["src/authored.rs"]);
    assert_eq!(
        fs::read(fixture.worktree.join("vendor/z.bin")).unwrap(),
        b"immutable\0non-utf8\xff"
    );
    assert_eq!(
        fs::metadata(fixture.worktree.join("vendor/a.bin"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );

    let facts = transport(&fixture.root);
    let second_identity = RunnerAssignmentV4 {
        assignment_id: Id("recovery-assignment-main-L1-a2".into()),
        attempt: 2,
        base_commit: second_package.package_commit.clone(),
        worktree: fixture.worktree.clone(),
        run_revision: 3,
        role_id: Id("recovery-engineer".into()),
        mode: ModeId("forward-critical".into()),
        action_id: Id("action-recovery-assignment-main-L1-a2".into()),
        lane_id: Id("L1".into()),
        workstream: Id("main".into()),
        session_file: fixture.root.join("second.session"),
        roster_assignment: "fixture".into(),
        approved_units: fixture.approved.units.clone(),
        recovery: recovery.recovery.clone(),
        approved_plan_binding_path: recovery.approved_plan_binding_path.clone(),
        approved_plan_binding_digest: recovery.approved_plan_binding_digest.clone(),
        approved_image_digest: recovery.approved_image_digest.clone(),
        selected_vendoring: recovery.selected_vendoring.clone(),
        materialization: recovery.materialization.clone(),
    };
    assert!(
        with_fixture_cwd(&fixture.root, || {
            runner::delivery_issue_v4_with_facts(&second_identity, &facts).is_err()
        }),
        "existing recovery identity authority forbids a second loop"
    );
}

fn transport(root: &Path) -> RunnerTransportFacts {
    unsafe {
        std::env::set_var(
            "AUTOPILOT_CHILD_ADDON_PATH",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
        );
    }
    let transport = root.parent().unwrap().join(format!(
        "v4-transport-{}",
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&transport).unwrap();
    let node = transport.join("node");
    let wrapper = transport.join("runner.mjs");
    fs::write(&node, b"node\n").unwrap();
    fs::write(&wrapper, b"runner\n").unwrap();
    RunnerTransportFacts::new(
        node,
        wrapper,
        broker_socket(),
        TEST_BROKER_CAPABILITY.to_owned(),
    )
    .unwrap()
}

fn assignment_v4(
    fixture: &Fixture,
    materialization: CoreMaterializationBindingV1,
) -> RunnerAssignmentV4 {
    RunnerAssignmentV4 {
        workstream: Id("main".into()),
        action_id: Id("action-main-L1".into()),
        assignment_id: Id("assignment-main-L1".into()),
        role_id: Id("implementer".into()),
        mode: ModeId("lane-delivery".into()),
        run_revision: 1,
        lane_id: Id("L1".into()),
        attempt: 1,
        base_commit: fixture.base.clone(),
        worktree: fixture.worktree.clone(),
        session_file: fixture.root.join("session.json"),
        roster_assignment: "fixture".into(),
        approved_units: fixture.approved.units.clone(),
        recovery: None,
        approved_plan_binding_path: fixture.request.approved_plan_binding_path.clone(),
        approved_plan_binding_digest: fixture.request.approved_plan_binding_digest.clone(),
        approved_image_digest: fixture.request.approved_image_digest.clone(),
        selected_vendoring: fixture.approved.vendoring.clone(),
        materialization,
    }
}

fn small_rooted_v2_proof_request() -> (Fixture, runner::ValidationRunnerRequest) {
    let fixture = fixture(false);
    let artifact = ordinary_artifact(&fixture, materialize(&fixture));
    fs::write(
        fixture.worktree.join("src/authored.rs"),
        b"proof candidate\n",
    )
    .unwrap();
    let expected = expectation(&fixture.worktree, &fixture.base, false);
    let delivery = result(&expected, "src/authored.rs");
    runner::materializer_v4::replay_v4_materialization(&artifact)
        .unwrap_or_else(|error| panic!("materialization replay before package: {error}"));
    let package = runner::establish_delivery_package_v4(&delivery, &expected, &artifact).unwrap();
    let accepted =
        runner::accept_delivery_v4_with_package_facts(&delivery, &expected, &artifact, &package)
            .unwrap();
    let assignment_digest = persist_v4_artifact(&fixture, &artifact);
    let scope =
        runner::delivery_scope_snapshot_digest(&fixture.worktree, &artifact.ordered_units).unwrap();
    let executions = runner::approved_command_bindings(&artifact.ordered_units)
        .into_iter()
        .enumerate()
        .map(|(index, binding)| runner::VerifiedCommandExecution {
            execution_id: format!("proof-execution-{index}"),
            command_id: binding.command_id,
            command_digest: binding.command_digest,
            result_digest: "a".repeat(64),
            scope_snapshot_digest: scope.clone(),
        })
        .collect();
    let request = runner::ValidationRunnerRequest {
        workstream: Id("main".into()),
        action_id: Id("action-validator-proof".into()),
        assignment_id: Id("validator-assignment-main-L1".into()),
        run_revision: 2,
        producer_assignment_ids: vec![artifact.assignment_id.clone()],
        exact_commit: accepted.package_commit.0.clone(),
        exact_tree: accepted.package_tree.0.clone(),
        candidate_root: fixture.worktree.clone(),
        changed_paths: accepted.changed_paths.clone(),
        unchanged_recovery: false,
        execution_audit_ref: accepted.audit_ref.clone(),
        evidence_refs: accepted.focused_evidence_refs.clone(),
        lane_id: artifact.lane_id.clone(),
        attempt: artifact.attempt,
        validation_attempt: 1,
        semantic_round: 1,
        base_commit: artifact.base_commit.clone(),
        worktree: fixture.worktree.clone(),
        approved_units: artifact.ordered_units.clone(),
        producer_assignment_digest: assignment_digest,
        approved_command_executions: executions,
        package_authority: runner::ValidationPackageAuthority::RootedV4(Box::new(artifact)),
    };
    (fixture, request)
}

#[test]
fn actual_v2_final_closure_emits_rooted_clean_and_vendor_proofs_before_v3_issue() {
    let (fixture, request) = small_rooted_v2_proof_request();
    let validation = with_fixture_cwd(&fixture.root, || {
        runner::validation_issue_v3(&request, &transport(&fixture.root))
    })
    .unwrap();
    let authority: serde_json::Value = serde_json::from_slice(
        &fs::read(
            Path::new(&validation.binding.spec_path)
                .parent()
                .unwrap()
                .join("authority.v3.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let records = authority["package_check_receipts"].as_array().unwrap();
    assert_eq!(records.len(), 2);
    assert!(records.iter().all(|record| {
        record["kind"] == "delivery-v2-package-proof"
            && record["evidence_ref"]
                .as_str()
                .is_some_and(|value| value.starts_with("v2-package-proof-receipt:"))
            && record["criterion_ids"]
                == authority["criteria"][0]["criterion_id"]
                    .as_str()
                    .map(|id| serde_json::json!([id]))
                    .unwrap()
    }));
    let kinds = records
        .iter()
        .map(|record| {
            serde_json::from_str::<serde_json::Value>(record["receipt_json"].as_str().unwrap())
                .unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        kinds,
        std::collections::BTreeSet::from([
            "clean-exact-package-tip".to_owned(),
            "vendored-bytes-match-origin".to_owned(),
        ])
    );
    assert_eq!(
        authority["criteria"][0]["package_check_receipt_refs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let assignment: kernel::generated::ValidationAssignmentV3 =
        serde_json::from_slice(&fs::read(validation.binding.assignment_path.unwrap()).unwrap())
            .unwrap();
    let context: kernel::generated::ValidationContextV3 =
        serde_json::from_slice(&fs::read(assignment.context_path.0).unwrap()).unwrap();
    assert!(context.citation_records.iter().all(|record| {
        !record
            .evidence_ref
            .0
            .starts_with("v2-package-proof-receipt:")
    }));
}

fn validation_authority_path(request: &runner::ValidationRunnerRequest) -> PathBuf {
    runner::validation_paths(
        &request.candidate_root,
        &request.workstream.0,
        &request.assignment_id,
    )
    .spec_path
    .parent()
    .unwrap()
    .join("authority.v3.json")
}

fn assert_no_validation_issue_artifacts(request: &runner::ValidationRunnerRequest) {
    let paths = runner::validation_paths(
        &request.candidate_root,
        &request.workstream.0,
        &request.assignment_id,
    );
    let base = paths.spec_path.parent().unwrap();
    for path in [
        base.join("authority.v3.json"),
        base.join("assignment.json"),
        paths.prompt_path,
        paths.spec_path,
        paths.carrier_path,
    ] {
        assert!(
            !path.exists(),
            "pre-issuance mutation wrote {}",
            path.display()
        );
    }
}

fn issue_small_rooted_v2_proof() -> (
    Fixture,
    runner::ValidationRunnerRequest,
    PathBuf,
    serde_json::Value,
) {
    let (fixture, request) = small_rooted_v2_proof_request();
    with_fixture_cwd(&fixture.root, || {
        runner::validation_issue_v3(&request, &transport(&fixture.root))
    })
    .unwrap();
    let path = validation_authority_path(&request);
    let authority = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    (fixture, request, path, authority)
}

fn rebind_v2_wrapper(authority: &mut serde_json::Value, record_index: usize) {
    let record = &mut authority["package_check_receipts"][record_index];
    let receipt: serde_json::Value =
        serde_json::from_str(record["receipt_json"].as_str().unwrap()).unwrap();
    let receipt_json = serde_json::to_string(&receipt).unwrap();
    let digest = sha(receipt_json.as_bytes());
    let proof_id = receipt["proof_id"].as_str().unwrap();
    record["receipt_json"] = serde_json::json!(receipt_json);
    record["receipt_digest"] = serde_json::json!(digest.clone());
    record["evidence_ref"] =
        serde_json::json!(format!("v2-package-proof-receipt:{proof_id}:{digest}"));
}

fn rebind_outer_authority(authority: &mut serde_json::Value) {
    let digest = runner::validation_authority::authority_digest(authority).unwrap();
    authority["authority_digest"] = serde_json::json!(digest);
}

fn assert_v2_proof_rejection(authority: serde_json::Value, label: &str) {
    let authority: kernel::generated::ValidationEvidenceAuthority =
        serde_json::from_value(authority).unwrap();
    let failure = runner::validation_authority::ValidationAuthorityIndex::from_authority(authority)
        .err()
        .unwrap_or_else(|| panic!("{label} unexpectedly admitted"));
    let diagnostic: serde_json::Value =
        serde_json::from_slice(&failure.canonical_bytes().unwrap()).unwrap();
    assert!(
        diagnostic["mismatches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| {
                row["code"]
                    .as_str()
                    .is_some_and(|code| code.starts_with("v2-package-proof"))
            }),
        "{label} did not reach a V2 proof binding/replay diagnostic: {diagnostic}"
    );
}

fn load_v2_authority(
    path: &Path,
    expected_digest: &str,
    request: &runner::ValidationRunnerRequest,
) -> Result<
    runner::validation_authority::ValidationAuthorityIndex,
    runner::validation_authority::AdmissionFailure,
> {
    let validation_id = Id(format!("validation-{}", request.assignment_id.0));
    let expected = runner::validation_authority::ValidationAuthorityExpectation {
        validation_id: &validation_id,
        assignment_id: &request.assignment_id,
        base_commit: &GitOid(request.base_commit.0.clone()),
        exact_commit: &GitOid(request.exact_commit.clone()),
        exact_tree: &GitOid(request.exact_tree.clone()),
        candidate_root: &request.candidate_root,
    };
    runner::validation_authority::ValidationAuthorityIndex::load_for(
        path,
        expected_digest,
        &expected,
    )
}

fn rooted_artifact_mut(
    request: &mut runner::ValidationRunnerRequest,
) -> &mut DeliveryAssignmentArtifactV4 {
    match &mut request.package_authority {
        runner::ValidationPackageAuthority::RootedV4(artifact) => artifact,
        runner::ValidationPackageAuthority::LegacyV3 => panic!("small fixture must use V4"),
    }
}

#[test]
fn actual_v2_preissuance_mutations_write_no_validator_artifacts() {
    let labels = [
        "candidate-vendor-bytes",
        "candidate-vendor-mode",
        "manifest-bytes",
        "manifest-order",
        "manifest-extra-newline",
        "package-commit-mismatch",
        "package-tree-mismatch",
        "foreign-candidate-residue",
        "approved-binding-digest-drift",
        "materialization-receipt-drift",
    ];
    for label in labels {
        let (fixture, mut request) = small_rooted_v2_proof_request();
        match label {
            "candidate-vendor-bytes" => {
                fs::write(fixture.worktree.join("vendor/a.bin"), b"wrong\0\xff").unwrap();
            }
            "candidate-vendor-mode" => fs::set_permissions(
                fixture.worktree.join("vendor/a.bin"),
                fs::Permissions::from_mode(0o644),
            )
            .unwrap(),
            "manifest-bytes" => {
                fs::write(
                    fixture.worktree.join("manifests/provenance.tsv"),
                    b"wrong\n",
                )
                .unwrap();
            }
            "manifest-order" => {
                let mut rows = fs::read(fixture.worktree.join("manifests/provenance.tsv")).unwrap();
                let split = rows.iter().position(|byte| *byte == b'\n').unwrap() + 1;
                let second = rows.split_off(split);
                rows.splice(..0, second);
                fs::write(fixture.worktree.join("manifests/provenance.tsv"), rows).unwrap();
            }
            "manifest-extra-newline" => {
                let mut rows = fs::read(fixture.worktree.join("manifests/provenance.tsv")).unwrap();
                rows.push(b'\n');
                fs::write(fixture.worktree.join("manifests/provenance.tsv"), rows).unwrap();
            }
            "package-commit-mismatch" => request.exact_commit = fixture.base.0.clone(),
            "package-tree-mismatch" => {
                request.exact_tree = git_text(&fixture.worktree, &["rev-parse", "HEAD~1^{tree}"])
                    .trim()
                    .to_owned();
            }
            "foreign-candidate-residue" => {
                fs::write(fixture.worktree.join("foreign-candidate.txt"), b"residue\n").unwrap();
            }
            "approved-binding-digest-drift" => {
                rooted_artifact_mut(&mut request).approved_plan_binding_digest = "0".repeat(64);
            }
            "materialization-receipt-drift" => {
                let path = rooted_artifact_mut(&mut request)
                    .materialization
                    .receipt_path
                    .clone();
                fs::write(path, b"receipt drift").unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            with_fixture_cwd(&fixture.root, || {
                runner::validation_issue_v3(&request, &transport(&fixture.root)).is_err()
            }),
            "{label} must fail before Validator issuance"
        );
        assert_no_validation_issue_artifacts(&request);
    }
}

#[derive(Clone, Copy)]
enum InnerV2Mutation {
    ReceiptText(&'static str),
    ReceiptOid(&'static str),
    ReceiptDigest(&'static str),
    ReceiptCount(&'static str),
    ReceiptOrdinals,
    ReceiptCriterionIds,
    ReceiptChangedPathOrder,
    WrapperKind,
    WrapperBinding,
    WrapperUnit,
    WrapperCriteria,
    WrapperRef,
    WrapperDigest,
    CopiedRecord,
    DuplicateRecord,
    ReorderedRecords,
}

fn mutate_inner_v2_authority(authority: &mut serde_json::Value, mutation: InnerV2Mutation) {
    {
        let record = &mut authority["package_check_receipts"][1];
        let mut receipt: serde_json::Value =
            serde_json::from_str(record["receipt_json"].as_str().unwrap()).unwrap();
        match mutation {
            InnerV2Mutation::ReceiptText(field) => {
                receipt[field] = serde_json::json!(format!("{field}-drift"));
            }
            InnerV2Mutation::ReceiptOid(field) => {
                receipt[field] = serde_json::json!("c".repeat(40))
            }
            InnerV2Mutation::ReceiptDigest(field) => {
                receipt[field] = serde_json::json!("0".repeat(64))
            }
            InnerV2Mutation::ReceiptCount(field) => {
                receipt[field] = serde_json::json!(receipt[field].as_u64().unwrap() + 1);
            }
            InnerV2Mutation::ReceiptOrdinals => {
                receipt["criterion_ordinals"] = serde_json::json!([2])
            }
            InnerV2Mutation::ReceiptCriterionIds => {
                receipt["criterion_ids"] = serde_json::json!(["AC-U1-9"]);
            }
            InnerV2Mutation::ReceiptChangedPathOrder => {
                receipt["changed_paths"].as_array_mut().unwrap().reverse();
            }
            InnerV2Mutation::WrapperKind
            | InnerV2Mutation::WrapperBinding
            | InnerV2Mutation::WrapperUnit
            | InnerV2Mutation::WrapperCriteria
            | InnerV2Mutation::WrapperRef
            | InnerV2Mutation::WrapperDigest
            | InnerV2Mutation::CopiedRecord
            | InnerV2Mutation::DuplicateRecord
            | InnerV2Mutation::ReorderedRecords => {}
        }
        record["receipt_json"] = serde_json::json!(serde_json::to_string(&receipt).unwrap());
    }
    rebind_v2_wrapper(authority, 1);
    match mutation {
        InnerV2Mutation::WrapperKind => {
            authority["package_check_receipts"][1]["kind"] = serde_json::json!("wrong-kind")
        }
        InnerV2Mutation::WrapperBinding => {
            authority["package_check_receipts"][1]["binding_id"] = serde_json::json!("wrong-proof")
        }
        InnerV2Mutation::WrapperUnit => {
            authority["package_check_receipts"][1]["unit_id"] = serde_json::json!("wrong-unit")
        }
        InnerV2Mutation::WrapperCriteria => {
            authority["package_check_receipts"][1]["criterion_ids"] = serde_json::json!(["wrong"])
        }
        InnerV2Mutation::WrapperRef => {
            authority["package_check_receipts"][1]["evidence_ref"] = serde_json::json!("wrong-ref")
        }
        InnerV2Mutation::WrapperDigest => {
            authority["package_check_receipts"][1]["receipt_digest"] =
                serde_json::json!("0".repeat(64))
        }
        InnerV2Mutation::CopiedRecord => {
            let copied = authority["package_check_receipts"][1].clone();
            authority["package_check_receipts"]
                .as_array_mut()
                .unwrap()
                .push(copied);
        }
        InnerV2Mutation::DuplicateRecord => {
            authority["package_check_receipts"][1] = authority["package_check_receipts"][0].clone();
        }
        InnerV2Mutation::ReorderedRecords => {
            authority["package_check_receipts"]
                .as_array_mut()
                .unwrap()
                .reverse();
        }
        _ => {}
    }
    rebind_outer_authority(authority);
}

#[test]
fn actual_v2_inner_receipt_and_replay_mutation_table_fails_closed() {
    let (_, _, _, authority) = issue_small_rooted_v2_proof();
    let cases = [
        ("schema", InnerV2Mutation::ReceiptText("schema")),
        ("proof-id", InnerV2Mutation::ReceiptText("proof_id")),
        ("kind", InnerV2Mutation::ReceiptText("kind")),
        ("ordinals", InnerV2Mutation::ReceiptOrdinals),
        ("criterion-ids", InnerV2Mutation::ReceiptCriterionIds),
        (
            "producer-assignment",
            InnerV2Mutation::ReceiptText("delivery_producer_assignment_id"),
        ),
        (
            "producer-path",
            InnerV2Mutation::ReceiptText("delivery_assignment_path"),
        ),
        (
            "producer-digest",
            InnerV2Mutation::ReceiptDigest("delivery_producer_assignment_digest"),
        ),
        ("base-commit", InnerV2Mutation::ReceiptOid("base_commit")),
        (
            "package-commit",
            InnerV2Mutation::ReceiptOid("package_commit"),
        ),
        ("package-tree", InnerV2Mutation::ReceiptOid("package_tree")),
        (
            "changed-path-order",
            InnerV2Mutation::ReceiptChangedPathOrder,
        ),
        (
            "approved-binding-path",
            InnerV2Mutation::ReceiptText("approved_plan_binding_path"),
        ),
        (
            "approved-binding-digest",
            InnerV2Mutation::ReceiptDigest("approved_plan_binding_digest"),
        ),
        (
            "approved-image",
            InnerV2Mutation::ReceiptDigest("approved_image_digest"),
        ),
        (
            "materialization-path",
            InnerV2Mutation::ReceiptText("materialization_receipt_path"),
        ),
        (
            "materialization-digest",
            InnerV2Mutation::ReceiptDigest("materialization_receipt_digest"),
        ),
        (
            "scope-count",
            InnerV2Mutation::ReceiptCount("package_scope_files_count"),
        ),
        (
            "binding-count",
            InnerV2Mutation::ReceiptCount("vendor_binding_ids_count"),
        ),
        (
            "vendor-witness-count",
            InnerV2Mutation::ReceiptCount("candidate_vendor_tree_witness_count"),
        ),
        (
            "manifest-witness-count",
            InnerV2Mutation::ReceiptCount("candidate_manifest_tree_witness_count"),
        ),
        (
            "scope-digest",
            InnerV2Mutation::ReceiptDigest("package_scope_files_digest"),
        ),
        (
            "binding-digest",
            InnerV2Mutation::ReceiptDigest("vendor_binding_ids_digest"),
        ),
        (
            "vendor-witness-digest",
            InnerV2Mutation::ReceiptDigest("candidate_vendor_tree_witness_digest"),
        ),
        (
            "manifest-witness-digest",
            InnerV2Mutation::ReceiptDigest("candidate_manifest_tree_witness_digest"),
        ),
        (
            "proof-subject",
            InnerV2Mutation::ReceiptDigest("proof_subject_digest"),
        ),
        (
            "expected-text",
            InnerV2Mutation::ReceiptDigest("expected_text_digest"),
        ),
        ("wrapper-kind", InnerV2Mutation::WrapperKind),
        ("wrapper-binding", InnerV2Mutation::WrapperBinding),
        ("wrapper-unit", InnerV2Mutation::WrapperUnit),
        ("wrapper-criterion", InnerV2Mutation::WrapperCriteria),
        ("wrapper-ref", InnerV2Mutation::WrapperRef),
        ("wrapper-digest", InnerV2Mutation::WrapperDigest),
        ("copied-record", InnerV2Mutation::CopiedRecord),
        ("duplicate-record", InnerV2Mutation::DuplicateRecord),
        ("reordered-records", InnerV2Mutation::ReorderedRecords),
    ];
    for (label, mutation) in cases {
        let mut mutated = authority.clone();
        mutate_inner_v2_authority(&mut mutated, mutation);
        assert_v2_proof_rejection(mutated, label);
    }
}

#[test]
fn actual_v2_external_assignment_root_rejects_omitted_v2_record() {
    let (fixture, request, path, mut authority) = issue_small_rooted_v2_proof();
    let expected_digest = authority["authority_digest"].as_str().unwrap().to_owned();
    let removed = authority["package_check_receipts"]
        .as_array_mut()
        .unwrap()
        .remove(1);
    let removed_ref = removed["evidence_ref"].as_str().unwrap();
    for criterion in authority["criteria"].as_array_mut().unwrap() {
        criterion["package_check_receipt_refs"]
            .as_array_mut()
            .unwrap()
            .retain(|reference| reference.as_str() != Some(removed_ref));
    }
    rebind_outer_authority(&mut authority);
    let omitted_path = path.with_file_name("authority-omitted.v3.json");
    fs::write(
        &omitted_path,
        serde_json::to_vec_pretty(&authority).unwrap(),
    )
    .unwrap();
    assert!(
        load_v2_authority(&omitted_path, &expected_digest, &request).is_err(),
        "an internally rebound authority cannot choose a reduced external root"
    );
    assert!(fixture.worktree.exists());
}

#[test]
fn actual_v2_live_replay_rejects_candidate_and_manifest_drift_without_origin_reads() {
    for label in ["candidate-bytes", "candidate-mode", "manifest-bytes"] {
        let (fixture, request, path, authority) = issue_small_rooted_v2_proof();
        let original_authority_bytes = fs::read(&path).unwrap();
        let expected_digest = authority["authority_digest"].as_str().unwrap();
        match label {
            "candidate-bytes" => {
                fs::write(fixture.worktree.join("vendor/a.bin"), b"live drift\0\xff").unwrap();
            }
            "candidate-mode" => fs::set_permissions(
                fixture.worktree.join("vendor/a.bin"),
                fs::Permissions::from_mode(0o644),
            )
            .unwrap(),
            "manifest-bytes" => fs::write(
                fixture.worktree.join("manifests/provenance.tsv"),
                b"baseline manifest drift\n",
            )
            .unwrap(),
            _ => unreachable!(),
        }
        assert_eq!(fs::read(&path).unwrap(), original_authority_bytes);
        let failure = load_v2_authority(&path, expected_digest, &request)
            .err()
            .unwrap();
        let diagnostic: serde_json::Value =
            serde_json::from_slice(&failure.canonical_bytes().unwrap()).unwrap();
        assert!(
            diagnostic["mismatches"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| { row["code"] == "v2-package-proof-replay" }),
            "{label} did not fail through V2 replay: {diagnostic}"
        );
    }
}

#[test]
fn actual_v2_rooted_admission_and_issue_require_complete_materialization_pair() {
    let rooted = fixture(false);
    let binding = materialize(&rooted);
    let artifact = ordinary_artifact(&rooted, binding.clone());
    assert_eq!(
        runner::materializer_v4::admit_delivery_submission_v4(
            &submission("src/authored.rs"),
            &artifact,
            2
        ),
        Ok(DeliverySubmissionOutcome::Succeeded)
    );

    let mut fabricated = artifact.clone();
    fabricated.materialization.baseline.clear();
    assert!(
        runner::materializer_v4::admit_delivery_submission_v4(
            &submission("src/authored.rs"),
            &fabricated,
            2
        )
        .is_err(),
        "shape-valid fabricated root is not authority"
    );
    let original_binding = fs::read(&rooted.request.approved_plan_binding_path).unwrap();
    fs::write(&rooted.request.approved_plan_binding_path, b"tampered root").unwrap();
    assert!(
        runner::materializer_v4::admit_delivery_submission_v4(
            &submission("src/authored.rs"),
            &artifact,
            2
        )
        .is_err(),
        "tampered root"
    );
    fs::write(&rooted.request.approved_plan_binding_path, original_binding).unwrap();
    let original_intention = fs::read(&binding.intention_path).unwrap();
    fs::write(&binding.intention_path, b"tampered intention").unwrap();
    assert!(
        runner::materializer_v4::admit_delivery_submission_v4(
            &submission("src/authored.rs"),
            &artifact,
            2
        )
        .is_err()
    );
    fs::write(&binding.intention_path, original_intention).unwrap();
    let original_receipt = fs::read(&binding.receipt_path).unwrap();
    fs::write(&binding.receipt_path, b"tampered receipt").unwrap();
    assert!(
        runner::materializer_v4::admit_delivery_submission_v4(
            &submission("src/authored.rs"),
            &artifact,
            2
        )
        .is_err()
    );
    fs::write(&binding.receipt_path, &original_receipt).unwrap();
    fs::remove_file(&binding.receipt_path).unwrap();
    assert!(
        runner::materializer_v4::admit_delivery_submission_v4(
            &submission("src/authored.rs"),
            &artifact,
            2
        )
        .is_err(),
        "missing receipt"
    );
    fs::write(&binding.receipt_path, original_receipt).unwrap();

    let issue = with_fixture_cwd(&rooted.root, || {
        runner::delivery_issue_v4_with_facts(
            &assignment_v4(&rooted, binding.clone()),
            &transport(&rooted.root),
        )
    })
    .unwrap();
    assert!(Path::new(issue.binding.assignment_path.as_ref().unwrap()).exists());
    assert!(
        Path::new(&issue.binding.prompt_path).exists()
            && Path::new(&issue.binding.spec_path).exists()
    );

    let missing_receipt = fixture(false);
    let binding = materialize(&missing_receipt);
    fs::remove_file(&binding.receipt_path).unwrap();
    let paths = runner::delivery_paths(&missing_receipt.worktree, &Id("assignment-main-L1".into()));
    assert!(with_fixture_cwd(&missing_receipt.root, || {
        runner::delivery_issue_v4_with_facts(
            &assignment_v4(&missing_receipt, binding),
            &transport(&missing_receipt.root),
        )
        .is_err()
    }));
    assert!(
        !paths.prompt_path.exists() && !paths.spec_path.exists() && !paths.carrier_path.exists()
    );
    assert!(
        !missing_receipt
            .worktree
            .join(".pi/autopilot/runner/assignments/assignment-main-L1.json")
            .exists()
    );
}

fn git_dated(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_AUTHOR_DATE", "2001-02-03T04:05:06 +0000")
        .env("GIT_COMMITTER_DATE", "2001-02-03T04:05:06 +0000")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "dated git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn w0_repository() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/v4-materializer-fixtures/w0-fixed");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("upstream")).unwrap();
    fs::create_dir_all(root.join("src")).unwrap();
    for index in 0..84_u8 {
        let path = root.join(format!("upstream/origin-{index:03}.bin"));
        fs::write(&path, [index, 0, 0xff, b'v']).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        if index == 0 {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    for index in 0..30_u8 {
        fs::write(
            root.join(format!("src/authored-{index:03}.rs")),
            format!("base-{index:03}\n"),
        )
        .unwrap();
    }
    git(&root, &["init", "--quiet"]);
    git(&root, &["config", "user.email", "w0@example.invalid"]);
    git(&root, &["config", "user.name", "W0"]);
    git(&root, &["add", "."]);
    git_dated(
        &root,
        &["commit", "--quiet", "-m", "W0 fixed binary origins"],
    );
    fs::canonicalize(root).unwrap()
}

fn w0_plan(_root: &Path) -> String {
    let vendors = (0..84)
        .map(|index| {
            serde_json::json!({
                "binding_id":format!("binding-{index:03}"),
                "origin_path":format!("upstream/origin-{index:03}.bin"),
                "destination":format!("vendor/leaf-{index:03}.bin"),
            })
        })
        .collect::<Vec<_>>();
    let mut files = (0..84)
        .map(|index| format!("vendor/leaf-{index:03}.bin"))
        .chain(std::iter::once("manifests/provenance.tsv".to_owned()))
        .chain((0..30).map(|index| format!("src/authored-{index:03}.rs")))
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    serde_json::json!({
        "schema":"planning.work-map.v2",
        "units":[{
            "id":"U1", "kind":"implementation", "objective":"close W0 binary vendoring",
            "criteria":["clean exact final package", "all origin bytes and modes replay"],
            "depends_on":[], "files":files, "package_scope_files":files,
            "commands":[command()],
            "package_proofs":[
                {"proof_id":"clean", "kind":"clean-exact-package-tip", "criterion_ordinals":[1,2], "expected":"exact clean package", "vendor_binding_ids":[]},
                {"proof_id":"vendor", "kind":"vendored-bytes-match-origin", "criterion_ordinals":[1,2], "expected":"all 84 origin bytes and modes", "vendor_binding_ids":(0..84).map(|index| format!("binding-{index:03}")).collect::<Vec<_>>()}
            ],
            "vendor_bindings":vendors,
            "provenance_manifest_destination":"manifests/provenance.tsv", "links":["atom-1"]
        }]
    })
    .to_string()
}

fn w0_fixture() -> Fixture {
    let root = w0_repository();
    let (atoms, atom_digest) = atom_registry(&root);
    let carrier = actual_carrier_named(&root, "w0", &w0_plan(&root));
    let admitted = planning::work_map_v2::admit_work_map_v2_actual_carrier_for_test_only(
        &carrier,
        WorkMapV2AdmissionContext {
            atom_registry_path: &atoms,
            atom_registry_digest: &atom_digest,
            recovery_subject: None,
        },
    )
    .unwrap();
    let image = root.join(".pi/autopilot/main/approved-w0.json");
    let binding = root.join(".pi/autopilot/main/approved-w0-binding.json");
    let promotion =
        seam::write_approved_plan_v2_for_test_only("main", &image, &binding, &admitted).unwrap();
    let approved = seam::read_approved_plan_v2(&binding, &promotion.binding_sha256).unwrap();
    let base = Sha(git_text(&root, &["rev-parse", "HEAD"]).trim().to_owned());
    let worktree = root.parent().unwrap().join("w0-delivery-worktree-fixed");
    let _ = fs::remove_dir_all(&worktree);
    git(
        &root,
        &[
            "worktree",
            "add",
            "--detach",
            "--quiet",
            worktree.to_str().unwrap(),
            &base.0,
        ],
    );
    let worktree = fs::canonicalize(worktree).unwrap();
    let request = CoreMaterializationRequestV4 {
        workstream: Id("main".into()),
        assignment_id: Id("assignment-main-W0".into()),
        lane_id: Id("W0".into()),
        attempt: 1,
        base_commit: base.clone(),
        worktree: worktree.clone(),
        approved_plan_binding_path: binding.display().to_string(),
        approved_plan_binding_digest: promotion.binding_sha256,
        approved_image_digest: promotion.approved_plan_sha256,
        selected_units: approved.units.clone(),
        selected_vendoring: approved.vendoring.clone(),
    };
    Fixture {
        root,
        worktree,
        approved,
        request,
        base,
    }
}

fn persist_v4_artifact(fixture: &Fixture, artifact: &DeliveryAssignmentArtifactV4) -> String {
    let paths = runner::delivery_paths(&fixture.worktree, &artifact.assignment_id);
    let path = paths
        .spec_path
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .join("assignments")
        .join(format!("{}.json", artifact.assignment_id.0));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let bytes = serde_json::to_vec_pretty(artifact).unwrap();
    fs::write(path, &bytes).unwrap();
    sha(&bytes)
}

fn common_objects(root: &Path) -> PathBuf {
    let common = git_text(root, &["rev-parse", "--git-common-dir"]);
    let common = PathBuf::from(common.trim());
    if common.is_absolute() {
        common
    } else {
        root.join(common)
    }
}

#[test]
fn actual_v2_w0_scale_packed_rooted_proofs_are_complete_and_bounded() {
    let fixture = w0_fixture();
    assert_eq!(fixture.approved.units[0].files.len(), 115);
    assert_eq!(fixture.approved.units[0].commands.len(), 1);
    assert!(fixture.approved.units[0].criterion_text.len() >= 2);
    let package_row = &fixture.approved.package_authority[0];
    assert_eq!(package_row.package_scope_files.len(), 115);
    assert_eq!(package_row.package_proofs.len(), 2);
    assert_eq!(
        package_row
            .package_proofs
            .iter()
            .find(|proof| proof.kind
                == kernel::generated::PackageProofKindV2::VendoredBytesMatchOrigin)
            .unwrap()
            .vendor_binding_ids
            .len(),
        84
    );
    let materialization = materialize(&fixture);
    assert_eq!(materialization.baseline.len(), 85);
    assert_eq!(
        materialization
            .baseline
            .iter()
            .filter(|leaf| leaf.kind == "vendor")
            .count(),
        84
    );
    assert_eq!(
        materialization
            .baseline
            .iter()
            .filter(|leaf| leaf.kind == "vendor" && leaf.mode == "100755")
            .count(),
        1
    );
    assert_eq!(
        materialization
            .baseline
            .iter()
            .filter(|leaf| leaf.kind == "vendor" && leaf.mode == "100644")
            .count(),
        83
    );
    assert_eq!(
        fs::metadata(fixture.worktree.join("vendor/leaf-000.bin"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    assert_eq!(
        fs::read(fixture.worktree.join("vendor/leaf-001.bin")).unwrap(),
        [1, 0, 0xff, b'v']
    );
    for index in 0..30_u8 {
        fs::write(
            fixture.worktree.join(format!("src/authored-{index:03}.rs")),
            format!("authored-{index:03}\n"),
        )
        .unwrap();
    }
    let artifact = ordinary_artifact(&fixture, materialization);
    let mut expected = expectation(&fixture.worktree, &fixture.base, false);
    expected.assignment_id = artifact.assignment_id.clone();
    expected.lane_id = artifact.lane_id.clone();
    let mut delivery = result(&expected, "src/authored-000.rs");
    delivery.actual_changed_paths = (0..30)
        .map(|index| ContractPath(format!("src/authored-{index:03}.rs")))
        .collect();
    runner::materializer_v4::replay_v4_materialization(&artifact).unwrap();
    let _package = runner::establish_delivery_package_v4(&delivery, &expected, &artifact).unwrap();
    // Fix the package object identity so the independently hard-coded W0
    // commitments below are stable across runs of this strict fixture.
    git_dated(
        &fixture.worktree,
        &[
            "commit",
            "--amend",
            "--no-edit",
            "--date=2001-02-03T04:05:06 +0000",
        ],
    );
    let package = runner::PackageFacts {
        package_commit: Sha(git_text(&fixture.worktree, &["rev-parse", "HEAD"])
            .trim()
            .to_owned()),
        package_tree: Sha(git_text(&fixture.worktree, &["rev-parse", "HEAD^{tree}"])
            .trim()
            .to_owned()),
    };
    let accepted =
        runner::accept_delivery_v4_with_package_facts(&delivery, &expected, &artifact, &package)
            .unwrap();
    let mut expected_changed_paths = (0..84)
        .map(|index| format!("vendor/leaf-{index:03}.bin"))
        .chain(std::iter::once("manifests/provenance.tsv".to_owned()))
        .chain((0..30).map(|index| format!("src/authored-{index:03}.rs")))
        .collect::<Vec<_>>();
    expected_changed_paths.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    assert_eq!(accepted.changed_paths, expected_changed_paths);
    let assignment_digest = persist_v4_artifact(&fixture, &artifact);

    // The source authority and candidate worktree use the common object store;
    // force it into packs after the candidate exists and before V2 evaluation.
    git(&fixture.root, &["gc", "--aggressive", "--prune=now"]);
    let common = common_objects(&fixture.worktree);
    let packs = fs::read_dir(common.join("objects/pack"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "pack"))
        .count();
    assert!(
        packs > 0,
        "candidate/common object store has no pack evidence"
    );
    for oid in [
        &fixture.base.0,
        &accepted.package_commit.0,
        &accepted.package_tree.0,
    ] {
        assert!(
            !common
                .join("objects")
                .join(&oid[..2])
                .join(&oid[2..])
                .exists(),
            "required object unexpectedly remained loose: {oid}"
        );
    }

    let scope =
        runner::delivery_scope_snapshot_digest(&fixture.worktree, &artifact.ordered_units).unwrap();
    let executions = runner::approved_command_bindings(&artifact.ordered_units)
        .into_iter()
        .enumerate()
        .map(|(index, binding)| runner::VerifiedCommandExecution {
            execution_id: format!("w0-execution-{index}"),
            command_id: binding.command_id,
            command_digest: binding.command_digest,
            result_digest: "a".repeat(64),
            scope_snapshot_digest: scope.clone(),
        })
        .collect();
    let validation = with_fixture_cwd(&fixture.root, || {
        runner::validation_issue_v3(
            &runner::ValidationRunnerRequest {
                workstream: Id("main".into()),
                action_id: Id("action-validator-W0".into()),
                assignment_id: Id("validator-assignment-main-W0".into()),
                run_revision: 2,
                producer_assignment_ids: vec![artifact.assignment_id.clone()],
                exact_commit: accepted.package_commit.0.clone(),
                exact_tree: accepted.package_tree.0.clone(),
                candidate_root: fixture.worktree.clone(),
                changed_paths: accepted.changed_paths.clone(),
                unchanged_recovery: false,
                execution_audit_ref: accepted.audit_ref.clone(),
                evidence_refs: accepted.focused_evidence_refs.clone(),
                lane_id: artifact.lane_id.clone(),
                attempt: artifact.attempt,
                validation_attempt: 1,
                semantic_round: 1,
                base_commit: artifact.base_commit.clone(),
                worktree: fixture.worktree.clone(),
                approved_units: artifact.ordered_units.clone(),
                producer_assignment_digest: assignment_digest,
                approved_command_executions: executions,
                package_authority: runner::ValidationPackageAuthority::RootedV4(Box::new(artifact)),
            },
            &transport(&fixture.root),
        )
    })
    .unwrap();
    let authority: serde_json::Value = serde_json::from_slice(
        &fs::read(
            Path::new(&validation.binding.spec_path)
                .parent()
                .unwrap()
                .join("authority.v3.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let records = authority["package_check_receipts"].as_array().unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(accepted.changed_paths.len(), 115);
    let package_refs = records
        .iter()
        .map(|record| record["evidence_ref"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        records
            .iter()
            .map(|record| record["binding_id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["clean", "vendor"]
    );
    assert!(
        records
            .iter()
            .all(|record| { record["criterion_ids"] == serde_json::json!(["AC-U1-1", "AC-U1-2"]) })
    );
    assert!(
        authority["criteria"]
            .as_array()
            .unwrap()
            .iter()
            .all(|criterion| {
                criterion["package_check_receipt_refs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|reference| reference.as_str().unwrap())
                    .collect::<Vec<_>>()
                    == package_refs
                    && criterion["allowed_citation_refs"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|reference| {
                            !reference
                                .as_str()
                                .unwrap()
                                .starts_with("v2-package-proof-receipt:")
                        })
            })
    );
    let receipts = records
        .iter()
        .map(|record| {
            let text = record["receipt_json"].as_str().unwrap();
            assert!(!text.is_empty() && text.len() < 16 * 1024);
            serde_json::from_str::<serde_json::Value>(text).unwrap()
        })
        .collect::<Vec<_>>();
    let vendor = receipts
        .iter()
        .find(|receipt| receipt["kind"] == "vendored-bytes-match-origin")
        .unwrap();
    assert!(
        receipts
            .iter()
            .all(|receipt| receipt["package_scope_files_count"] == 115)
    );
    assert_eq!(vendor["vendor_binding_ids_count"], 84);
    assert_eq!(vendor["candidate_vendor_tree_witness_count"], 84);
    assert_eq!(vendor["candidate_manifest_tree_witness_count"], 1);
    // These are independent fixed W0 commitments, recorded from the first
    // deterministic fixture run rather than produced by a runner helper.
    assert_eq!(
        vendor["package_scope_files_digest"],
        "684dc1ed1e42b456a3019425afb28e26e5719ff0fa6ccb739c8062df94430c81"
    );
    assert_eq!(
        vendor["vendor_binding_ids_digest"],
        "d8ec7e3341abc413a9f1d8abda5a2ada9d4ee7763896f030a7738f24f48fbaaf"
    );
    assert_eq!(
        vendor["candidate_vendor_tree_witness_digest"],
        "581f97046c2e4d8caed8431c20ac11cd74f0f9ea4f74e3de30020d06cfb778a4"
    );
    assert_eq!(
        vendor["candidate_manifest_tree_witness_digest"],
        "453501b727665b7f4ddba84a5589f81cc5c56dd18eb92dacb87e33c1ee9d5e86"
    );
    for receipt in &receipts {
        assert_eq!(
            receipt["proof_subject_digest"].as_str().unwrap(),
            independently_recomputed_proof_subject_digest(receipt),
            "complete subject is independently bound without checkout-path fixtures"
        );
    }
}

#[test]
fn receipt_v1_validator_issue_uses_v4_assignment_without_value_attempts() {
    let (fixture, request) = small_rooted_v2_proof_request();
    let issue = with_fixture_cwd(&fixture.root, || {
        runner::validation_issue_v4(&request, &transport(&fixture.root))
    })
    .expect("fresh receipt_v1 Validator issue");
    let assignment_path = issue
        .receipt_binding
        .assignment_path
        .as_ref()
        .expect("fresh Validator assignment path");
    let assignment: kernel::generated::ValidationAssignmentV4 =
        serde_json::from_slice(&fs::read(assignment_path).expect("read V4 assignment"))
            .expect("parse V4 assignment");
    assert_eq!(assignment.schema.0, "autopilot.validation_assignment.v4");
    assert_eq!(
        assignment.admission_mode,
        kernel::generated::AdmissionMode::ReceiptV1
    );
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(assignment_path).expect("read V4 assignment bytes"))
            .expect("assignment JSON");
    assert!(value.get("max_value_attempts").is_none());
    let spec: kernel::generated::AgentRunSpecV5 = serde_json::from_slice(
        &fs::read(&issue.receipt_binding.spec_path).expect("read V5 Validator spec"),
    )
    .expect("parse V5 Validator spec");
    assert_eq!(
        spec.admission_mode,
        kernel::generated::AdmissionMode::ReceiptV1
    );
    assert_eq!(spec.run_revision, request.run_revision);
}
