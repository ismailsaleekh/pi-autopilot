use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use drivers::runner::{self, PlanningRunnerRequest, RunnerTaskDocument};
use drivers::seam::{self, CoreState};
use drivers::vcs::GitVcs;
use kernel::generated::{ContractId, EventKind, EventRow, Id, ModeId, Ref, SeamEnvelope};
use serde_json::json;
use sha2::{Digest as ShaDigest, Sha256};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn receipt_v1_planning_accepts_then_consumes_without_carrier_or_spec_rereads() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("receipt-handoff");
    fixture.install_transport_with_nonexistent_command_names();
    fixture.write_manifest();
    let mut state = CoreState::open(None).unwrap();
    let issue =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-01", "TE01-");
    let spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&fs::read(&issue.binding.spec_path).unwrap()).unwrap();
    let raw: serde_json::Value = serde_json::from_str(&task_atoms("TE01-A")).unwrap();
    let submit = json!({"v":1,"id":6,"kind":"child-control","payload":{"broker_capability":fixture.broker_capability(),"request":{
        "schema":"autopilot.child_control_request.v1","request_id":"request-1",
        "token":spec.child_control_token,"run_id":issue.receipt_binding.run_id,
        "assignment_id":issue.receipt_binding.assignment_id,"attempt":issue.receipt_binding.attempt,
        "tool_call_id":"tool-call-1","kind":"submit",
        "tool_name":issue.receipt_binding.tool_name,"profile_id":issue.receipt_binding.profile_id,
        "raw_payload":raw,
        "runtime_evidence":{"schema":"autopilot.child_control_runtime_evidence.v1","delivery_policy_denials":null,"approved_command_executions":null}
    }}});
    let accepted = seam::handle_line(&submit.to_string(), &mut state).unwrap();
    assert_eq!(accepted.kind, "child-control", "{accepted:?}");
    assert_eq!(accepted.payload["response"]["outcome"], "ACCEPT");
    let receipt = accepted.payload["response"]["receipt"]["receipt"].clone();

    // Exact replay returns the original receipt and appends no second accepted
    // root. A changed raw payload is rejected before it can create artifacts.
    let mut replay_submit = submit.clone();
    replay_submit["payload"]["request"]["request_id"] = json!("request-2");
    replay_submit["payload"]["request"]["tool_call_id"] = json!("tool-call-2");
    let replay = seam::handle_line(&replay_submit.to_string(), &mut state).unwrap();
    assert_eq!(replay.payload["response"]["outcome"], "ACCEPT");
    assert_eq!(replay.payload["response"]["request_id"], "request-2");
    assert_eq!(replay.payload["response"]["receipt"]["receipt"], receipt);
    assert_eq!(
        replay.payload["response"]["receipt"]["receipt"]["tool_call_id"],
        "tool-call-1"
    );
    let mut conflict = submit.clone();
    conflict["payload"]["request"]["raw_payload"] =
        serde_json::from_str(&task_atoms("TE01-B")).unwrap();
    let retry = seam::handle_line(&conflict.to_string(), &mut state).unwrap();
    assert_eq!(retry.payload["response"]["outcome"], "RETRY");

    fs::remove_file(&issue.binding.spec_path).unwrap();
    let replay_without_spec = seam::handle_line(&replay_submit.to_string(), &mut state).unwrap();
    assert_eq!(replay_without_spec.payload["response"]["outcome"], "ACCEPT");
    fs::remove_file(&issue.binding.carrier_path).unwrap();
    let frame = json!({"v":1,"id":7,"kind":"task-completed","payload":{"task_id":"task-terminal","action_id":issue.receipt_binding.action_id,"assignment_id":issue.receipt_binding.assignment_id,"status":"completed"}});
    let completed = seam::handle_line(&frame.to_string(), &mut state).unwrap();
    assert_spawn_assignment(&completed, "planning-ws-task-extractor-02");
    let again = seam::handle_line(&frame.to_string(), &mut state).unwrap();
    assert_eq!(
        spawned_assignment_ids(&again),
        spawned_assignment_ids(&completed)
    );
}

#[test]
fn receipt_v1_missing_receipt_never_falls_back_to_legacy_carrier() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("receipt-missing-no-legacy");
    fixture.install_transport_with_nonexistent_command_names();
    let mut state = CoreState::open(None).unwrap();
    let issue = fixture.seed_receipt_planning_binding(
        &mut state,
        "planning-ws-task-extractor-01",
        "TE01-",
    );
    fs::create_dir_all(Path::new(&issue.binding.carrier_path).parent().unwrap()).unwrap();
    fs::write(&issue.binding.carrier_path, b"not a receipt-backed carrier").unwrap();
    let completed = seam::handle_line(
        &json!({"v":1,"id":54,"kind":"task-completed","payload":{
            "task_id":"task-missing","action_id":issue.receipt_binding.action_id,
            "assignment_id":issue.receipt_binding.assignment_id,"status":"completed"
        }})
        .to_string(),
        &mut state,
    )
    .unwrap();
    assert_eq!(completed.kind, "done");
    assert_eq!(completed.payload["status"], "rejection:submit-receipt:missing receipt");
}

#[test]
fn receipt_v1_issuance_replays_exact_v5_token_spec_and_attempt() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("receipt-issuance-replay");
    fixture.install_transport_with_nonexistent_command_names();
    let first = fixture.issue_planning("planning-ws-task-extractor-01", "TE01-");
    let first_spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&fs::read(&first.binding.spec_path).unwrap()).unwrap();
    let second = fixture.issue_planning("planning-ws-task-extractor-01", "TE01-");
    let second_bytes = fs::read(&second.binding.spec_path).unwrap();
    let second_spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&second_bytes).unwrap();

    assert_eq!(first_spec, second_spec);
    assert_eq!(first.binding.spec_digest, second.binding.spec_digest);
    assert_eq!(
        first.receipt_binding.run_capability_digest,
        second.receipt_binding.run_capability_digest
    );
    assert_eq!(first_spec.required_pi_version, runner::REQUIRED_PI_VERSION);
    assert_eq!(first_spec.attempt, Some(1));
    assert_eq!(first.receipt_binding.attempt, 1);
}

#[test]
fn receipt_root_uses_actual_event_bytes_and_refuses_duplicate_roots() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("receipt-root-hash");
    fixture.install_transport_with_nonexistent_command_names();
    fixture.write_manifest();
    let event_path = fixture.root.join("events.jsonl");
    let mut state = CoreState::open(Some(event_path.clone())).unwrap();
    let issue =
        fixture.seed_receipt_planning_binding(&mut state, "planning-ws-task-extractor-01", "TE01-");
    let spec: kernel::generated::AgentRunSpecV5 =
        serde_json::from_slice(&fs::read(&issue.binding.spec_path).unwrap()).unwrap();
    let submit = json!({"v":1,"id":61,"kind":"child-control","payload":{"broker_capability":fixture.broker_capability(),"request":{
        "schema":"autopilot.child_control_request.v1","request_id":"request-61",
        "token":spec.child_control_token,"run_id":issue.receipt_binding.run_id,
        "assignment_id":issue.receipt_binding.assignment_id,"attempt":issue.receipt_binding.attempt,
        "tool_call_id":"tool-call-61","kind":"submit",
        "tool_name":issue.receipt_binding.tool_name,"profile_id":issue.receipt_binding.profile_id,
        "raw_payload":serde_json::from_str::<serde_json::Value>(&task_atoms("TE01-A")).unwrap(),
        "runtime_evidence":{"schema":"autopilot.child_control_runtime_evidence.v1","delivery_policy_denials":null,"approved_command_executions":null}
    }}});
    let accepted = seam::handle_line(&submit.to_string(), &mut state).unwrap();
    assert_eq!(accepted.payload["response"]["outcome"], "ACCEPT");
    drop(state);
    let mut persisted = CoreState::open(Some(event_path.clone())).unwrap();
    let replay = seam::handle_line(&submit.to_string(), &mut persisted).unwrap();
    assert_eq!(replay.payload["response"]["outcome"], "ACCEPT");
    drop(persisted);

    let mut rows = fs::read_to_string(&event_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<EventRow>(line).unwrap())
        .collect::<Vec<_>>();
    let accepted_row = rows
        .iter()
        .find(|row| row.kind.0 == "submit:accepted")
        .cloned()
        .unwrap();
    let last = rows.last().unwrap().clone();
    rows.push(EventRow {
        sequence: last.sequence + 1,
        previous_revision: last.new_revision,
        new_revision: last.new_revision + 1,
        kind: EventKind("submit:accepted".to_owned()),
        artifact_refs: accepted_row.artifact_refs,
    });
    let bytes = rows
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join("\n");
    fs::write(&event_path, format!("{bytes}\n")).unwrap();

    let mut replayed = CoreState::open(Some(event_path)).unwrap();
    let retry = seam::handle_line(&submit.to_string(), &mut replayed).unwrap();
    assert_eq!(retry.kind, "child-control");
    assert_eq!(retry.payload["response"]["outcome"], "RETRY");
    assert_eq!(
        retry.payload["response"]["diagnostic"]["errors"][0]["code"],
        "submit.receipt_root"
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
            std::env::set_var("AUTOPILOT_CHILD_CONTROL_SOCKET_PATH", broker_socket_path());
            std::env::set_var(
                "AUTOPILOT_CHILD_CONTROL_BROKER_CAPABILITY",
                self.broker_capability(),
            );
        }
    }

    fn broker_capability(&self) -> &'static str {
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
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

    fn seed_receipt_planning_binding(
        &self,
        state: &mut CoreState,
        assignment_id: &str,
        prefix: &str,
    ) -> runner::IssuedRunnerAction {
        let issue = self.issue_planning(assignment_id, prefix);
        append_ref(
            state,
            &runner::receipt_binding_ref(&issue.receipt_binding).unwrap(),
        );
        append_ref(state, &Ref(assignment_id.to_owned()));
        issue
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
            attempt: 1,
            run_revision: 1,
            authority_set_id: "auth".to_owned(),
            authority_documents: vec![runner_doc("task.md", "authority", "auth", "Do the work")],
            context_document: context_document.clone(),
            context_documents: vec![context_document],
            mode_parameter: first_mode_parameter_for("task-extractor"),
            atom_id_prefix: Some(prefix.to_owned()),
            atom_registry_path: None,
            atom_registry_digest: None,
            terminal_route: None,
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

#[cfg(unix)]
fn broker_socket_path() -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    let root = PathBuf::from("/tmp/.pi-ap");
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let dir = loop {
        let id = format!("{:010x}", FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed));
        let candidate = root.join(id);
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

#[cfg(not(unix))]
fn broker_socket_path() -> PathBuf {
    PathBuf::from("/tmp/.pi-ap/0000000000/s")
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
