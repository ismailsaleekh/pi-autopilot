//! Opt-in release capture for the three genuine WorkMap V2 Pi paths.
//!
//! This target is deliberately not general live-test infrastructure.  The
//! ignored test below is the one release-gate invocation; its ordinary tests
//! only exercise the refusal/report envelope and never resolve or invoke Pi.

use std::collections::BTreeSet;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use drivers::planning::{self, WorkMapV2AdmissionContext};
use drivers::runner::{
    self, AcceptedPlanningArtifactBinding, PlanningRunnerRequest, RunnerTaskDocument,
};
use drivers::seam::{self, ApprovedPlanV2BindingV1};
use kernel::generated::{
    AgentRunSpec, ContractId, Id, ModeId, PlanningAtomKind, PlanningAtomRegistryAtom, Ref,
    TerminalRoute, ToolName, ValidationAssignmentKind, WorkMapV2,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const OPT_IN: &str = "AUTOPILOT_RUN_REAL_V2_CAPTURE";
const CAPTURE_ROOT: &str = "AUTOPILOT_V2_CAPTURE_ROOT";
const WORKSTREAM: &str = "work-map-v2-capture";
const AUTHORITY_SET: &str = "capture-v2-authority";
const PI_VERSION: &str = "0.84.1";
const CAPTURE_RUN_REVISION: u64 = 1;

const COMPILER: ExpectedTuple = ExpectedTuple {
    role: "plan-compiler",
    mode: "initial-plan",
    profile: "planning.work-map.v2:autopilot_submit_plan_cluster",
    tool: "autopilot_submit_plan_cluster",
    schema_digest: "07750be5a58112e8b3f956f261d33ef75e3a71b9b13b75be2192cfc43adbbc9a",
};
const SYNTHESIZER: ExpectedTuple = ExpectedTuple {
    role: "plan-synthesizer",
    mode: "initial-plan",
    profile: "planning.work-map.v2:autopilot_submit_synthesis",
    tool: "autopilot_submit_synthesis",
    schema_digest: "07750be5a58112e8b3f956f261d33ef75e3a71b9b13b75be2192cfc43adbbc9a",
};
const RECOVERY: ExpectedTuple = ExpectedTuple {
    role: "recovery-engineer",
    mode: "planning-repair",
    profile: "recovery-work-map.v2",
    tool: "autopilot_emit_status",
    schema_digest: "3efc6b230002a7216a3e471441a755672f2a750658483e7882b1fa3edb549495",
};

static PROCESS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy)]
struct ExpectedTuple {
    role: &'static str,
    mode: &'static str,
    profile: &'static str,
    tool: &'static str,
    schema_digest: &'static str,
}

#[derive(Clone)]
struct FixtureInputs {
    atom_registry_path: PathBuf,
    atom_registry_digest: String,
    task_atoms: AcceptedPlanningArtifactBinding,
    scout_findings: AcceptedPlanningArtifactBinding,
    blocked_review: AcceptedPlanningArtifactBinding,
}

struct CapturedOutput {
    admitted: planning::ApprovedWorkMapV2,
    artifact: AcceptedPlanningArtifactBinding,
    record: CaptureRecord,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct StrictCarrierV2 {
    schema: String,
    action_id: String,
    assignment_id: String,
    run_revision: u64,
    workstream: String,
    role_id: String,
    mode: String,
    boundary_id: String,
    result_contract: String,
    prompt_path: String,
    prompt_digest: String,
    boundary_digest: String,
    result_contract_digest: String,
    settings_digest: String,
    context_digest: String,
    skills_digest: String,
    subscription_digest: String,
    runtime_extension_digest: String,
    spec_digest: String,
    spec_path: String,
    carrier_path: String,
    carrier_channel: String,
    tool_name: String,
    tool_schema_digest: String,
    carrier_binding: String,
    pi_version: String,
    terminal_route: TerminalRoute,
    atom_registry_path: String,
    atom_registry_digest: String,
    repository_manifest_path: String,
    repository_manifest_digest: String,
    repository_head_commit: String,
    repository_head_tree: String,
    raw_output: String,
}

/// The serialized report is a closed, versioned evidence format.  It contains
/// only the local carrier/spec facts needed to replay each capture; it never
/// represents a provider wire transcript.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CaptureReport {
    schema: String,
    raw_output_description: String,
    records: Vec<CaptureRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CaptureRecord {
    destination: String,
    role: String,
    mode: String,
    profile: String,
    tool: String,
    schema_digest: String,
    provider: String,
    model: String,
    thinking: String,
    route: String,
    pi_version: String,
    spec_path: String,
    spec_digest: String,
    carrier_path: String,
    carrier_digest: String,
    raw_output_digest: String,
    raw_output: String,
    session_id: String,
    atom_registry_path: String,
    atom_registry_digest: String,
    repository_manifest_path: String,
    repository_manifest_digest: String,
    repository_head_commit: String,
    repository_head_tree: String,
    approved_binding_path: String,
    approved_binding_digest: String,
    approved_image_digest: String,
    strict_admission: String,
}

#[derive(Debug)]
enum CaptureRequest {
    Skip,
    Run(PathBuf),
}

struct CurrentDirGuard {
    previous: PathBuf,
}

impl CurrentDirGuard {
    fn enter(path: &Path) -> Result<Self, String> {
        let previous =
            env::current_dir().map_err(|error| format!("capture current directory: {error}"))?;
        env::set_current_dir(path)
            .map_err(|error| format!("capture fixture current directory: {error}"))?;
        Ok(Self { previous })
    }
}

impl Drop for CurrentDirGuard {
    fn drop(&mut self) {
        let _ = env::set_current_dir(&self.previous);
    }
}

struct EnvironmentGuard {
    saved: Vec<(&'static str, Option<OsString>)>,
}

impl EnvironmentGuard {
    fn capture(keys: &[&'static str]) -> Self {
        Self {
            saved: keys.iter().map(|key| (*key, env::var_os(key))).collect(),
        }
    }

    fn set(&self, key: &'static str, value: impl AsRef<OsStr>) {
        // Process-wide state is protected by PROCESS_LOCK for the complete
        // ignored capture.  Drop restores every changed key on all exits.
        unsafe { env::set_var(key, value) };
    }
}

impl Drop for EnvironmentGuard {
    fn drop(&mut self) {
        for (key, value) in self.saved.iter().rev() {
            match value {
                Some(value) => unsafe { env::set_var(key, value) },
                None => unsafe { env::remove_var(key) },
            }
        }
    }
}

#[test]
fn capture_opt_in_requires_both_explicit_values_without_resolving_pi() {
    assert!(matches!(
        capture_request(None, None),
        Ok(CaptureRequest::Skip)
    ));
    assert!(matches!(
        capture_request(Some("0"), Some(OsString::from("/outside/capture"))),
        Ok(CaptureRequest::Skip)
    ));
    assert!(
        capture_request(Some("1"), None)
            .expect_err("missing root must refuse")
            .contains(CAPTURE_ROOT)
    );
}

#[test]
fn capture_root_refuses_relative_existing_in_repo_and_symlinked_paths_without_pi() {
    let package_root = package_root().expect("package root");
    let temp = fs::canonicalize(env::temp_dir()).expect("canonical temp root");
    let base = temp.join(format!(
        "work-map-v2-capture-refusal-{}",
        std::process::id()
    ));
    fs::create_dir(&base).expect("new refusal fixture root");

    assert!(validate_capture_root(Path::new("relative"), &package_root).is_err());
    let existing = base.join("existing");
    fs::create_dir(&existing).expect("existing output root");
    assert!(validate_capture_root(&existing, &package_root).is_err());
    assert!(
        validate_capture_root(&package_root.join("capture-root-refusal"), &package_root).is_err()
    );

    let real_parent = base.join("real-parent");
    fs::create_dir(&real_parent).expect("real symlink target");
    let linked_parent = base.join("linked-parent");
    std::os::unix::fs::symlink(&real_parent, &linked_parent).expect("symlinked parent");
    assert!(validate_capture_root(&linked_parent.join("capture"), &package_root).is_err());
    fs::remove_dir_all(&base).expect("remove refusal fixture root");
}

#[test]
fn capture_report_is_closed_and_destination_sorted() {
    let report = CaptureReport {
        schema: "autopilot.work_map_v2_capture_report.v1".to_owned(),
        raw_output_description:
            "raw_output is Core-normalized terminal payload JSON after Pi decoded the tool payload."
                .to_owned(),
        records: vec![
            report_record("approved/a", COMPILER),
            report_record("approved/b", RECOVERY),
            report_record("approved/c", SYNTHESIZER),
        ],
    };
    assert_report_shape(&report).expect("closed report fixture");
    let bytes = serde_json::to_vec(&report).expect("report JSON");
    let decoded: CaptureReport = serde_json::from_slice(&bytes).expect("closed report reads");
    assert_eq!(decoded.records.len(), 3);

    let mut unknown: serde_json::Value = serde_json::from_slice(&bytes).expect("JSON value");
    unknown["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<CaptureReport>(unknown).is_err());

    let mut unknown_record: serde_json::Value =
        serde_json::from_slice(&bytes).expect("JSON record value");
    unknown_record["records"][0]["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<CaptureReport>(unknown_record).is_err());
}

#[test]
fn fixture_runtime_ignores_are_exact_and_exclude_foreign_pi_residue() {
    let temp = fs::canonicalize(env::temp_dir()).expect("canonical temp root");
    let base = temp.join(format!(
        "work-map-v2-capture-runtime-ignore-{}",
        std::process::id()
    ));
    fs::create_dir(&base).expect("new runtime-ignore fixture root");
    let root = base.join("repository");
    create_fixture_repository(&root).expect("fixture repository");
    let root = fs::canonicalize(root).expect("canonical fixture repository");
    let _inputs = create_fixture_inputs(&root).expect("package fixture inputs");
    write_new(
        &root.join(".pi/tasks/capture-task.json"),
        b"{}\n",
        "fixture task runtime input",
    )
    .expect("package task runtime input");

    let status = Command::new("git")
        .current_dir(&root)
        .args([
            "status",
            "--porcelain=v1",
            "--ignored=matching",
            "--untracked-files=all",
            "--",
            ".pi",
        ])
        .output()
        .expect("fixture ignored status");
    assert!(
        status.status.success(),
        "fixture ignored status: {}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert_eq!(
        String::from_utf8(status.stdout).expect("fixture ignored status UTF-8"),
        "!! .pi/autopilot/\n!! .pi/tasks/\n"
    );
    runner::repository_authority(&root)
        .expect("repository authority accepts only package-owned fixture runtime paths");

    write_new(
        &root.join(".pi/foreign/residue.json"),
        b"{}\n",
        "foreign untracked residue",
    )
    .expect("foreign untracked residue");
    let untracked = runner::repository_authority(&root)
        .expect_err("foreign untracked residue must remain outside package authority")
        .to_string();
    assert!(
        untracked.contains("?? .pi/foreign/residue.json"),
        "{untracked}"
    );

    fs::write(root.join(".git/info/exclude"), b".pi/foreign/\n")
        .expect("ignore foreign fixture residue");
    let ignored = runner::repository_authority(&root)
        .expect_err("foreign ignored residue must remain outside package authority")
        .to_string();
    assert!(ignored.contains("!! .pi/foreign/"), "{ignored}");
    fs::remove_dir_all(base).expect("remove runtime-ignore fixture root");
}

#[test]
fn declared_capture_planning_identities_are_exact_before_child_invocation() {
    for (expected, assignment_id, action_id, run_revision) in [
        (
            COMPILER,
            "planning-work-map-v2-capture-plan-compiler-01",
            "action-planning-work-map-v2-capture-plan-compiler-01",
            1,
        ),
        (
            SYNTHESIZER,
            "planning-work-map-v2-capture-plan-synthesizer-01",
            "action-planning-work-map-v2-capture-plan-synthesizer-01",
            1,
        ),
        (
            RECOVERY,
            "planning-work-map-v2-capture-recovery-engineer-01",
            "action-planning-work-map-v2-capture-recovery-engineer-01",
            1,
        ),
    ] {
        assert_eq!(
            CAPTURE_RUN_REVISION, run_revision,
            "{} run revision",
            expected.role
        );
        let assignment = declared_assignment(expected).expect("declared capture assignment");
        let route = assignment
            .terminal_route
            .as_ref()
            .expect("declared capture terminal route");
        assert_eq!(
            assignment.assignment_id, assignment_id,
            "{} assignment",
            expected.role
        );
        assert_eq!(
            format!("action-{}", assignment.assignment_id),
            action_id,
            "{} action",
            expected.role
        );
        assert_eq!(assignment.mode, expected.mode, "{} mode", expected.role);
        assert_exact_tuple(expected, &assignment.mode, route)
            .expect("declared capture terminal route");
    }
}

/// Parent-only release-gate invocation:
/// `cargo test -p drivers --test work_map_v2_live_capture -- --ignored --exact genuine_work_map_v2_subscription_capture --test-threads=1`
#[test]
#[ignore = "requires explicit subscription-capture opt-in; never enabled by ordinary tests"]
fn genuine_work_map_v2_subscription_capture() {
    let _process_lock = PROCESS_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("capture process lock");
    let capture_root = match capture_request(
        env::var(OPT_IN).ok().as_deref(),
        env::var_os(CAPTURE_ROOT),
    ) {
        Ok(CaptureRequest::Skip) => {
            eprintln!(
                "skipping genuine WorkMap V2 capture; set {OPT_IN}=1 and {CAPTURE_ROOT}=<absolute nonexistent directory outside this repository>"
            );
            return;
        }
        Ok(CaptureRequest::Run(path)) => path,
        Err(error) => panic!("genuine WorkMap V2 capture refused before Pi: {error}"),
    };
    let package_root = package_root().expect("capture package root");
    validate_capture_root(&capture_root, &package_root)
        .unwrap_or_else(|error| panic!("genuine WorkMap V2 capture root refused: {error}"));
    fs::create_dir(&capture_root).unwrap_or_else(|error| {
        panic!(
            "genuine WorkMap V2 capture root must be created exactly once at {}: {error}",
            capture_root.display()
        )
    });

    let fixture_root = capture_root.join("repository");
    create_fixture_repository(&fixture_root).expect("capture fixture repository");
    let fixture_root =
        fs::canonicalize(&fixture_root).expect("canonical capture fixture repository");
    let mut environment = EnvironmentGuard::capture(&[
        "AUTOPILOT_NODE_EXECUTABLE",
        "AUTOPILOT_AGENT_RUNNER_WRAPPER",
        "AUTOPILOT_CHILD_ADDON_PATH",
        "PATH",
    ]);
    let selected_pi = selected_local_pi().expect("selected local pi");
    install_package_transport(&mut environment, &package_root, &selected_pi)
        .expect("real package transport facts");
    require_exact_pi_version(&selected_pi).expect("Pi 0.84.1 preflight");

    let _cwd = CurrentDirGuard::enter(&fixture_root).expect("enter capture fixture");
    let repository_authority = runner::repository_authority_binding(&fixture_root, WORKSTREAM)
        .expect("current fixture repository authority");
    let inputs = create_fixture_inputs(&fixture_root).expect("package-authored fixture inputs");

    let compiler_assignment = declared_assignment(COMPILER).expect("compiler declaration");
    let compiler_issue = issue_work_map(
        &compiler_assignment,
        &inputs,
        vec![inputs.task_atoms.clone(), inputs.scout_findings.clone()],
    )
    .expect("closed compiler spec");
    let compiler = capture_one(
        &compiler_issue,
        COMPILER,
        &inputs,
        &repository_authority,
        None,
        "01-plan-compiler",
    )
    .expect("genuine compiler WorkMap V2 carrier");
    assert_simple_compiler_image(&compiler.record, &fixture_root)
        .expect("compiler emits one bounded no-vendor unit");

    let synthesizer_assignment = declared_assignment(SYNTHESIZER).expect("synthesizer declaration");
    let synthesizer_issue = issue_work_map(
        &synthesizer_assignment,
        &inputs,
        vec![
            compiler.artifact.clone(),
            inputs.task_atoms.clone(),
            inputs.scout_findings.clone(),
        ],
    )
    .expect("closed synthesizer spec");
    let synthesizer = capture_one(
        &synthesizer_issue,
        SYNTHESIZER,
        &inputs,
        &repository_authority,
        None,
        "02-plan-synthesizer",
    )
    .expect("genuine synthesizer WorkMap V2 carrier");

    let recovery_assignment = declared_assignment(RECOVERY).expect("recovery declaration");
    let recovery_issue = issue_work_map(
        &recovery_assignment,
        &inputs,
        vec![
            synthesizer.artifact.clone(),
            compiler.artifact.clone(),
            inputs.blocked_review.clone(),
            inputs.task_atoms.clone(),
            inputs.scout_findings.clone(),
        ],
    )
    .expect("closed recovery spec");
    let recovery = capture_one(
        &recovery_issue,
        RECOVERY,
        &inputs,
        &repository_authority,
        Some(&synthesizer.admitted),
        "03-recovery-engineer",
    )
    .expect("genuine recovery WorkMap V2 carrier");
    assert_recovery_subject_binding(&recovery.record, &synthesizer.record)
        .expect("recovery promotion replays genuine synthesizer subject");

    let mut records = vec![compiler.record, synthesizer.record, recovery.record];
    records.sort_by(|left, right| left.destination.cmp(&right.destination));
    let report = CaptureReport {
        schema: "autopilot.work_map_v2_capture_report.v1".to_owned(),
        raw_output_description:
            "raw_output is Core-normalized terminal payload JSON after Pi decoded the tool payload."
                .to_owned(),
        records,
    };
    assert_report_shape(&report).expect("closed capture report");
    let report_bytes = serde_json::to_vec(&report).expect("serialize capture report");
    let report_path = capture_root.join("capture-report.json");
    atomic_write_create_once(&report_path, &report_bytes).expect("create-once capture report");
    let report_digest = sha256_hex(&report_bytes);
    atomic_write_create_once(
        &capture_root.join("capture-report.sha256"),
        format!("{report_digest}\n").as_bytes(),
    )
    .expect("create-once capture report digest");

    println!("capture_root={}", capture_root.display());
    println!("report_sha256={report_digest}");
    println!(
        "profiles={},{},{}",
        COMPILER.profile, SYNTHESIZER.profile, RECOVERY.profile
    );
    println!("PASS");
}

fn capture_request(opt_in: Option<&str>, root: Option<OsString>) -> Result<CaptureRequest, String> {
    if opt_in != Some("1") {
        return Ok(CaptureRequest::Skip);
    }
    let root = root.ok_or_else(|| format!("{CAPTURE_ROOT} is required when {OPT_IN}=1"))?;
    if root.is_empty() {
        return Err(format!("{CAPTURE_ROOT} must not be empty"));
    }
    Ok(CaptureRequest::Run(PathBuf::from(root)))
}

fn package_root() -> Result<PathBuf, String> {
    let drivers = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = drivers
        .parent()
        .ok_or_else(|| "drivers manifest has no package root".to_owned())?;
    fs::canonicalize(root).map_err(|error| format!("canonical package root: {error}"))
}

fn validate_capture_root(root: &Path, package_root: &Path) -> Result<(), String> {
    if !root.is_absolute()
        || root.as_os_str().is_empty()
        || root.components().any(|component| {
            matches!(
                component,
                Component::CurDir | Component::ParentDir | Component::Prefix(_)
            )
        })
    {
        return Err("capture root must be an absolute normalized path".to_owned());
    }
    if root.exists() {
        return Err("capture root must be nonexistent (refusing overwrite)".to_owned());
    }
    let parent = root
        .parent()
        .filter(|parent| parent.is_absolute())
        .ok_or_else(|| "capture root has no absolute parent".to_owned())?;
    reject_symlink_components(parent)?;
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("capture root parent must exist and be canonical: {error}"))?;
    if parent.starts_with(package_root) || root.starts_with(package_root) {
        return Err("capture root must be outside this repository".to_owned());
    }
    Ok(())
}

fn reject_symlink_components(path: &Path) -> Result<(), String> {
    let mut probe = PathBuf::new();
    for component in path.components() {
        probe.push(component.as_os_str());
        match fs::symlink_metadata(&probe) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "capture root has symlinked component {}",
                    probe.display()
                ));
            }
            Ok(_) => {}
            Err(error) => {
                return Err(format!(
                    "inspect capture root component {}: {error}",
                    probe.display()
                ));
            }
        }
    }
    Ok(())
}

fn selected_local_pi() -> Result<PathBuf, String> {
    let path =
        env::var_os("PATH").ok_or_else(|| "PATH is required to select local pi".to_owned())?;
    for directory in env::split_paths(&path) {
        let directory = if directory.is_absolute() {
            directory
        } else {
            env::current_dir()
                .map_err(|error| format!("current directory while selecting pi: {error}"))?
                .join(directory)
        };
        let candidate = directory.join("pi");
        if fs::metadata(&candidate)
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
        {
            return Ok(candidate);
        }
    }
    Err("no local pi executable named pi was found on PATH".to_owned())
}

fn install_package_transport(
    environment: &mut EnvironmentGuard,
    package_root: &Path,
    selected_pi: &Path,
) -> Result<(), String> {
    let node = env::var_os("AUTOPILOT_NODE_EXECUTABLE")
        .map(PathBuf::from)
        .map_or_else(resolve_local_node, |path| canonical_regular_file(&path))?;
    let wrapper = canonical_regular_file(&package_root.join("bin/autopilot-agent-run.mjs"))?;
    let addon = canonical_regular_file(&package_root.join("src/generated/child-extension.ts"))?;
    let pi_parent = selected_pi
        .parent()
        .ok_or_else(|| "selected pi has no parent".to_owned())?;
    let prior_path = env::var_os("PATH").ok_or_else(|| "PATH is unavailable".to_owned())?;
    let mut path_entries = vec![pi_parent.to_path_buf()];
    path_entries.extend(env::split_paths(&prior_path));
    let prefixed_path = env::join_paths(path_entries)
        .map_err(|error| format!("selected pi PATH construction: {error}"))?;

    environment.set("AUTOPILOT_NODE_EXECUTABLE", node);
    environment.set("AUTOPILOT_AGENT_RUNNER_WRAPPER", wrapper);
    environment.set("AUTOPILOT_CHILD_ADDON_PATH", addon);
    environment.set("PATH", prefixed_path);
    Ok(())
}

fn resolve_local_node() -> Result<PathBuf, String> {
    let path =
        env::var_os("PATH").ok_or_else(|| "PATH is required to select local node".to_owned())?;
    for directory in env::split_paths(&path) {
        let candidate = directory.join("node");
        if let Ok(path) = canonical_regular_file(&candidate) {
            return Ok(path);
        }
    }
    Err("AUTOPILOT_NODE_EXECUTABLE is unset and no local node was found on PATH".to_owned())
}

fn canonical_regular_file(path: &Path) -> Result<PathBuf, String> {
    let path =
        fs::canonicalize(path).map_err(|error| format!("canonical {}: {error}", path.display()))?;
    if !fs::metadata(&path)
        .map_err(|error| format!("metadata {}: {error}", path.display()))?
        .is_file()
    {
        return Err(format!("{} is not a regular file", path.display()));
    }
    Ok(path)
}

fn require_exact_pi_version(pi: &Path) -> Result<(), String> {
    let output = Command::new(pi)
        .arg("--version")
        .output()
        .map_err(|error| format!("selected local pi --version failed: {error}"))?;
    if output.status.success() && output.stdout == b"0.84.1\n" {
        Ok(())
    } else {
        Err("selected local pi --version must emit exactly 0.84.1".to_owned())
    }
}

fn create_fixture_repository(root: &Path) -> Result<(), String> {
    fs::create_dir(root).map_err(|error| format!("create fixture root: {error}"))?;
    fs::create_dir_all(root.join("src"))
        .map_err(|error| format!("create fixture source: {error}"))?;
    write_new(
        &root.join(".gitignore"),
        b".pi/autopilot/\n.pi/tasks/\n",
        "fixture gitignore",
    )?;
    write_new(
        &root.join("task.md"),
        b"[authority]\nauthority_set_id: capture-v2-authority\n\nProduce exactly one no-vendor WorkMap V2 implementation unit for src/captured.txt linked only to capture-atom-1. The unit must use a nonempty no-effect verification command and may not expand scope.\n",
        "fixture task",
    )?;
    write_new(
        &root.join("context.md"),
        b"[context/non-authority]\nauthority_set_id: capture-v2-authority\n\nThis isolated fixture has one tracked implementation leaf, src/captured.txt. The capture is planning-only; do not mutate the fixture.\n",
        "fixture context",
    )?;
    write_new(
        &root.join("src/captured.txt"),
        b"capture fixture source\n",
        "fixture source",
    )?;
    git(root, &["init", "--quiet"])?;
    git(
        root,
        &[
            "add",
            ".gitignore",
            "task.md",
            "context.md",
            "src/captured.txt",
        ],
    )?;
    git(
        root,
        &[
            "-c",
            "user.email=capture@example.invalid",
            "-c",
            "user.name=WorkMap V2 Capture",
            "commit",
            "--quiet",
            "-m",
            "capture fixture",
        ],
    )
}

fn git(root: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|error| format!("fixture git spawn {args:?}: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("fixture git {args:?} failed"))
    }
}

fn create_fixture_inputs(root: &Path) -> Result<FixtureInputs, String> {
    let base = root
        .join(".pi/autopilot")
        .join(WORKSTREAM)
        .join("planning/fixture-inputs");
    fs::create_dir_all(&base).map_err(|error| format!("fixture input directory: {error}"))?;
    let task_body = "Produce exactly one no-vendor WorkMap V2 implementation unit for src/captured.txt linked only to capture-atom-1. The unit must use a nonempty no-effect verification command and may not expand scope.\n";
    let task_digest = task_document_digest("authority", task_body);
    let atom_registry_path = root
        .join(".pi/autopilot")
        .join(WORKSTREAM)
        .join("planning/atom-registry.v1.json");
    let atom_bytes = planning::atom_registry_bytes(
        WORKSTREAM,
        AUTHORITY_SET,
        vec![Id("fixture-task-atoms".to_owned())],
        vec![PlanningAtomRegistryAtom {
            id: Id("capture-atom-1".to_owned()),
            producer_assignment_id: Id("fixture-task-atoms".to_owned()),
            kind: PlanningAtomKind::Work,
            text: "Plan the one owned capture leaf without vendoring or scope expansion."
                .to_owned(),
            sources: vec![Ref(format!("task://{task_digest}/task.md#whole-file"))],
        }],
    )
    .map_err(|error| format!("fixture atom registry: {error:?}"))?;
    write_new(&atom_registry_path, &atom_bytes, "fixture atom registry")?;
    let atom_registry_digest = sha256_hex(&atom_bytes);

    let task_atoms_path = base.join("task-atoms.json");
    let task_atoms_bytes = serde_json::to_vec(&serde_json::json!({
        "atoms": [{
            "id": "capture-atom-1",
            "kind": "work",
            "text": "Plan the one owned capture leaf without vendoring or scope expansion.",
            "sources": [format!("task://{task_digest}/task.md#whole-file")]
        }]
    }))
    .map_err(|error| format!("fixture task atoms JSON: {error}"))?;
    write_new(&task_atoms_path, &task_atoms_bytes, "fixture task atoms")?;

    let scout_path = base.join("scout-findings.json");
    let scout_bytes = serde_json::to_vec(&serde_json::json!({
        "findings": [{
            "path": "src/captured.txt",
            "observation": "The tracked fixture leaf exists and is the sole permitted owned file.",
            "evidence_ref": "fixture:scout:src/captured.txt"
        }]
    }))
    .map_err(|error| format!("fixture scout JSON: {error}"))?;
    write_new(&scout_path, &scout_bytes, "fixture scout findings")?;

    let blocked_review_path = base.join("blocked-review.json");
    let blocked_review_bytes = serde_json::to_vec(&serde_json::json!({
        "verdicts": [{
            "criterion_id": "review.authority-fidelity",
            "verdict": "blocked",
            "finding": "Deterministic capture finding: the typed synthesized map is otherwise unchanged; return no-defect unless an objective-only repair is independently necessary."
        }]
    }))
    .map_err(|error| format!("fixture review JSON: {error}"))?;
    write_new(
        &blocked_review_path,
        &blocked_review_bytes,
        "fixture blocked review finding",
    )?;

    Ok(FixtureInputs {
        atom_registry_path,
        atom_registry_digest,
        task_atoms: fixture_artifact(
            "task-atoms",
            "fixture-task-atoms",
            "task-extractor",
            "planning.task-atoms.v1",
            task_atoms_path,
            &task_atoms_bytes,
            None,
        )?,
        scout_findings: fixture_artifact(
            "scout-findings",
            "fixture-scout",
            "repository-scout",
            "planning.scout-dossier.v1",
            scout_path,
            &scout_bytes,
            None,
        )?,
        blocked_review: fixture_artifact(
            "review-verdicts",
            "fixture-blocked-review",
            "plan-reviewer",
            "planning.plan-review.v1",
            blocked_review_path,
            &blocked_review_bytes,
            None,
        )?,
    })
}

fn fixture_artifact(
    category_id: &str,
    assignment_id: &str,
    role_id: &str,
    boundary_id: &str,
    path: PathBuf,
    bytes: &[u8],
    terminal_route: Option<TerminalRoute>,
) -> Result<AcceptedPlanningArtifactBinding, String> {
    Ok(AcceptedPlanningArtifactBinding {
        category_id: category_id.to_owned(),
        assignment_id: Id(assignment_id.to_owned()),
        role_id: Id(role_id.to_owned()),
        boundary_id: ContractId(boundary_id.to_owned()),
        terminal_route,
        path: path_to_string(&path)?,
        digest: sha256_hex(bytes),
    })
}

fn declared_assignment(
    expected: ExpectedTuple,
) -> Result<planning::PlanningAgentAssignment, String> {
    let assignment = planning::planning_assignments_for_workstream(WORKSTREAM)
        .map_err(|error| format!("planning declaration: {error:?}"))?
        .into_iter()
        .find(|assignment| assignment.role == expected.role)
        .ok_or_else(|| format!("missing declared {} assignment", expected.role))?;
    let route = assignment
        .terminal_route
        .as_ref()
        .ok_or_else(|| format!("declared {} route missing", expected.role))?;
    assert_exact_tuple(expected, &assignment.mode, route)?;
    Ok(assignment)
}

fn issue_work_map(
    assignment: &planning::PlanningAgentAssignment,
    inputs: &FixtureInputs,
    accepted_planning_artifacts: Vec<AcceptedPlanningArtifactBinding>,
) -> Result<runner::IssuedRunnerAction, String> {
    let expected = expected_for_role(&assignment.role)?;
    let runtime = runner::role_runtime(expected.role).map_err(|error| error.to_string())?;
    if runtime.provider != "openai-codex"
        || runtime.model != "gpt-5.6-sol"
        || runtime.thinking != "xhigh"
        || runtime.route != "subscription"
    {
        return Err(format!(
            "{} roster drift: {}/{}/{}/{}",
            expected.role, runtime.provider, runtime.model, runtime.thinking, runtime.route
        ));
    }
    let authority = runner_document(
        "task.md",
        "authority",
        "Produce exactly one no-vendor WorkMap V2 implementation unit for src/captured.txt linked only to capture-atom-1. The unit must use a nonempty no-effect verification command and may not expand scope.\n",
    );
    let context = runner_document(
        "context.md",
        "context/non-authority",
        "This isolated fixture has one tracked implementation leaf, src/captured.txt. The capture is planning-only; do not mutate the fixture.\n",
    );
    let route = assignment
        .terminal_route
        .clone()
        .ok_or_else(|| format!("{} lacks declared terminal route", expected.role))?;
    assert_exact_tuple(expected, &assignment.mode, &route)?;
    runner::planning_issue(&PlanningRunnerRequest {
        workstream: WORKSTREAM.to_owned(),
        action_id: Id(format!("action-{}", assignment.assignment_id)),
        assignment_id: Id(assignment.assignment_id.clone()),
        role_id: Id(assignment.role.clone()),
        mode: ModeId(assignment.mode.clone()),
        boundary_id: ContractId(
            assignment
                .boundary_id
                .clone()
                .ok_or_else(|| format!("{} lacks declared boundary", expected.role))?,
        ),
        run_revision: CAPTURE_RUN_REVISION,
        authority_set_id: AUTHORITY_SET.to_owned(),
        authority_documents: vec![authority],
        context_document: context.clone(),
        context_documents: vec![context],
        mode_parameter: None,
        atom_id_prefix: None,
        atom_registry_path: Some(path_to_string(&inputs.atom_registry_path)?),
        atom_registry_digest: Some(inputs.atom_registry_digest.clone()),
        terminal_route: Some(route),
        accepted_planning_artifacts,
    })
    .map_err(|error| error.to_string())
}

fn runner_document(path: &str, class: &str, body: &str) -> RunnerTaskDocument {
    RunnerTaskDocument::new(
        path.to_owned(),
        class.to_owned(),
        task_document_digest(class, body),
        body.to_owned(),
    )
}

fn task_document_digest(class: &str, body: &str) -> String {
    let marker = match class {
        "authority" => "[authority]",
        "context/non-authority" => "[context/non-authority]",
        other => other,
    };
    sha256_hex(format!("{marker}\nauthority_set_id: {AUTHORITY_SET}\n\n{body}").as_bytes())
}

fn capture_one(
    issue: &runner::IssuedRunnerAction,
    expected: ExpectedTuple,
    inputs: &FixtureInputs,
    repository_authority: &runner::RepositoryAuthorityBinding,
    recovery_subject: Option<&planning::ApprovedWorkMapV2>,
    approval_directory: &str,
) -> Result<CapturedOutput, String> {
    let spec_path = PathBuf::from(&issue.binding.spec_path);
    let spec_bytes = fs::read(&spec_path).map_err(|error| format!("read issued spec: {error}"))?;
    let spec: AgentRunSpec = serde_json::from_slice(&spec_bytes)
        .map_err(|error| format!("issued spec closed JSON: {error}"))?;
    assert_spec_before_child(
        &spec,
        &issue.binding,
        expected,
        inputs,
        repository_authority,
    )?;

    // This is intentionally the real child entry point.  There is no fake Pi,
    // model-output constructor, sidecar substitution, or output normalization.
    runner::child::main(&["--spec".to_owned(), issue.binding.spec_path.clone()])
        .map_err(|error| format!("{} child capture: {error}", expected.role))?;

    let carrier_path = PathBuf::from(&issue.binding.carrier_path);
    let carrier_bytes =
        fs::read(&carrier_path).map_err(|error| format!("read persisted carrier: {error}"))?;
    let carrier: StrictCarrierV2 = serde_json::from_slice(&carrier_bytes)
        .map_err(|error| format!("persisted V2 carrier closed JSON: {error}"))?;
    assert_carrier_after_child(
        &carrier,
        &carrier_bytes,
        &spec,
        &issue.binding,
        expected,
        inputs,
        repository_authority,
    )?;
    let raw_output_digest = sha256_hex(carrier.raw_output.as_bytes());
    let work_map: WorkMapV2 = serde_json::from_str(&carrier.raw_output)
        .map_err(|error| format!("persisted raw output WorkMap V2: {error}"))?;
    if expected.role == RECOVERY.role {
        let recovery = work_map
            .recovery
            .as_ref()
            .ok_or_else(|| "recovery carrier lacks recovery evidence".to_owned())?;
        if !matches!(
            recovery.disposition,
            kernel::generated::RecoveryDisposition::NoDefect
                | kernel::generated::RecoveryDisposition::Repaired
        ) {
            return Err("recovery capture must be no-defect or objective-only repaired".to_owned());
        }
    } else if work_map.recovery.is_some() {
        return Err(format!(
            "{} ordinary capture unexpectedly has recovery evidence",
            expected.role
        ));
    }

    // The public test-only entry still obtains the raw bytes from the actual
    // persisted carrier and compares them byte-for-byte before strict V2
    // admission.  The model payload above is never reconstructed or repaired.
    let admitted = planning::work_map_v2::admit_work_map_v2_actual_carrier_for_test_only(
        &carrier_path,
        WorkMapV2AdmissionContext {
            atom_registry_path: &inputs.atom_registry_path,
            atom_registry_digest: &inputs.atom_registry_digest,
            repository_authority,
            recovery_subject,
        },
    )
    .map_err(|error| format!("{} strict admission: {error}", expected.role))?;

    let approval_root = PathBuf::from(&repository_authority.manifest.repo_root)
        .join(".pi/autopilot")
        .join(WORKSTREAM)
        .join("capture-approvals")
        .join(approval_directory);
    let promotion = seam::write_approved_plan_v2_for_test_only(
        WORKSTREAM,
        &approval_root.join("approved-plan.v2.json"),
        &approval_root.join("binding.v1.json"),
        &admitted,
    )
    .map_err(|error| format!("{} approved-plan promotion: {error}", expected.role))?;
    let replay = seam::read_approved_plan_v2(&promotion.binding_path, &promotion.binding_sha256)
        .map_err(|error| format!("{} approved-plan replay: {error}", expected.role))?;
    let image_bytes = fs::read(approval_root.join("approved-plan.v2.json"))
        .map_err(|error| format!("{} approved image read: {error}", expected.role))?;
    if sha256_hex(&image_bytes) != promotion.approved_plan_sha256 {
        return Err(format!("{} approved image digest drift", expected.role));
    }
    if replay.units.is_empty() {
        return Err(format!("{} replayed image has no units", expected.role));
    }

    let artifact = AcceptedPlanningArtifactBinding {
        category_id: if expected.role == COMPILER.role {
            "compiler-work-maps"
        } else if expected.role == SYNTHESIZER.role {
            "synthesized-work-map"
        } else {
            "recovery-work-map"
        }
        .to_owned(),
        assignment_id: issue.binding.assignment_id.clone(),
        role_id: issue.binding.role_id.clone(),
        boundary_id: issue.binding.boundary_id.clone(),
        terminal_route: Some(carrier.terminal_route.clone()),
        path: issue.binding.carrier_path.clone(),
        digest: sha256_hex(&carrier_bytes),
    };
    let record = CaptureRecord {
        destination: path_to_string(&promotion.binding_path)?,
        role: expected.role.to_owned(),
        mode: expected.mode.to_owned(),
        profile: expected.profile.to_owned(),
        tool: expected.tool.to_owned(),
        schema_digest: expected.schema_digest.to_owned(),
        provider: spec.provider.clone(),
        model: spec.model.clone(),
        thinking: spec.thinking.0.clone(),
        route: spec.route.clone(),
        pi_version: carrier.pi_version,
        spec_path: issue.binding.spec_path.clone(),
        spec_digest: issue.binding.spec_digest.clone(),
        carrier_path: issue.binding.carrier_path.clone(),
        carrier_digest: sha256_hex(&carrier_bytes),
        raw_output_digest,
        raw_output: carrier.raw_output,
        session_id: spec.session_id.0.clone(),
        atom_registry_path: inputs
            .atom_registry_path
            .to_str()
            .ok_or_else(|| "atom registry path is not UTF-8".to_owned())?
            .to_owned(),
        atom_registry_digest: inputs.atom_registry_digest.clone(),
        repository_manifest_path: repository_authority.path.clone(),
        repository_manifest_digest: repository_authority.digest.clone(),
        repository_head_commit: repository_authority.manifest.head_commit.clone(),
        repository_head_tree: repository_authority.manifest.head_tree.clone(),
        approved_binding_path: path_to_string(&promotion.binding_path)?,
        approved_binding_digest: promotion.binding_sha256,
        approved_image_digest: promotion.approved_plan_sha256,
        strict_admission: "accepted".to_owned(),
    };
    Ok(CapturedOutput {
        admitted,
        artifact,
        record,
    })
}

fn assert_spec_before_child(
    spec: &AgentRunSpec,
    binding: &runner::IssuedRunnerBinding,
    expected: ExpectedTuple,
    inputs: &FixtureInputs,
    repository_authority: &runner::RepositoryAuthorityBinding,
) -> Result<(), String> {
    let route = spec
        .terminal_route
        .as_ref()
        .ok_or_else(|| "issued spec lacks terminal route".to_owned())?;
    assert_exact_tuple(expected, &spec.mode.0, route)?;
    if spec.schema.0 != "autopilot.agent_run_spec.v4"
        || spec.assignment_kind != ValidationAssignmentKind::PlanningReview
        || spec.role_id.0 != expected.role
        || spec.provider != "openai-codex"
        || spec.model != "gpt-5.6-sol"
        || spec.thinking.0 != "xhigh"
        || spec.route != "subscription"
        || spec.terminal_profile_id.as_deref() != Some(expected.profile)
        || spec.terminal_route.as_ref() != binding.terminal_route.as_ref()
        || spec.atom_registry_path.as_ref().map(|path| path.0.as_str())
            != Some(
                inputs
                    .atom_registry_path
                    .to_str()
                    .ok_or_else(|| "atom path UTF-8".to_owned())?,
            )
        || spec
            .atom_registry_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != Some(inputs.atom_registry_digest.as_str())
        || spec
            .repository_manifest_path
            .as_ref()
            .map(|path| path.0.as_str())
            != Some(repository_authority.path.as_str())
        || spec
            .repository_manifest_digest
            .as_ref()
            .map(|digest| digest.0.as_str())
            != Some(repository_authority.digest.as_str())
        || spec
            .repository_head_commit
            .as_ref()
            .map(|sha| sha.0.as_str())
            != Some(repository_authority.manifest.head_commit.as_str())
        || spec.repository_head_tree.as_ref().map(|sha| sha.0.as_str())
            != Some(repository_authority.manifest.head_tree.as_str())
        || spec.runtime_extension_digest.is_none()
    {
        return Err(format!(
            "{} issued spec authority/route drift",
            expected.role
        ));
    }
    let terminal_tools = spec
        .allowed_tools
        .iter()
        .filter(|tool| {
            matches!(
                tool.0.as_str(),
                "autopilot_submit_plan_cluster"
                    | "autopilot_submit_synthesis"
                    | "autopilot_emit_status"
            )
        })
        .map(|tool| tool.0.as_str())
        .collect::<Vec<_>>();
    if terminal_tools != [expected.tool] {
        return Err(format!("{} selected terminal tool drift", expected.role));
    }
    Ok(())
}

fn assert_carrier_after_child(
    carrier: &StrictCarrierV2,
    carrier_bytes: &[u8],
    spec: &AgentRunSpec,
    binding: &runner::IssuedRunnerBinding,
    expected: ExpectedTuple,
    inputs: &FixtureInputs,
    repository_authority: &runner::RepositoryAuthorityBinding,
) -> Result<(), String> {
    assert_exact_tuple(expected, &carrier.mode, &carrier.terminal_route)?;
    let spec_path = Path::new(&binding.spec_path);
    let spec_bytes =
        fs::read(spec_path).map_err(|error| format!("re-read source spec: {error}"))?;
    let addon_digest = spec
        .runtime_extension_digest
        .as_ref()
        .ok_or_else(|| "spec missing runtime add-on digest".to_owned())?;
    if carrier.schema != "autopilot.planning_carrier.v2"
        || carrier.action_id != binding.action_id.0
        || carrier.assignment_id != binding.assignment_id.0
        || carrier.run_revision != binding.run_revision
        || carrier.workstream != binding.workstream.0
        || carrier.role_id != expected.role
        || carrier.boundary_id != "planning.work-map.v2"
        || carrier.result_contract != "planning.work-map.v2"
        || carrier.prompt_path != binding.prompt_path
        || carrier.prompt_digest != binding.prompt_digest
        || carrier.boundary_digest != binding.boundary_digest
        || carrier.result_contract_digest != binding.result_contract_digest
        || carrier.settings_digest != binding.settings_digest
        || carrier.context_digest != binding.context_digest
        || carrier.skills_digest != binding.skills_digest
        || carrier.subscription_digest != binding.subscription_digest
        || carrier.runtime_extension_digest != addon_digest.0
        || carrier.spec_path != binding.spec_path
        || carrier.spec_digest != binding.spec_digest
        || carrier.spec_digest != sha256_hex(&spec_bytes)
        || carrier.carrier_path != binding.carrier_path
        || carrier.carrier_channel != "tool"
        || carrier.tool_name != expected.tool
        || carrier.tool_schema_digest != expected.schema_digest
        || carrier.carrier_binding != runner::child::carrier_binding(spec)
        || carrier.pi_version != PI_VERSION
        || carrier.atom_registry_path
            != inputs
                .atom_registry_path
                .to_str()
                .ok_or_else(|| "atom registry path is not UTF-8".to_owned())?
        || carrier.atom_registry_digest != inputs.atom_registry_digest
        || carrier.repository_manifest_path != repository_authority.path
        || carrier.repository_manifest_digest != repository_authority.digest
        || carrier.repository_head_commit != repository_authority.manifest.head_commit
        || carrier.repository_head_tree != repository_authority.manifest.head_tree
        || carrier.raw_output.is_empty()
        || carrier_bytes.is_empty()
    {
        return Err(format!(
            "{} persisted carrier/spec authority drift",
            expected.role
        ));
    }
    Ok(())
}

fn assert_exact_tuple(
    expected: ExpectedTuple,
    actual_mode: &str,
    route: &TerminalRoute,
) -> Result<(), String> {
    if actual_mode != expected.mode
        || route.version != "v2"
        || route.profile_id != expected.profile
        || route.tool_name != ToolName(expected.tool.to_owned())
        || route.boundary_id.0 != "planning.work-map.v2"
        || route.result_contract.0 != "planning.work-map.v2"
        || route.schema_digest.0 != expected.schema_digest
    {
        return Err(format!(
            "{} exact generated terminal tuple drift",
            expected.role
        ));
    }
    Ok(())
}

fn expected_for_role(role: &str) -> Result<ExpectedTuple, String> {
    match role {
        "plan-compiler" => Ok(COMPILER),
        "plan-synthesizer" => Ok(SYNTHESIZER),
        "recovery-engineer" => Ok(RECOVERY),
        _ => Err(format!("unexpected capture role {role}")),
    }
}

fn assert_simple_compiler_image(record: &CaptureRecord, fixture_root: &Path) -> Result<(), String> {
    let binding: ApprovedPlanV2BindingV1 = serde_json::from_slice(
        &fs::read(&record.approved_binding_path)
            .map_err(|error| format!("compiler binding read: {error}"))?,
    )
    .map_err(|error| format!("compiler binding closed JSON: {error}"))?;
    let image = seam::read_approved_plan_v2(
        Path::new(&record.approved_binding_path),
        &record.approved_binding_digest,
    )
    .map_err(|error| format!("compiler image replay: {error}"))?;
    if binding.recovery_subject.0.is_some()
        || image.units.len() != 1
        || image.units[0].decisions != vec![Id("capture-atom-1".to_owned())]
        || image.units[0].files.len() != 1
        || image.units[0].files[0].0 != "src/captured.txt"
        || image.vendoring.iter().any(|row| {
            row.provenance_manifest_destination.is_some() || !row.vendor_bindings.is_empty()
        })
        || image
            .package_authority
            .iter()
            .any(|row| !row.package_scope_files.is_empty() || !row.package_proofs.is_empty())
        || !fixture_root.join("src/captured.txt").is_file()
    {
        return Err(
            "compiler capture is not the required one-unit/no-vendor/no-scope map".to_owned(),
        );
    }
    Ok(())
}

fn assert_recovery_subject_binding(
    recovery: &CaptureRecord,
    synthesizer: &CaptureRecord,
) -> Result<(), String> {
    let binding: ApprovedPlanV2BindingV1 = serde_json::from_slice(
        &fs::read(&recovery.approved_binding_path)
            .map_err(|error| format!("recovery binding read: {error}"))?,
    )
    .map_err(|error| format!("recovery binding closed JSON: {error}"))?;
    let subject = binding
        .recovery_subject
        .0
        .ok_or_else(|| "recovery approved binding lacks a subject".to_owned())?;
    if subject.source_carrier_path != synthesizer.carrier_path
        || subject.source_carrier_sha256 != synthesizer.carrier_digest
        || subject.source_raw_work_map_sha256 != synthesizer.raw_output_digest
        || subject.source_spec_path != synthesizer.spec_path
        || subject.source_spec_digest != synthesizer.spec_digest
        || subject.source_role_id != SYNTHESIZER.role
        || subject.source_mode != SYNTHESIZER.mode
        || subject.source_terminal_route.profile_id != SYNTHESIZER.profile
        || subject.source_terminal_route.tool_name.0 != SYNTHESIZER.tool
        || subject.source_terminal_route.schema_digest.0 != SYNTHESIZER.schema_digest
        || subject.source_pi_version != PI_VERSION
    {
        return Err(
            "recovery approved binding did not preserve genuine synthesizer subject".to_owned(),
        );
    }
    Ok(())
}

fn assert_report_shape(report: &CaptureReport) -> Result<(), String> {
    if report.schema != "autopilot.work_map_v2_capture_report.v1"
        || report.raw_output_description
            != "raw_output is Core-normalized terminal payload JSON after Pi decoded the tool payload."
        || report.records.len() != 3
    {
        return Err("capture report schema/record count drift".to_owned());
    }
    let destinations = report
        .records
        .iter()
        .map(|record| record.destination.as_str())
        .collect::<Vec<_>>();
    if !destinations.windows(2).all(|window| window[0] < window[1]) {
        return Err("capture report records are not destination-sorted".to_owned());
    }
    let expected_profiles = [COMPILER.profile, RECOVERY.profile, SYNTHESIZER.profile]
        .into_iter()
        .collect::<BTreeSet<_>>();
    let actual_profiles = report
        .records
        .iter()
        .map(|record| record.profile.as_str())
        .collect::<BTreeSet<_>>();
    if actual_profiles != expected_profiles
        || report.records.iter().any(|record| {
            record.strict_admission != "accepted"
                || record.pi_version != PI_VERSION
                || record.raw_output_digest != sha256_hex(record.raw_output.as_bytes())
                || record.carrier_digest.len() != 64
                || record.spec_digest.len() != 64
                || record.approved_binding_digest.len() != 64
                || record.approved_image_digest.len() != 64
        })
    {
        return Err("capture report record authority drift".to_owned());
    }
    Ok(())
}

fn report_record(destination: &str, expected: ExpectedTuple) -> CaptureRecord {
    CaptureRecord {
        destination: destination.to_owned(),
        role: expected.role.to_owned(),
        mode: expected.mode.to_owned(),
        profile: expected.profile.to_owned(),
        tool: expected.tool.to_owned(),
        schema_digest: expected.schema_digest.to_owned(),
        provider: "openai-codex".to_owned(),
        model: "gpt-5.6-sol".to_owned(),
        thinking: "xhigh".to_owned(),
        route: "subscription".to_owned(),
        pi_version: PI_VERSION.to_owned(),
        spec_path: "/outside/spec.json".to_owned(),
        spec_digest: "a".repeat(64),
        carrier_path: "/outside/carrier.json".to_owned(),
        carrier_digest: "b".repeat(64),
        raw_output_digest: sha256_hex(b"{}"),
        raw_output: "{}".to_owned(),
        session_id: "capture-session".to_owned(),
        atom_registry_path: "/outside/atoms.json".to_owned(),
        atom_registry_digest: "c".repeat(64),
        repository_manifest_path: "/outside/repository-authority.v1.json".to_owned(),
        repository_manifest_digest: "d".repeat(64),
        repository_head_commit: "e".repeat(40),
        repository_head_tree: "f".repeat(40),
        approved_binding_path: format!("/outside/{destination}/binding.json"),
        approved_binding_digest: "0".repeat(64),
        approved_image_digest: "1".repeat(64),
        strict_admission: "accepted".to_owned(),
    }
}

fn write_new(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("{label} parent: {error}"))?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("{label} create-once {}: {error}", path.display()))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("{label} write {}: {error}", path.display()))
}

fn atomic_write_create_once(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        return Err(format!("refusing overwrite of {}", path.display()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| format!("{} has no UTF-8 file name", path.display()))?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
    write_new(&temporary, bytes, "atomic capture report temporary")?;
    let link_result = fs::hard_link(&temporary, path);
    let _ = fs::remove_file(&temporary);
    link_result.map_err(|error| format!("create-once publish {}: {error}", path.display()))?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("sync capture report directory: {error}"))
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("path is not UTF-8: {}", path.display()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
