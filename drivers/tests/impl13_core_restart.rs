#![allow(clippy::disallowed_types)]

use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use kernel::generated::{CoreToHostDonePayload, CoreToHostSpawnWavePayload, SeamEnvelope};

static TEMP_REPO_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn release_core_reemits_unacknowledged_planning_wave_after_restart() {
    let repo = temp_repo("impl13-preack-restart");
    let event_log = repo.join("events.jsonl");
    write_task_pack(&repo, "impl13-auth");
    fs::write(repo.join(".gitignore"), "events.jsonl\n").expect("write event-log ignore");
    git(&repo, &["init"]);
    git(&repo, &["config", "user.email", "impl13@example.invalid"]);
    git(&repo, &["config", "user.name", "Impl 13"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "seed"]);

    let raw = "/autopilot-plan main TASK-A.md TASK-B.md TASK-C.md CONTEXT.md";
    let first = send_command(raw, &event_log, &repo, 1);
    assert_eq!(first.kind, "spawn-wave", "first response: {first:?}");
    let first_wave = spawn_wave_payload(&first);
    assert_machine_only_completion(&first_wave);
    assert_eq!(
        first_wave.actions.len(),
        7,
        "fixture must launch the full P1 wave before any acks"
    );
    let first_actions = action_keys(&first_wave);
    let event_log_before_replay = fs::read_to_string(&event_log).expect("event log before replay");

    let replay = send_command(raw, &event_log, &repo, 2);
    assert_eq!(
        replay.kind,
        "spawn-wave",
        "restart without spawn-result acks must re-emit the exact unacknowledged wave, not return {:?}",
        done_status(&replay)
    );
    let replay_wave = spawn_wave_payload(&replay);
    assert_machine_only_completion(&replay_wave);
    assert_eq!(
        action_keys(&replay_wave),
        first_actions,
        "replay must re-emit existing actions, not issue duplicate bindings"
    );
    assert_eq!(
        fs::read_to_string(&event_log).expect("event log after replay"),
        event_log_before_replay,
        "re-emitting the pre-ack wave must not append duplicate bindings or control actions"
    );
}

fn send_command(raw: &str, event_log: &Path, cwd: &Path, id: u64) -> SeamEnvelope {
    let mut child = spawn_core(event_log, cwd);
    writeln!(
        child.stdin.as_mut().expect("stdin"),
        "{}",
        command_frame(id, raw)
    )
    .expect("write command frame");
    drop(child.stdin.take());
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));
    let mut line = String::new();
    stdout.read_line(&mut line).expect("read stdout line");
    let mut stderr_text = String::new();
    child
        .stderr
        .take()
        .expect("stderr")
        .read_to_string(&mut stderr_text)
        .expect("read stderr");
    let status = child.wait().expect("wait core");
    assert!(
        status.success(),
        "core exited {status}; stderr={stderr_text}"
    );
    assert!(
        !line.trim().is_empty(),
        "core produced no stdout; stderr={stderr_text}"
    );
    serde_json::from_str(&line).unwrap_or_else(|error| {
        panic!("core stdout was not JSON: {error}; line={line:?}; stderr={stderr_text}")
    })
}

fn spawn_core(event_log: &Path, cwd: &Path) -> Child {
    let exe = release_core_path();
    let wrapper = std::env::current_exe().expect("current test exe");
    Command::new(&exe)
        .env("AUTOPILOT_CORE_EVENT_LOG", event_log)
        .env("AUTOPILOT_NODE_EXECUTABLE", &wrapper)
        .env("AUTOPILOT_AGENT_RUNNER_WRAPPER", &wrapper)
        .env(
            "AUTOPILOT_CHILD_ADDON_PATH",
            Path::new(env!("CARGO_MANIFEST_DIR")).join(concat!(
                "../src/generated/child-",
                "ext",
                "ension.ts"
            )),
        )
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|error| panic!("spawn {}: {error}", exe.display()))
}

fn release_core_path() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .join("target/release/autopilot-core");
    assert!(
        path.exists(),
        "mandatory restart regression test requires real release binary at {}; build it with `cargo build --release -p drivers --bin autopilot-core` before running this test",
        path.display()
    );
    path
}

fn command_frame(id: u64, raw: &str) -> serde_json::Value {
    serde_json::json!({
        "v": 1,
        "id": id,
        "kind": "command",
        "payload": {
            "raw": raw,
            "background_capabilities": {
                "api_version": 1,
                "run": true,
                "run_is_agent": true,
                "run_completion_trigger": true,
                "status": true,
                "logs": true,
                "logs_bounded": true,
                "kill": true
            }
        }
    })
}

fn spawn_wave_payload(envelope: &SeamEnvelope) -> CoreToHostSpawnWavePayload {
    serde_json::from_value(envelope.payload.clone()).expect("spawn-wave payload")
}

fn done_status(envelope: &SeamEnvelope) -> Option<String> {
    (envelope.kind == "done").then(|| {
        serde_json::from_value::<CoreToHostDonePayload>(envelope.payload.clone())
            .expect("done payload")
            .status
    })
}

fn assert_machine_only_completion(wave: &CoreToHostSpawnWavePayload) {
    assert!(
        wave.actions
            .iter()
            .all(|action| action.bg_run.notify_on_completion)
    );
    assert!(
        wave.actions
            .iter()
            .all(|action| !action.bg_run.trigger_on_completion)
    );
}

fn action_keys(wave: &CoreToHostSpawnWavePayload) -> Vec<(String, String, u64)> {
    wave.actions
        .iter()
        .map(|action| {
            (
                action.assignment_id.0.clone(),
                action.action_id.0.clone(),
                action.run_revision,
            )
        })
        .collect()
}

fn write_task_pack(repo: &Path, authority_set_id: &str) {
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
    for (name, marker, body) in entries {
        fs::write(
            repo.join(name),
            format!("{marker}\nauthority_set_id: {authority_set_id}\n\n{body}"),
        )
        .expect("write task pack file");
    }
}

fn temp_repo(prefix: &str) -> PathBuf {
    let parent = std::env::temp_dir();
    let pid = std::process::id();
    loop {
        let nonce = TEMP_REPO_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!("{prefix}-{pid}-{nonce}"));
        match fs::create_dir(&path) {
            Ok(()) => return path,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("temp repo dir {path:?}: {error}"),
        }
    }
}

fn git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .expect("git command");
    assert!(
        output.status.success(),
        "git {:?} failed: stdout={} stderr={}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
