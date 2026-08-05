use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use drivers::runner::{self, PlanningRunnerRequest, RunnerTaskDocument};
use drivers::seam::{self, CoreState};
use drivers::vcs::GitVcs;
use kernel::generated::{ContractId, Id, ModeId, Ref, SeamEnvelope};
use serde_json::json;
use sha2::{Digest as ShaDigest, Sha256};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn task_completed_alone_consumes_planning_carrier_and_launches_follow_up() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("handoff");
    fixture.install_transport_with_nonexistent_command_names();
    fixture.write_manifest();
    let mut from_task_completed = CoreState::open(None).unwrap();
    let binding = fixture.seed_planning_binding(
        &mut from_task_completed,
        "planning-ws-task-extractor-01",
        "TE01-",
        task_atoms("TE01-A"),
    );

    let frame = json!({"v":1,"id":7,"kind":"task-completed","payload":{"task_id":"task-terminal","action_id":binding.action_id,"assignment_id":binding.assignment_id,"status":"completed"}});
    let completed = seam::handle_line(&frame.to_string(), &mut from_task_completed).unwrap();
    assert_spawn_assignment(&completed, "planning-ws-task-extractor-02");

    let mut from_agent_result = CoreState::open(None).unwrap();
    let same = fixture.seed_planning_binding(
        &mut from_agent_result,
        "planning-ws-task-extractor-01",
        "TE01-",
        task_atoms("TE01-A"),
    );
    let carrier = carrier_value(&same, &task_atoms("TE01-A"));
    let legacy = json!({"v":1,"id":8,"kind":"agent-result","payload":{"assignment_id":same.assignment_id,"carrier":carrier}});
    let agent_result = seam::handle_line(&legacy.to_string(), &mut from_agent_result).unwrap();
    assert_eq!(
        spawned_assignment_ids(&completed),
        spawned_assignment_ids(&agent_result)
    );
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
        let pid = std::process::id();
        loop {
            let root = temp.join(format!(
                "pi-autopilot-w3-h3-{label}-{pid}-{}",
                FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&root) {
                Ok(()) => {
                    let vcs = GitVcs::new(&temp);
                    vcs.init_fixture(&root).unwrap();
                    fs::write(
                        root.join(".gitignore"),
                        ".pi/autopilot/\n.pi/tasks/\nbin/\n",
                    )
                    .unwrap();
                    vcs.stage_all(&root).unwrap();
                    vcs.snapshot(&root, "fixture root").unwrap();
                    std::env::set_current_dir(&root).unwrap();
                    return Self { root };
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("fixture root {root:?}: {error}"),
            }
        }
    }

    fn install_transport_with_nonexistent_command_names(&self) {
        let bin = self.root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let node = bin.join("nonexistent-node-name");
        let wrapper = bin.join("nonexistent-wrapper-name.mjs");
        fs::write(&node, "#!/bin/sh\nexit 127\n").unwrap();
        fs::write(&wrapper, "// nonexistent wrapper fixture\n").unwrap();
        make_executable(&node);
        unsafe {
            std::env::set_var("AUTOPILOT_NODE_EXECUTABLE", &node);
            std::env::set_var("AUTOPILOT_AGENT_RUNNER_WRAPPER", &wrapper);
            std::env::set_var(
                "AUTOPILOT_CHILD_ADDON_PATH",
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
            );
        }
    }

    fn write_manifest(&self) {
        fs::create_dir_all(self.root.join(".pi/autopilot/ws")).unwrap();
        let authority = runner_doc_json("task.md", "authority", "auth", "Do the work");
        let context = runner_doc_json(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        fs::write(self.root.join(".pi/autopilot/ws/planning-manifest.json"), serde_json::to_vec_pretty(&json!({
            "workstream":"ws","authority_set_id":"auth","authority_documents":[authority],"context_documents":[context],"context_document":context,
            "assignments":[
                {"assignment_id":"planning-ws-task-extractor-01","role":"task-extractor","mode":"inventory","boundary_id":"planning.task-atoms.v1","ordinal":1,"atom_id_prefix":"TE01-"},
                {"assignment_id":"planning-ws-task-extractor-02","role":"task-extractor","mode":"inventory","boundary_id":"planning.task-atoms.v1","ordinal":2,"atom_id_prefix":"TE02-"}
            ],
            "planning_wave_cap":7,"planning_max_attempts":2,
            "planning_waves":[{"id":"P1.extract","role":"task-extractor","dependencies":[],"ordinals":null,"activation_ref":null,"canonical_output":false}]
        })).unwrap()).unwrap();
    }

    fn seed_planning_binding(
        &self,
        state: &mut CoreState,
        assignment_id: &str,
        prefix: &str,
        raw: String,
    ) -> runner::IssuedRunnerBinding {
        let issue = self.issue_planning(assignment_id, prefix);
        fs::create_dir_all(Path::new(&issue.binding.carrier_path).parent().unwrap()).unwrap();
        fs::write(
            &issue.binding.carrier_path,
            serde_json::to_vec_pretty(&carrier_value(&issue.binding, &raw)).unwrap(),
        )
        .unwrap();
        append_ref(state, &runner::binding_ref(&issue.binding).unwrap());
        append_ref(state, &Ref(assignment_id.to_owned()));
        issue.binding
    }

    fn issue_planning(&self, assignment_id: &str, prefix: &str) -> runner::IssuedRunnerAction {
        let context_document = runner_doc(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        let issued = runner::planning_issue(&PlanningRunnerRequest {
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
            mode_parameter: first_mode_parameter_for("task-extractor"),
            atom_id_prefix: Some(prefix.to_owned()),
            atom_registry_path: None,
            atom_registry_digest: None,
            accepted_planning_artifacts: Vec::new(),
        })
        .unwrap();
        assert!(issued.action.bg_run.notify_on_completion);
        assert!(!issued.action.bg_run.trigger_on_completion);
        issued
    }
}

fn append_ref(state: &mut CoreState, reference: &Ref) {
    let frame = json!({"v":1,"id":1,"kind":"command","payload":{"raw":format!("append:test:{}", reference.0),"background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true},"background_capability_diagnostic":null}});
    let response = seam::handle_line(&frame.to_string(), state).unwrap();
    assert!(
        response
            .payload
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap()
            .contains("state:sequence")
    );
}

fn assert_spawn_assignment(response: &SeamEnvelope, assignment_id: &str) {
    assert_machine_only_completion(response);
    assert!(
        matches!(response.kind.as_str(), "spawn" | "spawn-wave"),
        "expected spawn response: {response:?}"
    );
    assert!(
        spawned_assignment_ids(response)
            .iter()
            .any(|id| id == assignment_id),
        "spawn should launch {assignment_id}: {response:?}"
    );
}

fn assert_machine_only_completion(response: &SeamEnvelope) {
    let actions = response
        .payload
        .get("actions")
        .and_then(serde_json::Value::as_array);
    let single = response.payload.get("action").into_iter();
    for action in actions.into_iter().flatten().chain(single) {
        assert_eq!(action["bg_run"]["notifyOnCompletion"], true);
        assert_eq!(action["bg_run"]["triggerOnCompletion"], false);
    }
}

fn spawned_assignment_ids(response: &SeamEnvelope) -> Vec<String> {
    let read = |action: &serde_json::Value| {
        action
            .get("assignment_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    if let Some(actions) = response.payload.get("actions").and_then(|v| v.as_array()) {
        return actions.iter().filter_map(read).collect();
    }
    response
        .payload
        .get("action")
        .and_then(read)
        .into_iter()
        .collect()
}

fn carrier_value(binding: &runner::IssuedRunnerBinding, raw: &str) -> serde_json::Value {
    json!({"schema":"autopilot.planning_carrier.v1","action_id":binding.action_id.0,"assignment_id":binding.assignment_id.0,"run_revision":binding.run_revision,"workstream":binding.workstream.0,"role_id":binding.role_id.0,"mode":binding.mode.0,"boundary_id":binding.boundary_id.0,"result_contract":binding.result_contract.0,"prompt_path":binding.prompt_path,"prompt_digest":binding.prompt_digest,"boundary_digest":binding.boundary_digest,"result_contract_digest":binding.result_contract_digest,"settings_digest":binding.settings_digest,"context_digest":binding.context_digest,"skills_digest":binding.skills_digest,"subscription_digest":binding.subscription_digest,"spec_digest":binding.spec_digest,"spec_path":binding.spec_path,"carrier_path":binding.carrier_path,"raw_output":raw})
}

fn task_atoms(id: &str) -> String {
    json!({"atoms":[{"id":id,"kind":"work","text":"Do the work","sources":[anchor("task.md", "authority", "auth", "Do the work")]}]}).to_string()
}

fn runner_doc(path: &str, class: &str, authority_set_id: &str, body: &str) -> RunnerTaskDocument {
    RunnerTaskDocument::new(
        path.to_owned(),
        class.to_owned(),
        task_file_digest(class, authority_set_id, body),
        body.to_owned(),
    )
}

fn runner_doc_json(
    path: &str,
    class: &str,
    authority_set_id: &str,
    body: &str,
) -> serde_json::Value {
    let doc = runner_doc(path, class, authority_set_id, body);
    json!({"path":doc.path,"class":doc.class,"digest":doc.digest,"body_digest":doc.body_digest,"body":doc.body})
}

fn anchor(path: &str, class: &str, authority_set_id: &str, body: &str) -> String {
    format!(
        "task://{}/{}#whole-file",
        task_file_digest(class, authority_set_id, body),
        path
    )
}

fn task_file_digest(class: &str, authority_set_id: &str, body: &str) -> String {
    let marker = match class {
        "authority" => "[authority]",
        "context/non-authority" => "[context/non-authority]",
        other => other,
    };
    sha256_hex(format!("{marker}\nauthority_set_id: {authority_set_id}\n\n{body}").as_bytes())
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
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

fn first_mode_parameter_for(role: &str) -> Option<String> {
    let roles = drivers::roles::RoleRegistry::package().expect("role registry");
    let role = roles.get(role).expect("role is registered");
    drivers::roles::allocate_mode_parameters(role, role.mode_parameters.len().max(1))
        .expect("mode parameter allocation")
        .first()
        .cloned()
        .flatten()
}
