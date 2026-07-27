#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use drivers::vcs::GitVcs;
use kernel::generated::{CoreToHostDonePayload, CoreToHostSpawnPayload, CoreToHostUiPayload, EventRow, SeamEnvelope};

#[test]
fn all_public_commands_reach_driver_surfaces() {
    let root = temp_dir("public-routes");
    let repo = root.join("repo");
    let vcs = GitVcs::new(&root);
    vcs.init_fixture(&repo).expect("fixture repo");
    let task = repo.join("TASK.md");
    fs::write(&task, "Mission\nDefinition of Done\n").expect("task file");
    vcs.stage_all(&repo).expect("stage task");
    vcs.snapshot(&repo, "task file").expect("task commit");
    let event_log = root.join("events.jsonl");

    let plan_raw = "autopilot-plan main ".to_owned() + task.to_str().expect("utf8 task");
    let plan = send_with_log(&plan_raw, &event_log, Some(&repo));
    assert_eq!(plan.kind, "spawn");
    let plan_spawn: CoreToHostSpawnPayload = serde_json::from_value(plan.payload).expect("plan spawn payload");
    assert!(plan_spawn.action.command_bytes.0.contains("autopilot-agent-run"));
    assert!(plan_spawn.action.command_bytes.0.contains("--role extractor"));

    let work_map = transcript("planning.work-map.v1");
    let accepted = send_agent_result("planning-main-compiler-01", "main", "planning.work-map.v1", &work_map, &event_log, &repo);
    assert_eq!(accepted.kind, "spawn");
    let review = transcript("planning.plan-review.v1");
    let ready = send_agent_result("planning-main-reviewer-01", "main", "planning.plan-review.v1", &review, &event_log, &repo);
    assert!(done_status(&ready).contains("ready-to-execute:workstream=main"));
    assert!(fs::read_to_string(repo.join(".pi/autopilot/main/approved-plan.json")).expect("approved plan").contains("U1"));

    let run = send_with_log("autopilot main", &event_log, Some(&repo));
    assert_eq!(run.kind, "spawn", "run response: {:?}", run);
    let spawn_payload: CoreToHostSpawnPayload = serde_json::from_value(run.payload).expect("spawn payload");
    assert!(spawn_payload.action.command_bytes.0.contains("autopilot-agent-run"));
    assert!(spawn_payload.action.assignment_id.0.contains("main"));

    let status = send_once("autopilot-status", None);
    assert!(done_status(&status).contains("state:sequence=0;revision=0"));

    let close = send_once("autopilot-close main", Some(&repo));
    assert!(done_status(&close).contains("lifecycle:close:refs/autopilot/results/main/run-1"));
    assert!(Command::new("git").current_dir(&repo).args(["rev-parse", "--verify", "refs/autopilot/results/main/run-1"]).stdout(Stdio::null()).status().expect("git rev-parse").success());

    let abort_root = temp_dir("abort-route");
    let abort = send_once("autopilot-abort main", Some(&abort_root));
    assert!(done_status(&abort).contains("lifecycle:abort:archive="));
    assert_eq!(fs::read_to_string(abort_root.join(".pi/autopilot/archive/main/run-1/outcome.txt")).expect("abort outcome"), "aborted");

    let config = send_once("autopilot-config show", None);
    assert_eq!(config.kind, "ui");
    let config_payload: CoreToHostUiPayload = serde_json::from_value(config.payload).expect("config ui");
    assert_eq!(config_payload.content["driver"], "roster-config");
    assert!(config_payload.content["slots"].as_u64().expect("slot count") > 0);

    let handoff = send_once("autopilot-handoff", None);
    let handoff_payload: CoreToHostUiPayload = serde_json::from_value(handoff.payload).expect("handoff ui");
    assert_eq!(handoff_payload.content["driver"], "handoff");
    assert_eq!(handoff_payload.content["actions"], 4);

    let inject = send_once("autopilot-inject main", None);
    assert!(done_status(&inject).contains("attach:workstream=main;state:sequence=1;revision=1"));

    let onboard = send_once("autopilot-onboard make this task concrete", None);
    let onboard_payload: CoreToHostUiPayload = serde_json::from_value(onboard.payload).expect("onboard ui");
    assert_eq!(onboard_payload.content["driver"], "planning-onboard");
    assert_eq!(onboard_payload.content["atoms"], 1);
}

#[test]
fn malformed_public_commands_are_typed_and_helpful() {
    let cases = [
        ("autopilot-plan main", "/autopilot-plan <workstream> <task-paths...>"),
        ("autopilot", "/autopilot <workstream>"),
        ("autopilot-status extra", "/autopilot-status"),
        ("autopilot-close", "/autopilot-close <workstream>"),
        ("autopilot-abort", "/autopilot-abort <workstream>"),
        ("autopilot-config", "/autopilot-config show OR /autopilot-config parallel-cap <n>"),
        ("autopilot-handoff extra", "/autopilot-handoff"),
        ("autopilot-inject", "/autopilot-inject <workstream>"),
        ("autopilot-onboard", "/autopilot-onboard <request...>"),
    ];
    for (raw, expected) in cases {
        let status = done_status(&send_once(raw, None));
        assert!(status.contains("rejection:seam.operator-command.v1:expected="), "{status}");
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
    let event: EventRow = serde_json::from_str(&fs::read_to_string(&event_log).expect("event log")).expect("event row");
    assert_eq!(event.kind.0, "test-kind");
    assert_eq!(event.artifact_refs[0].0, "test-ref");

    let mut child = spawn_core(&event_log, None);
    writeln!(child.stdin.as_mut().expect("stdin"), "{}", frame_json(9, "crash-window:test-kind:test-ref")).expect("write crash-window");
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

fn send_agent_result(assignment_id: &str, workstream: &str, boundary_id: &str, raw_output: &str, event_log: &Path, cwd: &Path) -> SeamEnvelope {
    send_frame(
        serde_json::json!({"v":1,"id":2,"kind":"agent-result","payload":{"assignment_id":assignment_id,"carrier":{"workstream":workstream,"boundary_id":boundary_id,"raw_output":raw_output}}}),
        event_log,
        Some(cwd),
    )
}

fn send_frame(frame: serde_json::Value, event_log: &Path, cwd: Option<&Path>) -> SeamEnvelope {
    let mut child = spawn_core(event_log, cwd);
    writeln!(child.stdin.as_mut().expect("stdin"), "{}", frame).expect("write frame");
    drop(child.stdin.take());
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));
    let mut line = String::new();
    stdout.read_line(&mut line).expect("response line");
    child.wait().expect("core exit");
    serde_json::from_str(&line).expect("response envelope")
}

fn spawn_core(event_log: &Path, cwd: Option<&Path>) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_autopilot-core"));
    command.env("AUTOPILOT_CORE_EVENT_LOG", event_log).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(path) = cwd { command.current_dir(path); }
    command.spawn().expect("spawn autopilot-core")
}

fn frame_json(id: u64, raw: &str) -> serde_json::Value {
    serde_json::json!({"v":1,"id":id,"kind":"command","payload":{"raw":raw}})
}

fn transcript(boundary_id: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/transcripts").join(boundary_id).join("transcripts.json");
    let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).expect("transcript file")).expect("transcript json");
    value["records"][0]["raw_output"].as_str().expect("raw output").to_owned()
}

fn done_status(envelope: &SeamEnvelope) -> String {
    assert_eq!(envelope.kind, "done");
    let payload: CoreToHostDonePayload = serde_json::from_value(envelope.payload.clone()).expect("done payload");
    payload.status
}

fn temp_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
    let path = std::env::temp_dir().join(format!("autopilot-command-routing-{name}-{nanos}"));
    fs::create_dir_all(&path).expect("temp dir");
    path
}
