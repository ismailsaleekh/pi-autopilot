use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use drivers::planning::{self, TaskAnchorRegistry, TaskDocument, TaskDocumentClass, TaskInputSet};
use drivers::runner::{self, PlanningRunnerRequest, RunnerTaskDocument};
use drivers::seam::{self, CoreState};
use kernel::generated::{
    ContractId, Id, ModeId, PlanningAtomKind, Ref, SeamEnvelope, TaskAtom, TaskAtoms,
};
use serde_json::json;
use sha2::{Digest as ShaDigest, Sha256};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[test]
fn runner_child_rejects_atom_outside_runner_namespace() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("namespace");
    fixture.install_transport();
    fixture.install_fake_pi(&[
        task_atoms("SMF-P-001"),
        task_atoms("SMF-P-001"),
        task_atoms("SMF-P-001"),
    ]);
    let issue = fixture.issue_planning(
        "task-extractor",
        "inventory",
        "planning.task-atoms.v1",
        Some("TE01-"),
        None,
    );

    let result =
        drivers::runner::child::main(&["--spec".to_owned(), issue.binding.spec_path.clone()]);

    assert!(
        result.is_err(),
        "outside-prefix atom must exhaust value repair"
    );
    assert!(
        !Path::new(&issue.binding.carrier_path).exists(),
        "rejected output must not create carrier"
    );
    let attempts = fixture.read_attempt_events(&issue.binding);
    assert!(
        has_attempt_event(&attempts, "value-rejected"),
        "attempt events must record value rejection: {attempts:?}"
    );
}

#[test]
fn runner_child_repairs_unknown_links_from_bound_atom_registry() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("links");
    fixture.install_transport();
    let (registry_path, registry_digest) =
        fixture.write_atom_registry(&[("TE01-W-001", "planning-ws-task-extractor-01")]);
    fixture.install_fake_pi(&[work_map(&["A1", "A2", "A3"]), work_map(&["TE01-W-001"])]);
    let issue = fixture.issue_planning(
        "plan-compiler",
        "initial-plan",
        "planning.work-map.v1",
        None,
        Some((registry_path, registry_digest)),
    );

    drivers::runner::child::main(&["--spec".to_owned(), issue.binding.spec_path.clone()]).unwrap();

    let attempts = fixture.read_attempt_events(&issue.binding);
    assert!(
        has_attempt_event(&attempts, "value-rejected"),
        "unknown links must be rejected first: {attempts:?}"
    );
    assert!(
        has_attempt_event(&attempts, "accepted"),
        "second model value must be accepted: {attempts:?}"
    );
    let raw_output = carrier_raw_output(&issue.binding);
    let accepted: serde_json::Value = serde_json::from_str(&raw_output).unwrap();
    assert_eq!(accepted["units"][0]["links"], json!(["TE01-W-001"]));
}

#[test]
fn accepted_registry_rejects_cross_extractor_duplicate_and_is_resume_stable() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let duplicate = Fixture::new("registry-dupe");
    duplicate.install_transport();
    duplicate.write_manifest(&[
        (
            "planning-ws-task-extractor-01",
            "task-extractor",
            Some("TE01-"),
        ),
        (
            "planning-ws-task-extractor-02",
            "task-extractor",
            Some("TE02-"),
        ),
    ]);
    let mut state = CoreState::open(None).unwrap();
    let first = duplicate.seed_planning_binding(
        &mut state,
        "task-extractor",
        "inventory",
        "planning.task-atoms.v1",
        "planning-ws-task-extractor-01",
        Some("TE01-"),
        None,
        task_atoms("TE01-DUP"),
    );
    let second = duplicate.seed_planning_binding(
        &mut state,
        "task-extractor",
        "inventory",
        "planning.task-atoms.v1",
        "planning-ws-task-extractor-02",
        Some("TE02-"),
        None,
        task_atoms("TE02-OK"),
    );
    duplicate.overwrite_carrier_raw(&second, task_atoms("TE01-DUP"));
    let ok = duplicate.agent_result(&mut state, &first, task_atoms("TE01-DUP"));
    assert!(
        ok.contains("accepted"),
        "first extractor should be accepted: {ok}"
    );
    let rejected = duplicate.agent_result(&mut state, &second, task_atoms("TE02-OK"));
    assert!(
        rejected.contains("planning-postprocess") && rejected.contains("atom-registry"),
        "duplicate registry must fail loudly: {rejected}"
    );

    let stable = Fixture::new("registry-stable");
    stable.install_transport();
    stable.write_manifest(&[
        (
            "planning-ws-task-extractor-01",
            "task-extractor",
            Some("TE01-"),
        ),
        (
            "planning-ws-task-extractor-02",
            "task-extractor",
            Some("TE02-"),
        ),
        ("planning-ws-repository-scout-01", "repository-scout", None),
    ]);
    let event_log = stable.root.join("events.jsonl");
    let mut state = CoreState::open(Some(event_log.clone())).unwrap();
    let a = stable.seed_planning_binding(
        &mut state,
        "task-extractor",
        "inventory",
        "planning.task-atoms.v1",
        "planning-ws-task-extractor-01",
        Some("TE01-"),
        None,
        task_atoms("TE01-A"),
    );
    let next = stable.agent_response(&mut state, &a, task_atoms("TE01-A"));
    assert_spawn_assignment(&next, "planning-ws-task-extractor-02");
    let next = stable.agent_response_from_spec(
        &mut state,
        &stable.planning_spec_path("planning-ws-task-extractor-02"),
        task_atoms("TE02-B"),
    );
    assert_spawn_assignment(&next, "planning-ws-repository-scout-01");
    let registry_path = stable
        .root
        .join(".pi/autopilot/ws/planning/atom-registry.json");
    let before = fs::read(&registry_path).unwrap();
    let mut replayed = CoreState::open(Some(event_log)).unwrap();
    let next = stable.agent_response_from_spec(
        &mut replayed,
        &stable.planning_spec_path("planning-ws-repository-scout-01"),
        scout_dossier(),
    );
    assert!(
        response_status(&next).contains("accepted"),
        "scout result should be accepted after resume: {next:?}"
    );
    let after = fs::read(&registry_path).unwrap();
    assert_eq!(
        before, after,
        "registry recomputation on resume must byte-match"
    );
}

#[test]
fn approved_units_preserve_atom_links() {
    let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let fixture = Fixture::new("approved-links");
    fixture.install_transport();
    fs::create_dir_all(fixture.root.join(".pi/autopilot/ws")).unwrap();
    fs::write(
        fixture.root.join(".pi/autopilot/ws/work-map.md"),
        work_map(&["TE01-W-001", "TE02-C-002"]),
    )
    .unwrap();
    let mut state = CoreState::open(None).unwrap();
    let binding = fixture.seed_planning_binding(
        &mut state,
        "plan-reviewer",
        "full-review",
        "planning.plan-review.v1",
        "planning-ws-plan-reviewer-01",
        None,
        None,
        plan_review(),
    );

    let status = fixture.agent_result(&mut state, &binding, plan_review());

    assert!(
        status.contains("ready-to-execute"),
        "plan review should approve via seam: {status}"
    );
    let approved =
        fs::read_to_string(fixture.root.join(".pi/autopilot/ws/approved-plan.json")).unwrap();
    assert!(
        approved.contains("TE01-W-001"),
        "approved unit decisions must retain work-map links: {approved}"
    );
    assert!(
        approved.contains("TE02-C-002"),
        "approved unit decisions must retain all work-map links: {approved}"
    );
}

#[test]
fn task_anchor_registry_accepts_real_section_and_rejects_unverified_sources() {
    let registry = TaskAnchorRegistry::from_input_set(&task_input_set(&[
        planning_doc(
            "TASK.md",
            TaskDocumentClass::Authority,
            "# Fixture Task\n\n## 3. Work Breakdown\n\nImplement it.\n\n## 4. Constraints and Banned Shapes\n\nNo silent fallback.\n\n## 5. Definition of Done\n\nFocused tests pass.\n",
        ),
        planning_doc(
            "context.md",
            TaskDocumentClass::ContextNonAuthority,
            "# Context\n\nRepository facts.\n",
        ),
    ]));

    planning::validate_task_atoms_for_assignment(
        &atoms_with_source("task://TASK.md#3-work-breakdown"),
        "TE01-",
        &registry,
    )
    .expect("exact recorded transcript section source must be admitted when the heading exists");
    planning::validate_task_atoms_for_assignment(
        &atoms_with_source("TASK.md §3"),
        "TE01-",
        &registry,
    )
    .expect("prose section source must be admitted only when the section number exists");
    planning::validate_task_atoms_for_assignment(
        &atoms_with_source("TASK.md#3-work-breakdown"),
        "TE01-",
        &registry,
    )
    .expect("bare path section source must be admitted when the path and heading exist");

    assert_source_rejected(&registry, "task://TASK.md#does-not-exist");
    assert_source_rejected(&registry, "task://NOT-A-DOC.md");

    let ambiguous = TaskAnchorRegistry::from_input_set(&task_input_set(&[
        planning_doc(
            "alpha/TASK.md",
            TaskDocumentClass::Authority,
            "# Alpha\n\n## 3. Work Breakdown\n\nAlpha.\n",
        ),
        planning_doc(
            "beta/TASK.md",
            TaskDocumentClass::Authority,
            "# Beta\n\n## 3. Work Breakdown\n\nBeta.\n",
        ),
        planning_doc(
            "context.md",
            TaskDocumentClass::ContextNonAuthority,
            "# Context\n\nRepository facts.\n",
        ),
    ]));
    assert_source_rejected(&ambiguous, "task://TASK.md#3-work-breakdown");
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
        let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = temp.join(format!("pi-autopilot-impl1-{label}-{nanos}"));
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

    fn install_fake_pi(&self, outputs: &[String]) {
        let bin = self.root.join("bin");
        let pi = bin.join("pi");
        let out_dir = self.root.join("fake-pi");
        fs::create_dir_all(&out_dir).unwrap();
        for (index, output) in outputs.iter().enumerate() {
            fs::write(out_dir.join(format!("{}.txt", index + 1)), output).unwrap();
        }
        let count_file =
            serde_json::to_string(&self.root.join("fake-pi-count").display().to_string()).unwrap();
        let out_dir_text = serde_json::to_string(&out_dir.display().to_string()).unwrap();
        fs::write(&pi, format!(r#"#!/usr/bin/env python3
import json
import os
import sys

COUNT_FILE = {count_file}
OUT_DIR = {out_dir_text}


def arg_value(name):
    try:
        return sys.argv[sys.argv.index(name) + 1]
    except (ValueError, IndexError):
        return ""


def next_output():
    count = 0
    if os.path.exists(COUNT_FILE):
        with open(COUNT_FILE, "r", encoding="utf-8") as handle:
            count = int(handle.read() or "0")
    count += 1
    with open(COUNT_FILE, "w", encoding="utf-8") as handle:
        handle.write(str(count))
    with open(os.path.join(OUT_DIR, f"{{count}}.txt"), "r", encoding="utf-8") as handle:
        return handle.read()


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


provider = arg_value("--provider")
model = arg_value("--model")
thinking = arg_value("--thinking")
session_id = arg_value("--session-id")
mode = arg_value("--mode")

if mode == "rpc":
    for line in sys.stdin:
        command = json.loads(line)
        command_id = command["id"]
        command_type = command["type"]
        if command_type == "set_auto_compaction":
            emit({{"type":"response","id":command_id,"command":command_type,"success":True}})
        elif command_type == "get_state":
            emit({{"type":"response","id":command_id,"command":command_type,"success":True,"data":{{"sessionId":session_id,"model":{{"provider":provider,"id":model}},"thinkingLevel":thinking,"autoCompactionEnabled":False}}}})
        elif command_type == "prompt":
            content = next_output()
            emit({{"type":"response","id":command_id,"command":command_type,"success":True}})
            emit({{"type":"agent_start"}})
            emit({{"type":"turn_start"}})
            emit({{"type":"message_start"}})
            emit({{"type":"message_end","message":{{"role":"assistant","provider":provider,"model":model,"stopReason":"stop","content":[{{"type":"text","text":content}}]}}}})
            emit({{"type":"turn_end"}})
            emit({{"type":"agent_end","willRetry":False}})
            emit({{"type":"agent_settled"}})
        elif command_type == "get_session_stats":
            emit({{"type":"response","id":command_id,"command":command_type,"success":True,"data":{{"contextUsage":{{"percent":10.0}}}}}})
        elif command_type in ("abort", "steer", "compact"):
            emit({{"type":"response","id":command_id,"command":command_type,"success":True}})
        else:
            emit({{"type":"response","id":command_id,"command":command_type,"success":False,"error":"unexpected command"}})
else:
    content = next_output()
    emit({{"type":"agent_end","willRetry":False,"messages":[{{"role":"assistant","content":content,"provider":provider,"model":model,"stopReason":"stop"}}]}})
"#)).unwrap();
        make_executable(&pi);
    }

    fn issue_planning(
        &self,
        role: &str,
        mode: &str,
        boundary: &str,
        prefix: Option<&str>,
        registry: Option<(String, String)>,
    ) -> runner::IssuedRunnerAction {
        self.issue_planning_with_assignment(
            role,
            mode,
            boundary,
            &format!("planning-ws-{role}-01"),
            prefix,
            registry,
        )
    }

    fn write_atom_registry(&self, atoms: &[(&str, &str)]) -> (String, String) {
        let path = self
            .root
            .join(".pi/autopilot/ws/planning/atom-registry.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let value = json!({
            "schema":"autopilot.planning_atom_registry.v1",
            "workstream":"ws",
            "authority_set_id":"auth",
            "producer_assignment_ids": atoms.iter().map(|(_, producer)| *producer).collect::<Vec<_>>(),
            "atoms": atoms.iter().map(|(id, producer)| json!({"id":id,"producer_assignment_id":producer,"kind":"work","text":"atom","sources":[anchor("task.md", "authority", "auth", "Do the work")]})).collect::<Vec<_>>()
        });
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        fs::write(&path, &bytes).unwrap();
        (path.display().to_string(), sha256_hex(&bytes))
    }

    fn write_manifest(&self, assignments: &[(&str, &str, Option<&str>)]) {
        fs::create_dir_all(self.root.join(".pi/autopilot/ws")).unwrap();
        let authority = runner_doc_json("task.md", "authority", "auth", "Do the work");
        let context = runner_doc_json(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        let rows = assignments.iter().enumerate().map(|(index, (id, role, prefix))| {
            let (mode, boundary_id) = match *role {
                "task-extractor" => ("inventory", "planning.task-atoms.v1"),
                "repository-scout" => ("initial-grounding", "planning.scout-dossier.v1"),
                other => panic!("unsupported manifest role in fixture: {other}"),
            };
            json!({"assignment_id":id,"role":role,"mode":mode,"boundary_id":boundary_id,"ordinal":index + 1,"atom_id_prefix":prefix})
        }).collect::<Vec<_>>();
        let mut waves = vec![
            json!({"id":"P1.extract","role":"task-extractor","dependencies":[],"ordinals":null,"activation_ref":null,"canonical_output":false}),
        ];
        if assignments
            .iter()
            .any(|(_, role, _)| *role == "repository-scout")
        {
            waves.push(json!({"id":"P2.scout","role":"repository-scout","dependencies":["P1.extract"],"ordinals":null,"activation_ref":null,"canonical_output":false}));
        }
        fs::write(self.root.join(".pi/autopilot/ws/planning-manifest.json"), serde_json::to_vec_pretty(&json!({"workstream":"ws","authority_set_id":"auth","authority_documents":[authority],"context_documents":[context],"context_document":context,"assignments":rows,"planning_wave_cap":7,"planning_max_attempts":2,"planning_waves":waves})).unwrap()).unwrap();
    }

    fn seed_planning_binding(
        &self,
        state: &mut CoreState,
        role: &str,
        mode: &str,
        boundary: &str,
        assignment_id: &str,
        prefix: Option<&str>,
        registry: Option<(String, String)>,
        raw: String,
    ) -> runner::IssuedRunnerBinding {
        let issue = self.issue_planning_with_assignment(
            role,
            mode,
            boundary,
            assignment_id,
            prefix,
            registry,
        );
        self.overwrite_carrier_raw(&issue.binding, raw);
        self.append_ref(state, &runner::binding_ref(&issue.binding).unwrap());
        self.append_ref(state, &Ref(assignment_id.to_owned()));
        issue.binding
    }

    fn issue_planning_with_assignment(
        &self,
        role: &str,
        mode: &str,
        boundary: &str,
        assignment_id: &str,
        prefix: Option<&str>,
        registry: Option<(String, String)>,
    ) -> runner::IssuedRunnerAction {
        self.issue_planning_with_assignment_revision(
            role,
            mode,
            boundary,
            assignment_id,
            prefix,
            registry,
            1,
        )
    }

    fn issue_planning_with_assignment_revision(
        &self,
        role: &str,
        mode: &str,
        boundary: &str,
        assignment_id: &str,
        prefix: Option<&str>,
        registry: Option<(String, String)>,
        run_revision: u64,
    ) -> runner::IssuedRunnerAction {
        let (registry_path, registry_digest) = match registry {
            Some((p, d)) => (Some(p), Some(d)),
            None => (None, None),
        };
        let context_document = runner_doc(
            "context.md",
            "context/non-authority",
            "auth",
            "Repo context",
        );
        let request = PlanningRunnerRequest {
            workstream: "ws".to_owned(),
            action_id: Id(format!("action-{assignment_id}")),
            assignment_id: Id(assignment_id.to_owned()),
            role_id: Id(role.to_owned()),
            mode: ModeId(mode.to_owned()),
            boundary_id: ContractId(boundary.to_owned()),
            run_revision,
            authority_set_id: "auth".to_owned(),
            authority_documents: vec![runner_doc("task.md", "authority", "auth", "Do the work")],
            context_document: context_document.clone(),
            context_documents: vec![context_document],
            mode_parameter: first_mode_parameter_for(role),
            atom_id_prefix: prefix.map(str::to_owned),
            atom_registry_path: registry_path,
            atom_registry_digest: registry_digest,
        };
        runner::planning_issue(&request).unwrap()
    }

    fn overwrite_carrier_raw(&self, binding: &runner::IssuedRunnerBinding, raw: String) {
        fs::create_dir_all(Path::new(&binding.carrier_path).parent().unwrap()).unwrap();
        fs::write(
            &binding.carrier_path,
            serde_json::to_vec_pretty(&carrier_value(binding, &raw)).unwrap(),
        )
        .unwrap();
    }

    fn agent_response(
        &self,
        state: &mut CoreState,
        binding: &runner::IssuedRunnerBinding,
        raw: String,
    ) -> SeamEnvelope {
        let carrier = carrier_value(binding, &raw);
        let frame = json!({"v":1,"id":1,"kind":"agent-result","payload":{"assignment_id":binding.assignment_id,"carrier":carrier}});
        seam::handle_line(&frame.to_string(), state).unwrap()
    }

    fn agent_response_from_spec(
        &self,
        state: &mut CoreState,
        spec_path: &Path,
        raw: String,
    ) -> SeamEnvelope {
        let carrier = carrier_value_from_spec(spec_path, &raw);
        let carrier_path = carrier
            .get("carrier_path")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        fs::create_dir_all(Path::new(carrier_path).parent().unwrap()).unwrap();
        fs::write(carrier_path, serde_json::to_vec_pretty(&carrier).unwrap()).unwrap();
        let assignment_id = carrier
            .get("assignment_id")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        let frame = json!({"v":1,"id":1,"kind":"agent-result","payload":{"assignment_id":assignment_id,"carrier":carrier}});
        seam::handle_line(&frame.to_string(), state).unwrap()
    }

    fn planning_spec_path(&self, assignment_id: &str) -> PathBuf {
        self.root
            .join(".pi/autopilot/ws/planning/specs")
            .join(format!("{assignment_id}.json"))
    }

    fn agent_result(
        &self,
        state: &mut CoreState,
        binding: &runner::IssuedRunnerBinding,
        raw: String,
    ) -> String {
        let response = self.agent_response(state, binding, raw);
        response_status(&response)
    }

    fn append_ref(&self, state: &mut CoreState, reference: &Ref) {
        let frame = json!({"v":1,"id":1,"kind":"command","payload":{"raw":format!("append:test:{}", reference.0),"background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true},"background_capability_diagnostic":null}});
        let response = seam::handle_line(&frame.to_string(), state).unwrap();
        let status = response
            .payload
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or_else(|| panic!("non-status response: {response:?}"));
        assert!(
            status.contains("state:sequence"),
            "append ref failed: {status}"
        );
    }

    fn attempt_event_path(&self, binding: &runner::IssuedRunnerBinding) -> PathBuf {
        let spec: serde_json::Value =
            serde_json::from_slice(&fs::read(&binding.spec_path).unwrap()).unwrap();
        let cwd = spec.get("cwd").and_then(serde_json::Value::as_str).unwrap();
        let assignment_id = spec
            .get("assignment_id")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        Path::new(cwd)
            .join(".pi/autopilot/runner/attempt-events")
            .join(format!("{assignment_id}.jsonl"))
    }

    fn read_attempt_events(&self, binding: &runner::IssuedRunnerBinding) -> Vec<serde_json::Value> {
        let path = self.attempt_event_path(binding);
        fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("attempt events missing at {}: {error}", path.display()))
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

fn response_status(response: &SeamEnvelope) -> String {
    response
        .payload
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or_else(|| panic!("non-status response: {response:?}"))
        .to_owned()
}

fn assert_spawn_assignment(response: &SeamEnvelope, assignment_id: &str) {
    assert_eq!(
        response.kind, "spawn",
        "expected spawn response: {response:?}"
    );
    assert_eq!(
        response
            .payload
            .get("action")
            .and_then(|action| action.get("assignment_id"))
            .and_then(serde_json::Value::as_str),
        Some(assignment_id),
        "spawn should launch the next planning assignment: {response:?}"
    );
}

fn has_attempt_event(events: &[serde_json::Value], event: &str) -> bool {
    events
        .iter()
        .any(|row| row.get("event").and_then(serde_json::Value::as_str) == Some(event))
}

fn carrier_raw_output(binding: &runner::IssuedRunnerBinding) -> String {
    let carrier: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding.carrier_path).unwrap()).unwrap();
    carrier
        .get("raw_output")
        .and_then(serde_json::Value::as_str)
        .unwrap()
        .to_owned()
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

fn carrier_value(binding: &runner::IssuedRunnerBinding, raw: &str) -> serde_json::Value {
    json!({
        "schema":"autopilot.planning_carrier.v1",
        "action_id":binding.action_id.0,
        "assignment_id":binding.assignment_id.0,
        "run_revision":binding.run_revision,
        "workstream":binding.workstream.0,
        "role_id":binding.role_id.0,
        "mode":binding.mode.0,
        "boundary_id":binding.boundary_id.0,
        "result_contract":binding.result_contract.0,
        "prompt_path":binding.prompt_path,
        "prompt_digest":binding.prompt_digest,
        "boundary_digest":binding.boundary_digest,
        "result_contract_digest":binding.result_contract_digest,
        "settings_digest":binding.settings_digest,
        "context_digest":binding.context_digest,
        "skills_digest":binding.skills_digest,
        "subscription_digest":binding.subscription_digest,
        "spec_digest":binding.spec_digest,
        "spec_path":binding.spec_path,
        "carrier_path":binding.carrier_path,
        "raw_output":raw,
    })
}

fn task_atoms(id: &str) -> String {
    json!({"atoms":[{"id":id,"kind":"work","text":"Do the work","sources":[anchor("task.md", "authority", "auth", "Do the work")]}]}).to_string()
}

fn atoms_with_source(source: &str) -> TaskAtoms {
    TaskAtoms {
        atoms: vec![TaskAtom {
            id: Id("TE01-W1".to_owned()),
            kind: PlanningAtomKind::Work,
            text: "Do the work".to_owned(),
            sources: vec![Ref(source.to_owned())],
        }],
    }
}

fn assert_source_rejected(registry: &TaskAnchorRegistry, source: &str) {
    let rejection =
        planning::validate_task_atoms_for_assignment(&atoms_with_source(source), "TE01-", registry)
            .expect_err("unverified source must reject");
    assert_eq!(rejection.boundary_id(), "planning.task-atoms.v1");
    assert!(
        rejection.actual().contains("field=atoms.sources"),
        "rejection must name atoms.sources: {}",
        rejection.actual()
    );
    assert!(
        rejection.actual().contains(&format!("got={source}")),
        "rejection must name offending source: {}",
        rejection.actual()
    );
}

fn task_input_set(documents: &[TaskDocument]) -> TaskInputSet {
    TaskInputSet {
        authority_set_id: "auth".to_owned(),
        authority_documents: documents
            .iter()
            .filter(|document| document.class == TaskDocumentClass::Authority)
            .cloned()
            .collect(),
        context_documents: documents
            .iter()
            .filter(|document| document.class == TaskDocumentClass::ContextNonAuthority)
            .cloned()
            .collect(),
    }
}

fn planning_doc(path: &str, class: TaskDocumentClass, body: &str) -> TaskDocument {
    TaskDocument {
        id: path.to_owned(),
        path: path.to_owned(),
        class,
        authority_set_id: "auth".to_owned(),
        body: body.to_owned(),
        digest: sha256_hex(body.as_bytes()),
    }
}

fn work_map(links: &[&str]) -> String {
    json!({"units":[{"id":"U1","objective":"Implement unit","criteria":["done"],"links":links}]})
        .to_string()
}

fn scout_dossier() -> String {
    json!({"findings":[{"path":"Cargo.toml","observation":"exists","evidence_ref":"repo://Cargo.toml"}]}).to_string()
}

fn plan_review() -> String {
    json!({"verdicts":[{"criterion_id":"AC-U1-1","verdict":"pass"}]}).to_string()
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

/// Derive the lens the package itself would bind for the first assignment of `role`.
/// Uses the real allocator so this fixture can never drift from production behavior.
fn first_mode_parameter_for(role: &str) -> Option<String> {
    let roles = drivers::roles::RoleRegistry::package().expect("role registry");
    let role = roles.get(role).expect("role is registered");
    drivers::roles::allocate_mode_parameters(role, role.mode_parameters.len().max(1))
        .expect("mode parameter allocation")
        .first()
        .cloned()
        .flatten()
}
