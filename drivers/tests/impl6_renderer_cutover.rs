use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use drivers::runner::{self, PlanningRunnerRequest, RunnerTaskDocument};
use drivers::seam::{self, CoreState};
use drivers::vcs::GitVcs;
use kernel::generated::{ContractId, Id, ModeId, SeamEnvelope};
use serde_json::json;
use sha2::{Digest as ShaDigest, Sha256};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn planning_prompt_is_the_rendered_seven_layer_prompt() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("rendered-seven-layer");
    fixture.install_transport();

    let issue = fixture.issue_extractor("planning-ws-task-extractor-01", "WORK");
    let spec: serde_json::Value =
        serde_json::from_slice(&fs::read(&issue.binding.spec_path).unwrap()).unwrap();
    let prompt_path = spec["prompt_path"].as_str().unwrap();
    let prompt = fs::read_to_string(prompt_path).unwrap();

    assert!(prompt.contains("# Autopilot rendered prompt"));
    for marker in [
        "Layer 1 — global doctrine",
        "Layer 2 — role base",
        "Layer 3 — mode overlay",
        "Layer 4 — package assignment",
        "Layer 5 — canonical Context Manifest",
        "Layer 6 — acceptance/evidence/output contract",
        "Layer 7 — checkpoint-resume or failure overlay",
    ] {
        assert!(prompt.contains(marker), "missing {marker}");
    }
    assert!(prompt.contains("Do not invent modes, tools, repository authority"));
    assert!(
        prompt.contains("Terminalize only through `autopilot_submit_atoms` as the final action.")
    );
}

#[test]
fn extractor_prompt_carries_its_assigned_lens() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("lens-prompts");
    fixture.install_transport();

    let first = fixture.issue_extractor("planning-ws-task-extractor-01", "WORK");
    let seventh = fixture.issue_extractor("planning-ws-task-extractor-07", "REFERENCE");
    let first_prompt = fs::read_to_string(&first.binding.prompt_path).unwrap();
    let seventh_prompt = fs::read_to_string(&seventh.binding.prompt_path).unwrap();

    assert!(first_prompt.contains("mode_parameter: WORK"));
    assert!(first_prompt.contains("Apply exactly one lens parameter: `WORK`."));
    assert!(seventh_prompt.contains("mode_parameter: REFERENCE"));
    assert!(seventh_prompt.contains("Apply exactly one lens parameter: `REFERENCE`."));
    assert_ne!(first_prompt, seventh_prompt);
}

#[test]
fn renderer_prompt_binds_every_context_document_by_path_and_digest() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("multi-context-bindings");
    fixture.install_transport();
    let repo = fixture.install_multi_context_task_pack();
    std::env::set_current_dir(&repo).unwrap();

    let mut state = CoreState::open(None).unwrap();
    let response = command(
        "autopilot-plan ws A1.md A2.md A3.md A4.md A5.md A6.md C1.md C2.md",
        &mut state,
    );
    assert!(
        matches!(response.kind.as_str(), "spawn" | "spawn-wave"),
        "unexpected response: {response:?}"
    );
    let spec_path = spec_path_from_command(&first_spawn_command(&response.payload));
    let spec: serde_json::Value = serde_json::from_slice(&fs::read(&spec_path).unwrap()).unwrap();
    let prompt = fs::read_to_string(spec["prompt_path"].as_str().unwrap()).unwrap();
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(repo.join(".pi/autopilot/ws/planning-manifest.json")).unwrap(),
    )
    .unwrap();
    let contexts = manifest["context_documents"].as_array().unwrap();
    assert_eq!(contexts.len(), 2);

    for context in contexts {
        let path = context["path"].as_str().unwrap();
        let digest = context["digest"].as_str().unwrap();
        assert!(
            prompt.contains(path),
            "prompt missing context path {path}: {prompt}"
        );
        assert!(
            prompt.contains(digest),
            "prompt missing context digest {digest}: {prompt}"
        );
    }
}

#[test]
fn mandatory_accepted_artifact_gap_refuses_planning_issue() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("mandatory-gap");
    fixture.install_transport();

    let error = fixture
        .issue_planning_request(PlanningRequestSpec::new(
            "planning-ws-plan-reviewer-01",
            "plan-reviewer",
            "full-review",
            "planning.plan-review.v1",
        ))
        .expect_err("missing mandatory synthesized-work-map must refuse issue");

    assert!(
        matches!(
            error,
            runner::RunnerError::ContextGap { ref tier, ref category_id, .. }
                if tier == "mandatory_inline" && category_id == "synthesized-work-map"
        ),
        "unexpected error: {error:?}"
    );
}

#[test]
fn on_demand_context_gap_is_rendered_but_does_not_refuse_issue() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("on-demand-gap");
    fixture.install_transport();
    let registry = fixture.write_atom_registry(&[("TE01-W-001", "planning-ws-task-extractor-01")]);
    let artifacts = vec![
        fixture.accepted_artifact(
            "task-atoms",
            "planning.task-atoms.v1",
            "task-extractor",
            "planning-ws-task-extractor-01",
        ),
        fixture.accepted_artifact(
            "scout-findings",
            "planning.scout-dossier.v1",
            "repository-scout",
            "planning-ws-repository-scout-01",
        ),
    ];

    let issue = fixture
        .issue_planning_request(
            PlanningRequestSpec::new(
                "planning-ws-plan-compiler-01",
                "plan-compiler",
                "initial-plan",
                "planning.work-map.v1",
            )
            .registry(registry)
            .accepted_planning_artifacts(artifacts),
        )
        .expect("on_demand source-anchor gap must not block issue");
    let manifest =
        context_manifest_from_prompt(&fs::read_to_string(&issue.binding.prompt_path).unwrap());
    assert!(
        manifest["gaps"].as_array().unwrap().iter().any(|gap| {
            gap["id"]
                .as_str()
                .is_some_and(|id| id.contains(":on_demand:source-anchor:gap"))
        }),
        "on_demand source-anchor gap should be visible: {manifest}"
    );
}

#[test]
fn full_planning_run_renders_no_mandatory_or_required_context_gaps() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("full-run-context");
    fixture.install_transport();
    let repo = fixture.install_repo_task_pack();
    std::env::set_current_dir(&repo).unwrap();
    let mut state = CoreState::open(None).unwrap();
    let mut pending =
        spawn_spec_paths(&command("autopilot-plan ws task.md context.md", &mut state));
    let mut issued_prompts = Vec::new();

    while let Some(spec_path) = pending.pop() {
        let spec: serde_json::Value =
            serde_json::from_slice(&fs::read(&spec_path).unwrap()).unwrap();
        issued_prompts.push(PathBuf::from(spec["prompt_path"].as_str().unwrap()));
        let raw = raw_output_for_spec(&spec);
        let response = agent_response_from_spec(&spec_path, &raw, &mut state);
        if response_status(&response).contains("ready-to-execute") {
            break;
        }
        pending.extend(spawn_spec_paths(&response));
    }

    assert!(
        response_status(&command("autopilot-status", &mut state)).contains("ready-to-execute")
            || repo.join(".pi/autopilot/ws/approved-plan.json").exists(),
        "planning run did not reach ready-to-execute"
    );
    let reviewer_prompt =
        repo.join(".pi/autopilot/ws/planning/prompts/planning-ws-plan-reviewer-01.md");
    assert!(reviewer_prompt.exists(), "reviewer prompt was not rendered");
    for prompt_path in issued_prompts {
        let manifest = context_manifest_from_prompt(&fs::read_to_string(&prompt_path).unwrap());
        let blocking = manifest["gaps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|gap| {
                gap["id"].as_str().is_some_and(|id| {
                    id.contains(":mandatory_inline:") || id.contains(":required_reads:")
                })
            })
            .collect::<Vec<_>>();
        assert!(
            blocking.is_empty(),
            "{} has blocking context gaps: {blocking:?}",
            prompt_path.display()
        );
    }
}

#[test]
fn no_package_rendered_sidecar_remains() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("no-sidecar");
    fixture.install_transport();
    let repo = fixture.install_repo_task_pack();
    std::env::set_current_dir(&repo).unwrap();

    let mut state = CoreState::open(None).unwrap();
    let response = command("autopilot-plan ws task.md context.md", &mut state);
    assert!(
        matches!(response.kind.as_str(), "spawn" | "spawn-wave"),
        "unexpected response: {response:?}"
    );
    let spec_path = spec_path_from_command(&first_spawn_command(&response.payload));
    let spec: serde_json::Value = serde_json::from_slice(&fs::read(&spec_path).unwrap()).unwrap();
    let prompt_path = PathBuf::from(spec["prompt_path"].as_str().unwrap());
    let prompt_bytes = fs::read(&prompt_path).unwrap();
    let prompt_digest = sha256_hex(&prompt_bytes);
    let sidecar = prompt_path.with_extension("package-rendered.md");

    assert!(
        !sidecar.exists(),
        "discarded rendered sidecar still exists at {}",
        sidecar.display()
    );
    assert_eq!(spec["prompt_digest"].as_str().unwrap(), prompt_digest);
    let seam_source =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/seam/mod.rs")).unwrap();
    assert!(
        !seam_source.contains("package-rendered.md"),
        "sidecar writer remains in seam source"
    );
}

#[test]
fn lens_allocation_survives_resume() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("lens-resume");
    fixture.install_transport();
    let repo = fixture.install_repo_task_pack();
    std::env::set_current_dir(&repo).unwrap();

    let mut state = CoreState::open(None).unwrap();
    let response = command("autopilot-plan ws task.md context.md", &mut state);
    assert!(
        matches!(response.kind.as_str(), "spawn" | "spawn-wave"),
        "unexpected response: {response:?}"
    );
    let before = manifest_lenses(&repo);
    drop(state);
    let _reopened = CoreState::open(None).unwrap();
    let after = manifest_lenses(&repo);

    assert_eq!(before, after);
    assert_eq!(
        before
            .get("planning-ws-task-extractor-01")
            .map(String::as_str),
        Some("WORK")
    );
    assert_eq!(
        before
            .get("planning-ws-task-extractor-07")
            .map(String::as_str),
        Some("REFERENCE")
    );
}

struct PlanningRequestSpec<'a> {
    assignment_id: &'a str,
    role: &'a str,
    mode: &'a str,
    boundary: &'a str,
    mode_parameter: Option<String>,
    atom_id_prefix: Option<String>,
    registry: Option<(String, String)>,
    accepted_planning_artifacts: Vec<runner::AcceptedPlanningArtifactBinding>,
}

impl<'a> PlanningRequestSpec<'a> {
    fn new(assignment_id: &'a str, role: &'a str, mode: &'a str, boundary: &'a str) -> Self {
        Self {
            assignment_id,
            role,
            mode,
            boundary,
            mode_parameter: None,
            atom_id_prefix: None,
            registry: None,
            accepted_planning_artifacts: Vec::new(),
        }
    }

    fn mode_parameter(mut self, value: String) -> Self {
        self.mode_parameter = Some(value);
        self
    }

    fn atom_id_prefix(mut self, value: String) -> Self {
        self.atom_id_prefix = Some(value);
        self
    }

    fn registry(mut self, value: (String, String)) -> Self {
        self.registry = Some(value);
        self
    }

    fn accepted_planning_artifacts(
        mut self,
        value: Vec<runner::AcceptedPlanningArtifactBinding>,
    ) -> Self {
        self.accepted_planning_artifacts = value;
        self
    }
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
        let pid = std::process::id();
        loop {
            let nonce = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = temp.join(format!("pi-autopilot-impl6-{label}-{pid}-{nonce}"));
            match fs::create_dir(&root) {
                Ok(()) => {
                    std::env::set_current_dir(&root).unwrap();
                    return Self { root };
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("fixture root {root:?}: {error}"),
            }
        }
    }

    fn install_transport(&self) {
        let bin = self.root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        let wrapper = bin.join("wrapper.mjs");
        fs::write(&node, "#!/bin/sh\nexit 0\n").unwrap();
        fs::write(&wrapper, "// wrapper\n").unwrap();
        make_executable(&node);
        unsafe {
            std::env::set_var("AUTOPILOT_NODE_EXECUTABLE", &node);
            std::env::set_var("AUTOPILOT_AGENT_RUNNER_WRAPPER", &wrapper);
            std::env::set_var(
                "AUTOPILOT_CHILD_ADDON_PATH",
                Path::new(env!("CARGO_MANIFEST_DIR")).join(concat!(
                    "../src/generated/child-",
                    "ext",
                    "ension.ts"
                )),
            );
            let mut path_entries = vec![bin.clone()];
            if let Some(existing) = std::env::var_os("PATH") {
                path_entries.extend(std::env::split_paths(&existing));
            }
            std::env::set_var(
                "PATH",
                std::env::join_paths(path_entries).expect("join PATH"),
            );
        }
    }

    fn issue_extractor(
        &self,
        assignment_id: &str,
        mode_parameter: &str,
    ) -> runner::IssuedRunnerAction {
        self.issue_planning_request(
            PlanningRequestSpec::new(
                assignment_id,
                "task-extractor",
                "inventory",
                "planning.task-atoms.v1",
            )
            .mode_parameter(mode_parameter.to_owned())
            .atom_id_prefix(format!("TE{}-", assignment_id.rsplit('-').next().unwrap())),
        )
        .unwrap()
    }

    fn issue_planning_request(
        &self,
        spec: PlanningRequestSpec<'_>,
    ) -> Result<runner::IssuedRunnerAction, runner::RunnerError> {
        let (atom_registry_path, atom_registry_digest) = match spec.registry {
            Some((path, digest)) => (Some(path), Some(digest)),
            None => (None, None),
        };
        let context_document = runner_doc(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        runner::planning_issue(&PlanningRunnerRequest {
            workstream: "ws".to_owned(),
            action_id: Id(format!("action-{}", spec.assignment_id)),
            assignment_id: Id(spec.assignment_id.to_owned()),
            role_id: Id(spec.role.to_owned()),
            mode: ModeId(spec.mode.to_owned()),
            boundary_id: ContractId(spec.boundary.to_owned()),
            run_revision: 1,
            authority_set_id: "auth".to_owned(),
            authority_documents: vec![runner_doc("task.md", "authority", "auth", "Do the work")],
            context_document: context_document.clone(),
            context_documents: vec![context_document],
            mode_parameter: spec.mode_parameter,
            atom_id_prefix: spec.atom_id_prefix,
            atom_registry_path,
            atom_registry_digest,
            accepted_planning_artifacts: spec.accepted_planning_artifacts,
        })
    }

    fn write_atom_registry(&self, atoms: &[(&str, &str)]) -> (String, String) {
        let path = self
            .root
            .join(".pi/autopilot/ws/planning/atom-registry.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes = serde_json::to_vec_pretty(&json!({
            "schema":"autopilot.planning_atom_registry.v1",
            "workstream":"ws",
            "authority_set_id":"auth",
            "producer_assignment_ids": atoms.iter().map(|(_, producer)| *producer).collect::<Vec<_>>(),
            "atoms": atoms.iter().map(|(id, producer)| json!({"id":id,"producer_assignment_id":producer,"kind":"work","text":"atom","sources":["task.md"]})).collect::<Vec<_>>()
        })).unwrap();
        fs::write(&path, &bytes).unwrap();
        (path.display().to_string(), sha256_hex(&bytes))
    }

    fn accepted_artifact(
        &self,
        category_id: &str,
        boundary_id: &str,
        role_id: &str,
        assignment_id: &str,
    ) -> runner::AcceptedPlanningArtifactBinding {
        let path = self
            .root
            .join("accepted")
            .join(format!("{category_id}.json"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes = serde_json::to_vec_pretty(&json!({
            "category_id": category_id,
            "boundary_id": boundary_id,
            "assignment_id": assignment_id,
        }))
        .unwrap();
        fs::write(&path, &bytes).unwrap();
        runner::AcceptedPlanningArtifactBinding {
            category_id: category_id.to_owned(),
            assignment_id: Id(assignment_id.to_owned()),
            role_id: Id(role_id.to_owned()),
            boundary_id: ContractId(boundary_id.to_owned()),
            path: path.display().to_string(),
            digest: sha256_hex(&bytes),
        }
    }

    fn install_repo_task_pack(&self) -> PathBuf {
        let repo = self.root.join("repo");
        let vcs = GitVcs::new(&self.root);
        vcs.init_fixture(&repo).unwrap();
        fs::write(
            repo.join("task.md"),
            "[authority]\nauthority_set_id: auth\n\n# Task\nDo the work.\n",
        )
        .unwrap();
        fs::write(
            repo.join("context.md"),
            "[context/non-authority]\nauthority_set_id: auth\n\n# Context\nRepository facts.\n",
        )
        .unwrap();
        vcs.stage_all(&repo).unwrap();
        vcs.snapshot(&repo, "task pack").unwrap();
        repo
    }

    fn install_multi_context_task_pack(&self) -> PathBuf {
        let repo = self.root.join("repo");
        let vcs = GitVcs::new(&self.root);
        vcs.init_fixture(&repo).unwrap();
        for index in 1..=6 {
            fs::write(
                repo.join(format!("A{index}.md")),
                format!("[authority]\nauthority_set_id: auth\n\n# Authority {index}\nA{index}\n"),
            )
            .unwrap();
        }
        fs::write(
            repo.join("C1.md"),
            "[context/non-authority]\nauthority_set_id: auth\n\n# Context 1\nCTX1\n",
        )
        .unwrap();
        fs::write(
            repo.join("C2.md"),
            "[context/non-authority]\nauthority_set_id: auth\n\n# Context 2\nCTX2\n",
        )
        .unwrap();
        vcs.stage_all(&repo).unwrap();
        vcs.snapshot(&repo, "multi context task pack").unwrap();
        repo
    }
}

fn command(raw: &str, state: &mut CoreState) -> SeamEnvelope {
    let frame = json!({"v":1,"id":1,"kind":"command","payload":{"raw":raw,"background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true},"background_capability_diagnostic":null}});
    seam::handle_line(&frame.to_string(), state).unwrap()
}

fn agent_response_from_spec(spec_path: &Path, raw: &str, state: &mut CoreState) -> SeamEnvelope {
    let carrier = carrier_value_from_spec(spec_path, raw);
    let carrier_path = carrier["carrier_path"].as_str().unwrap();
    fs::create_dir_all(Path::new(carrier_path).parent().unwrap()).unwrap();
    fs::write(carrier_path, serde_json::to_vec_pretty(&carrier).unwrap()).unwrap();
    let assignment_id = carrier["assignment_id"].as_str().unwrap();
    let frame = json!({"v":1,"id":1,"kind":"agent-result","payload":{"assignment_id":assignment_id,"carrier":carrier}});
    seam::handle_line(&frame.to_string(), state).unwrap()
}

fn carrier_value_from_spec(spec_path: &Path, raw: &str) -> serde_json::Value {
    let spec: serde_json::Value = serde_json::from_slice(&fs::read(spec_path).unwrap()).unwrap();
    json!({
        "schema":"autopilot.planning_carrier.v1",
        "action_id":spec["action_id"],
        "assignment_id":spec["assignment_id"],
        "run_revision":spec["run_revision"],
        "workstream":spec["workstream"],
        "role_id":spec["role_id"],
        "mode":spec["mode"],
        "boundary_id":spec["boundary_id"],
        "result_contract":spec["result_contract"],
        "prompt_path":spec["prompt_path"],
        "prompt_digest":spec["prompt_digest"],
        "boundary_digest":spec["boundary_digest"],
        "result_contract_digest":spec["result_contract_digest"],
        "settings_digest":spec["settings_digest"],
        "context_digest":spec["context_digest"],
        "skills_digest":spec["skills_digest"],
        "subscription_digest":spec["subscription_digest"],
        "spec_digest":sha256_hex(&fs::read(spec_path).unwrap()),
        "spec_path":spec["spec_path"],
        "carrier_path":spec["carrier_path"],
        "raw_output":raw,
    })
}

fn raw_output_for_spec(spec: &serde_json::Value) -> String {
    match spec["boundary_id"].as_str().unwrap() {
        "planning.task-atoms.v1" => {
            let prefix = spec["atom_id_prefix"].as_str().unwrap();
            json!({"atoms":[{"id":format!("{prefix}W-001"),"kind":"work","text":"Do the work","sources":["task.md"]}]}).to_string()
        }
        "planning.scout-dossier.v1" => json!({"findings":[{"path":"task.md","observation":"task authority exists","evidence_ref":"task.md"}]}).to_string(),
        "planning.work-map.v1" => json!({"units":[{"id":"U1","objective":"Implement unit","criteria":["done"],"links":["TE01-W-001"]}]}).to_string(),
        "planning.plan-review.v1" => json!({"verdicts":[{"criterion_id":"AC-U1-1","verdict":"pass"}]}).to_string(),
        other => panic!("unsupported boundary in test: {other}"),
    }
}

fn spawn_spec_paths(response: &SeamEnvelope) -> Vec<PathBuf> {
    let actions = response
        .payload
        .get("actions")
        .and_then(|actions| actions.as_array())
        .cloned()
        .or_else(|| {
            response
                .payload
                .get("action")
                .map(|action| vec![action.clone()])
        })
        .unwrap_or_default();
    actions
        .iter()
        .map(|action| spec_path_from_command(action["bg_run"]["command"].as_str().unwrap()))
        .collect()
}

fn response_status(response: &SeamEnvelope) -> String {
    response
        .payload
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn context_manifest_from_prompt(prompt: &str) -> serde_json::Value {
    let marker = "## Layer 5 — canonical Context Manifest";
    let after_marker = prompt.split_once(marker).unwrap().1;
    let after_fence = after_marker.split_once("```text\n").unwrap().1;
    let manifest_text = after_fence.split_once("\n```").unwrap().0;
    serde_json::from_str(manifest_text).unwrap()
}

fn manifest_lenses(repo: &Path) -> std::collections::BTreeMap<String, String> {
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(repo.join(".pi/autopilot/ws/planning-manifest.json")).unwrap(),
    )
    .unwrap();
    manifest["assignments"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|assignment| {
            let id = assignment["assignment_id"].as_str()?.to_owned();
            let lens = assignment["mode_parameter"].as_str()?.to_owned();
            Some((id, lens))
        })
        .collect()
}

fn spec_path_from_command(command: &str) -> PathBuf {
    let parts = command.split_whitespace().collect::<Vec<_>>();
    let index = parts
        .iter()
        .position(|part| *part == "--spec")
        .expect("runner command includes --spec");
    PathBuf::from(parts[index + 1].trim_matches('\''))
}

fn runner_doc(path: &str, class: &str, authority_set_id: &str, body: &str) -> RunnerTaskDocument {
    let digest = task_document_digest(class, authority_set_id, body);
    RunnerTaskDocument::new(path.to_owned(), class.to_owned(), digest, body.to_owned())
}

fn task_document_digest(class: &str, authority_set_id: &str, body: &str) -> String {
    let marker = match class {
        "authority" => "[authority]",
        "context/non-authority" => "[context/non-authority]",
        other => other,
    };
    sha256_hex(format!("{marker}\nauthority_set_id: {authority_set_id}\n\n{body}").as_bytes())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::new();
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }
}

/// First launched bg_run command from either a singular `spawn` or a batched `spawn-wave`.
fn first_spawn_command(payload: &serde_json::Value) -> String {
    let action = payload
        .get("actions")
        .and_then(|actions| actions.as_array())
        .and_then(|actions| actions.first())
        .or_else(|| payload.get("action"))
        .unwrap_or_else(|| panic!("spawn payload has no action: {payload:?}"));
    action["bg_run"]["command"]
        .as_str()
        .unwrap_or_else(|| panic!("action has no bg_run command: {action:?}"))
        .to_owned()
}
