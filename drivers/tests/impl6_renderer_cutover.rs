use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use drivers::runner::{self, PlanningRunnerRequest, RunnerTaskDocument};
use drivers::seam::{self, CoreState};
use drivers::vcs::GitVcs;
use kernel::generated::{ContractId, CoreToHostSpawnPayload, Id, ModeId, SeamEnvelope};
use serde_json::json;
use sha2::{Digest as ShaDigest, Sha256};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("pi-autopilot-impl6-{label}-{nanos}"));
        fs::create_dir_all(&root).unwrap();
        std::env::set_current_dir(&root).unwrap();
        Self { root }
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
                "PATH",
                format!(
                    "{}:{}",
                    bin.display(),
                    std::env::var("PATH").unwrap_or_default()
                ),
            );
        }
    }

    fn issue_extractor(
        &self,
        assignment_id: &str,
        mode_parameter: &str,
    ) -> runner::IssuedRunnerAction {
        let context_document = runner_doc(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        runner::planning_issue(&PlanningRunnerRequest {
            workstream: "ws".to_owned(),
            action_id: Id(format!("action-{assignment_id}")),
            assignment_id: Id(assignment_id.to_owned()),
            role_id: Id("task-extractor".to_owned()),
            mode: ModeId("inventory".to_owned()),
            boundary_id: ContractId("planning.task-atoms.v1".to_owned()),
            run_revision: 1,
            authority_set_id: "auth".to_owned(),
            authority_documents: vec![runner_doc("task.md", "authority", "auth", "Do the work")],
            context_document: context_document.clone(),
            context_documents: vec![context_document],
            mode_parameter: Some(mode_parameter.to_owned()),
            atom_id_prefix: Some(format!("TE{}-", assignment_id.rsplit('-').next().unwrap())),
            atom_registry_path: None,
            atom_registry_digest: None,
        })
        .unwrap()
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
