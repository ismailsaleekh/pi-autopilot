#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use kernel::generated::{CoreToHostDonePayload, EventRow, SeamEnvelope};
use kernel::state::{State, apply};

#[test]
fn core_crash_resumes_by_replaying_events() {
    let event_log = temp_path("events.jsonl");
    let mut child = spawn_core(&event_log);
    send(
        child.stdin.as_mut().expect("child stdin present"),
        1,
        "crash-window",
    );
    let mut stderr = BufReader::new(child.stderr.take().expect("child stderr present"));
    let mut diagnostic = String::new();
    stderr
        .read_line(&mut diagnostic)
        .expect("core writes crash-window diagnostic");
    assert!(diagnostic.contains("crash-window-ready"));
    let pre_crash = replay(&event_log);

    child.kill().expect("kill core");
    child.wait().expect("wait for killed core");

    let mut resumed = spawn_core(&event_log);
    send(
        resumed.stdin.as_mut().expect("child stdin present"),
        2,
        "state",
    );
    let mut stdout = BufReader::new(resumed.stdout.take().expect("child stdout present"));
    let mut line = String::new();
    stdout.read_line(&mut line).expect("state response");
    let status = done_status(&line);
    assert_eq!(status, summary(&pre_crash));

    resumed.kill().expect("stop resumed core");
    resumed.wait().expect("wait for resumed core");
}

#[test]
fn unknown_frame_is_typed_rejection() {
    let event_log = temp_path("unknown-events.jsonl");
    let mut child = spawn_core(&event_log);
    let frame = serde_json::json!({
        "v": 1,
        "id": 7,
        "kind": "mystery",
        "payload": {}
    });
    writeln!(
        child.stdin.as_mut().expect("child stdin present"),
        "{}",
        frame
    )
    .expect("write unknown frame");
    let mut stdout = BufReader::new(child.stdout.take().expect("child stdout present"));
    let mut line = String::new();
    stdout.read_line(&mut line).expect("unknown response");
    let envelope: SeamEnvelope = serde_json::from_str(&line).expect("response envelope");
    assert_eq!(envelope.id, 7);
    assert_eq!(envelope.kind, "done");
    assert!(done_status(&line).contains("rejection:seam.host-frame.v1:unknown-kind:mystery"));

    child.kill().expect("stop core");
    child.wait().expect("wait for core");
}

#[test]
fn command_parser_rejects_unknown_verb_and_missing_delimiter() {
    let event_log = temp_path("command-rejections.jsonl");
    let mut child = spawn_core(&event_log);
    let mut stdout = BufReader::new(child.stdout.take().expect("child stdout present"));

    send(
        child.stdin.as_mut().expect("child stdin present"),
        8,
        "bogus:test-kind:test-ref",
    );
    let mut unknown_line = String::new();
    stdout
        .read_line(&mut unknown_line)
        .expect("unknown command response");
    assert_eq!(
        done_status(&unknown_line),
        "rejection:seam.operator-command.v1:expected=Valid invocations are exactly: /autopilot-plan <workstream> <task-paths...>; /autopilot <workstream>; /autopilot-status; /autopilot-close <workstream>; /autopilot-abort <workstream>; /autopilot-config show; /autopilot-config parallel-cap <n>; /autopilot-handoff; /autopilot-inject <workstream>; /autopilot-onboard <request...>.;actual=unknown-command:bogus:test-kind:test-ref;valid=/autopilot-plan, /autopilot, /autopilot-status, /autopilot-close, /autopilot-abort, /autopilot-config, /autopilot-handoff, /autopilot-inject, /autopilot-onboard"
    );

    send(
        child.stdin.as_mut().expect("child stdin present"),
        9,
        "append",
    );
    let mut malformed_line = String::new();
    stdout
        .read_line(&mut malformed_line)
        .expect("malformed command response");
    assert_eq!(
        done_status(&malformed_line),
        "rejection:malformed-command:append"
    );

    child.kill().expect("stop core");
    child.wait().expect("wait for core");
}

fn spawn_core(event_log: &Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_autopilot-core"))
        .env("AUTOPILOT_CORE_EVENT_LOG", event_log)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn autopilot-core")
}

fn send(stdin: &mut ChildStdin, id: u64, raw: &str) {
    let command = match raw {
        "crash-window" => "crash-window:test-kind:test-ref",
        other => other,
    };
    let frame = serde_json::json!({
        "v": 1,
        "id": id,
        "kind": "command",
        "payload": { "raw": command, "background_capabilities": { "api_version": 1, "run": true, "run_is_agent": true, "run_completion_trigger": true, "status": true, "logs": true, "logs_bounded": true, "kill": true } }
    });
    writeln!(stdin, "{}", frame).expect("write frame");
}

fn replay(path: &Path) -> State {
    let file = File::open(path).expect("event log exists");
    let reader = BufReader::new(file);
    let mut state = State::EMPTY;
    for line in reader.lines() {
        let line = line.expect("event line");
        let event: EventRow = serde_json::from_str(&line).expect("event row");
        state = apply(state, &event);
    }
    state
}

fn done_status(line: &str) -> String {
    let envelope: SeamEnvelope = serde_json::from_str(line).expect("done envelope");
    let payload: CoreToHostDonePayload =
        serde_json::from_value(envelope.payload).expect("done payload");
    payload.status
}

fn summary(state: &State) -> String {
    format!(
        "state:sequence={};revision={};hash={}",
        state.sequence,
        state.revision,
        state.state_hash().0
    )
}

fn temp_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("autopilot-core-{nanos}"));
    fs::create_dir_all(&dir).expect("temp dir");
    dir.join(name)
}
