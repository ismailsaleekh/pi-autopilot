#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use drivers::vcs::GitVcs;
use kernel::generated::{
    CoreToHostDonePayload, CoreToHostSpawnPayload, CoreToHostUiPayload, EventRow, SeamEnvelope,
};
use sha2::{Digest as ShaDigest, Sha256};

#[test]
fn all_public_commands_reach_driver_surfaces() {
    let root = temp_dir("public-routes");
    let repo = root.join("repo");
    let vcs = GitVcs::new(&root);
    vcs.init_fixture(&repo).expect("fixture repo");
    let task_paths = write_task_pack(&repo, "set-command-routing");
    vcs.stage_all(&repo).expect("stage task");
    vcs.snapshot(&repo, "task file").expect("task commit");
    let event_log = root.join("events.jsonl");

    let plan_raw = format!("autopilot-plan main {}", task_paths.join(" "));
    let plan = send_with_log(&plan_raw, &event_log, Some(&repo));
    assert_eq!(plan.kind, "spawn");
    let plan_spawn: CoreToHostSpawnPayload =
        serde_json::from_value(plan.payload).expect("plan spawn payload");
    assert!(plan_spawn.action.bg_run.command.0.contains(" --spec "));
    assert!(
        !plan_spawn
            .action
            .bg_run
            .command
            .0
            .contains("autopilot-agent-run --assignment")
    );

    let ready = complete_planning_until_ready(plan_spawn, &event_log, &repo);
    assert!(done_status(&ready).contains("ready-to-execute:workstream=main"));
    assert!(
        fs::read_to_string(repo.join(".pi/autopilot/main/approved-plan.json"))
            .expect("approved plan")
            .contains("U1")
    );

    let run = send_with_log("autopilot main", &event_log, Some(&repo));
    assert_eq!(run.kind, "spawn", "run response: {:?}", run);
    let spawn_payload: CoreToHostSpawnPayload =
        serde_json::from_value(run.payload).expect("spawn payload");
    assert!(spawn_payload.action.bg_run.command.0.contains(" --spec "));
    assert!(spawn_payload.action.assignment_id.0.contains("main"));
    let task_binding = serde_json::json!({
        "task_id": "task-command-routing",
        "action_id": &spawn_payload.action.action_id.0,
        "assignment_id": &spawn_payload.action.assignment_id.0,
    });
    let appended = send_with_log(
        &format!("append:handoff-fixture:task-binding:{task_binding}"),
        &event_log,
        Some(&repo),
    );
    assert!(done_status(&appended).contains("state:sequence="));
    let appended = send_with_log(
        "append:final-precondition:unit-closed:main",
        &event_log,
        Some(&repo),
    );
    assert!(done_status(&appended).contains("state:sequence="));

    let status = send_once("autopilot-status", None);
    assert!(done_status(&status).contains("state:sequence=0;revision=0"));

    let abort_root = temp_dir("abort-route");
    let abort = send_once("autopilot-abort main", Some(&abort_root));
    assert!(done_status(&abort).contains("lifecycle:abort:archive="));
    assert_eq!(
        fs::read_to_string(abort_root.join(".pi/autopilot/archive/main/run-1/outcome.txt"))
            .expect("abort outcome"),
        "aborted"
    );

    let config = send_once("autopilot-config show", None);
    assert_eq!(config.kind, "ui");
    let config_payload: CoreToHostUiPayload =
        serde_json::from_value(config.payload).expect("config ui");
    assert_eq!(config_payload.content["driver"], "roster-config");
    assert!(
        config_payload.content["slots"]
            .as_u64()
            .expect("slot count")
            > 0
    );

    let handoff = send_with_log("autopilot-handoff", &event_log, Some(&repo));
    let handoff_payload: CoreToHostUiPayload =
        serde_json::from_value(handoff.payload).expect("handoff ui");
    assert_eq!(handoff_payload.content["driver"], "handoff");
    assert_eq!(handoff_payload.content["actions"], 4);

    let terminal_ref = format!(
        "terminal-consumed:{}:{}:{}",
        spawn_payload.action.action_id.0,
        spawn_payload.action.assignment_id.0,
        spawn_payload.action.run_revision
    );
    let appended = send_with_log(
        &format!("append:final-precondition:{terminal_ref}"),
        &event_log,
        Some(&repo),
    );
    assert!(done_status(&appended).contains("state:sequence="));

    let head = git_stdout(&repo, &["rev-parse", "--verify", "HEAD"]);
    let tree = git_stdout(&repo, &["rev-parse", "--verify", "HEAD^{tree}"]);
    let close = send_with_log(
        &format!(
            "autopilot-close main --run run-1 --expected-revision 0 --expected-event-tip sha256:{} --expected-tip {} --expected-tree {} --expected-final-digest sha256:{}",
            "0".repeat(64),
            head.trim(),
            tree.trim(),
            "1".repeat(64)
        ),
        &event_log,
        Some(&repo),
    );
    let close_status = done_status(&close);
    assert!(
        close_status.contains("rejection:lifecycle-close:FinalGateFailed:final-commands-exact-tip"),
        "unexpected close status: {close_status}"
    );
    assert!(
        !Command::new("git")
            .current_dir(&repo)
            .args(["rev-parse", "--verify", "refs/autopilot/results/main/run-1"])
            .stdout(Stdio::null())
            .status()
            .expect("git rev-parse")
            .success()
    );

    let inject = send_once("autopilot-inject main", None);
    assert!(done_status(&inject).contains("attach:workstream=main;state:sequence=1;revision=1"));

    let onboard = send_once("autopilot-onboard make this task concrete", None);
    let onboard_payload: CoreToHostUiPayload =
        serde_json::from_value(onboard.payload).expect("onboard ui");
    assert_eq!(onboard_payload.content["driver"], "planning-onboard");
    assert_eq!(onboard_payload.content["atoms"], 1);
}

#[test]
fn malformed_public_commands_are_typed_and_helpful() {
    let cases = [
        (
            "autopilot-plan main",
            "/autopilot-plan <workstream> <task-paths...>",
        ),
        ("autopilot", "/autopilot <workstream>"),
        ("autopilot-status extra", "/autopilot-status"),
        (
            "autopilot-close main",
            "/autopilot-close <workstream> --run <run-id> --expected-revision <u64> --expected-event-tip <sha256:...> --expected-tip <git-oid> --expected-tree <git-oid> --expected-final-digest <sha256:...>",
        ),
        ("autopilot-abort", "/autopilot-abort <workstream>"),
        (
            "autopilot-config",
            "/autopilot-config show OR /autopilot-config parallel-cap <n>",
        ),
        ("autopilot-handoff extra", "/autopilot-handoff"),
        ("autopilot-inject", "/autopilot-inject <workstream>"),
        ("autopilot-onboard", "/autopilot-onboard <request...>"),
    ];
    for (raw, expected) in cases {
        let status = done_status(&send_once(raw, None));
        assert!(
            status.contains("rejection:seam.operator-command.v1:expected="),
            "{status}"
        );
        assert!(status.contains(expected), "{status}");
        assert!(status.contains("actual="), "{status}");
    }
}

#[test]
fn unknown_command_lists_valid_commands() {
    let status = done_status(&send_once("not-a-command main", None));
    assert!(status.contains("rejection:seam.operator-command.v1"));
    assert!(status.contains("unknown-command:not-a-command"));
    assert!(status.contains("/autopilot-plan"));
    assert!(status.contains("/autopilot-abort"));
}

#[test]
fn legacy_test_verbs_still_work() {
    let root = temp_dir("legacy-routes");
    let event_log = root.join("events.jsonl");
    let state = send_with_log("state", &event_log, None);
    assert!(done_status(&state).contains("state:sequence=0;revision=0"));

    let append = send_with_log("append:test-kind:test-ref", &event_log, None);
    assert!(done_status(&append).contains("state:sequence=1;revision=1"));
    let event: EventRow = serde_json::from_str(&fs::read_to_string(&event_log).expect("event log"))
        .expect("event row");
    assert_eq!(event.kind.0, "test-kind");
    assert_eq!(event.artifact_refs[0].0, "test-ref");

    let mut child = spawn_core(&event_log, None);
    writeln!(
        child.stdin.as_mut().expect("stdin"),
        "{}",
        frame_json(9, "crash-window:test-kind:test-ref")
    )
    .expect("write crash-window");
    let mut stderr = BufReader::new(child.stderr.take().expect("stderr"));
    let mut line = String::new();
    stderr.read_line(&mut line).expect("crash diagnostic");
    assert!(line.contains("crash-window-ready"));
    child.kill().expect("kill crash-window core");
    child.wait().expect("wait crash-window core");
}

fn send_once(raw: &str, cwd: Option<&Path>) -> SeamEnvelope {
    send_with_log(raw, &temp_dir("route-event-log").join("events.jsonl"), cwd)
}

fn send_with_log(raw: &str, event_log: &Path, cwd: Option<&Path>) -> SeamEnvelope {
    send_frame(frame_json(1, raw), event_log, cwd)
}

fn complete_planning_until_ready(
    mut spawn_payload: CoreToHostSpawnPayload,
    event_log: &Path,
    cwd: &Path,
) -> SeamEnvelope {
    for step in 0..40 {
        let response = send_agent_carrier(&spawn_payload, event_log, cwd, step + 2);
        if response.kind == "done" {
            return response;
        }
        assert_eq!(
            response.kind, "spawn",
            "planning step response: {:?}",
            response
        );
        spawn_payload = serde_json::from_value(response.payload).expect("next planning spawn");
    }
    panic!("planning did not become ready");
}

fn send_agent_carrier(
    spawn_payload: &CoreToHostSpawnPayload,
    event_log: &Path,
    cwd: &Path,
    id: u64,
) -> SeamEnvelope {
    let cwd = fs::canonicalize(cwd).expect("canonical cwd");
    let assignment_id = &spawn_payload.action.assignment_id.0;
    let spec_path = cwd
        .join(".pi/autopilot/main/planning/specs")
        .join(format!("{assignment_id}.json"));
    let spec_text = fs::read_to_string(&spec_path).expect("planning spec");
    let spec: serde_json::Value = serde_json::from_str(&spec_text).expect("planning spec json");
    let boundary_id = spec["boundary_id"].as_str().expect("boundary");
    let raw_output = planning_output(boundary_id);
    let carrier_path = cwd
        .join(".pi/autopilot/main/planning/carriers")
        .join(format!("{assignment_id}.json"));
    let carrier = serde_json::json!({
        "schema":"autopilot.planning_carrier.v1",
        "action_id":spawn_payload.action.action_id.0,
        "assignment_id":assignment_id,
        "run_revision":spawn_payload.action.run_revision,
        "workstream":"main",
        "role_id":spec["role_id"],
        "mode":spec["mode"],
        "boundary_id":boundary_id,
        "result_contract":spec["result_contract"],
        "prompt_path":spec["prompt_path"],
        "prompt_digest":spec["prompt_digest"],
        "boundary_digest":spec["boundary_digest"],
        "result_contract_digest":spec["result_contract_digest"],
        "settings_digest":spec["settings_digest"],
        "context_digest":spec["context_digest"],
        "skills_digest":spec["skills_digest"],
        "subscription_digest":spec["subscription_digest"],
        "spec_digest":sha256_hex(spec_text.as_bytes()),
        "spec_path":spec_path,
        "carrier_path":carrier_path,
        "raw_output":raw_output
    });
    send_frame(
        serde_json::json!({"v":1,"id":id,"kind":"agent-result","payload":{"assignment_id":assignment_id,"carrier":carrier}}),
        event_log,
        Some(&cwd),
    )
}

fn planning_output(boundary_id: &str) -> String {
    match boundary_id {
        "planning.task-atoms.v1" => "atom: command routing".to_owned(),
        "planning.scout-dossier.v1" => "evidence: command routing".to_owned(),
        "planning.work-map.v1" => transcript("planning.work-map.v1"),
        "planning.plan-review.v1" => transcript("planning.plan-review.v1"),
        "planning.questions.v1" => "questions: []".to_owned(),
        other => panic!("unexpected planning boundary {other}"),
    }
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn send_frame(frame: serde_json::Value, event_log: &Path, cwd: Option<&Path>) -> SeamEnvelope {
    let mut child = spawn_core(event_log, cwd);
    writeln!(child.stdin.as_mut().expect("stdin"), "{}", frame).expect("write frame");
    drop(child.stdin.take());
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));
    let mut line = String::new();
    stdout.read_line(&mut line).expect("response line");
    let mut stderr_text = String::new();
    child
        .stderr
        .take()
        .expect("stderr")
        .read_to_string(&mut stderr_text)
        .expect("stderr read");
    child.wait().expect("core exit");
    assert!(
        !line.trim().is_empty(),
        "core produced no stdout; stderr={stderr_text}"
    );
    serde_json::from_str(&line).unwrap_or_else(|error| {
        panic!("response envelope: {error}; stdout={line:?}; stderr={stderr_text}")
    })
}

fn spawn_core(event_log: &Path, cwd: Option<&Path>) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_autopilot-core"));
    let exe = std::env::current_exe().expect("current exe");
    command
        .env("AUTOPILOT_CORE_EVENT_LOG", event_log)
        .env("AUTOPILOT_NODE_EXECUTABLE", &exe)
        .env("AUTOPILOT_AGENT_RUNNER_WRAPPER", &exe)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = cwd {
        command.current_dir(path);
    }
    command.spawn().expect("spawn autopilot-core")
}

fn frame_json(id: u64, raw: &str) -> serde_json::Value {
    serde_json::json!({"v":1,"id":id,"kind":"command","payload":{"raw":raw,"background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true}}})
}

fn transcript(boundary_id: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/transcripts")
        .join(boundary_id)
        .join("transcripts.json");
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).expect("transcript file"))
            .expect("transcript json");
    value["records"][0]["raw_output"]
        .as_str()
        .expect("raw output")
        .to_owned()
}

fn done_status(envelope: &SeamEnvelope) -> String {
    assert_eq!(envelope.kind, "done");
    let payload: CoreToHostDonePayload =
        serde_json::from_value(envelope.payload.clone()).expect("done payload");
    payload.status
}

fn write_task_pack(repo: &Path, authority_set_id: &str) -> Vec<String> {
    let entries = [
        ("TASK-A.md", "[authority]", "Mission A\n"),
        ("TASK-B.md", "[authority]", "Mission B\n"),
        ("TASK-C.md", "[authority]", "Mission C\n"),
        (
            "CONTEXT.md",
            "[context/non-authority]",
            "context sentinel only\n",
        ),
    ];
    entries
        .iter()
        .map(|(name, marker, body)| {
            fs::write(
                repo.join(name),
                format!("{marker}\nauthority_set_id: {authority_set_id}\n\n{body}"),
            )
            .expect("task pack file");
            (*name).to_owned()
        })
        .collect()
}

fn git_stdout(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .expect("git command");
    assert!(output.status.success(), "git {:?} failed", args);
    String::from_utf8(output.stdout).expect("git stdout")
}

fn temp_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("autopilot-command-routing-{name}-{nanos}"));
    fs::create_dir_all(&path).expect("temp dir");
    fs::canonicalize(path).expect("canonical temp dir")
}
