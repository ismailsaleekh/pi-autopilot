#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use drivers::seam::{self, ClosureMode, CoreState, FinalSnapshot};

static CWD_LOCK: Mutex<()> = Mutex::new(());

/// A failing final verification command must be DIAGNOSABLE.
///
/// `run_final_verification_at_tip` previously used `Command::status()`, which inherits
/// stdio and captures nothing, then returned `Ok(false)`. The three required proofs were
/// simply not appended and the operator saw only
/// `FinalGateFailed:final-commands-exact-tip` — no indication of WHICH command failed,
/// its exit code, or any output. Since this runs at the very end of a long autonomous
/// run, that blindness is expensive.
///
/// The gate refusing to publish is CORRECT and must not change. Only the diagnosis is added.
#[test]
fn failing_final_verification_names_the_command_and_captures_output() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let root = fixture(
        "pa-f15-fail",
        r#"[{"name":"failing-check","argv":["sh","-c","echo BOOM_STDOUT; echo BOOM_STDERR 1>&2; exit 3"],"cwd":".","timeoutMs":30000}]"#,
    );
    let (snapshot, mut state) = snapshot_for(&root);

    let previous = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("chdir");
    let result = seam::produce_final_evidence(&snapshot, &mut state);
    std::env::set_current_dir(previous).expect("restore cwd");

    let error = result.expect_err("a failing final command must be a loud error");
    let text = error.to_string();
    assert!(
        text.contains("final-evidence:verification-failed"),
        "must be typed: {text}"
    );
    assert!(text.contains("name=failing-check"), "must name it: {text}");
    assert!(text.contains("exit=3"), "must carry exit code: {text}");
    assert!(
        text.contains("BOOM_STDOUT"),
        "must capture stdout tail: {text}"
    );
    assert!(
        text.contains("BOOM_STDERR"),
        "must capture stderr tail: {text}"
    );
    let _ = fs::remove_dir_all(&root);
}

/// The happy path must still append all three proofs bound to the exact tip.
/// This is what stops the diagnostics change from quietly weakening the gate.
#[test]
fn passing_final_verification_still_produces_all_three_proofs() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let root = fixture(
        "pa-f15-pass",
        r#"[{"name":"ok-check","argv":["sh","-c","exit 0"],"cwd":".","timeoutMs":30000}]"#,
    );
    let (snapshot, mut state) = snapshot_for(&root);

    let previous = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("chdir");
    let evidence = seam::produce_final_evidence(&snapshot, &mut state);
    std::env::set_current_dir(previous).expect("restore cwd");

    let evidence = evidence.expect("passing verification must produce evidence");
    assert!(evidence.final_commands_pass, "{evidence:?}");
    assert!(evidence.full_suite_pass, "{evidence:?}");
    assert!(evidence.final_validator_pass, "{evidence:?}");
    assert_eq!(evidence.tip, snapshot.tip);
    let _ = fs::remove_dir_all(&root);
}

/// An empty argv is a malformed fixture, not a verification failure. It must be
/// distinguishable, otherwise a broken config looks exactly like failing tests.
#[test]
fn empty_verification_argv_is_a_distinct_loud_error() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let root = fixture(
        "pa-f15-empty",
        r#"[{"name":"no-argv","argv":[],"cwd":".","timeoutMs":30000}]"#,
    );
    let (snapshot, mut state) = snapshot_for(&root);

    let previous = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("chdir");
    let result = seam::produce_final_evidence(&snapshot, &mut state);
    std::env::set_current_dir(previous).expect("restore cwd");

    let text = result
        .expect_err("empty argv must not be silently treated as a failed check")
        .to_string();
    assert!(
        text.contains("final-evidence:verification-command-empty-argv"),
        "{text}"
    );
    assert!(text.contains("no-argv"), "{text}");
    let _ = fs::remove_dir_all(&root);
}

/// Real `cargo test`/`clippy` output contains multi-byte glyphs. Slicing the captured
/// tail at a BYTE offset panics when that offset lands inside a character, which would
/// destroy the diagnostic at the exact moment it is needed. This drives >600 multi-byte
/// characters through the real capture path.
#[test]
fn verification_output_tail_survives_multibyte_output() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let root = fixture(
        "pa-f15-utf8",
        r#"[{"name":"utf8-check","argv":["sh","-c","printf '\u20ac%.0s' $(seq 1 700); printf '\u00e9'; exit 4"],"cwd":".","timeoutMs":30000}]"#,
    );
    let (snapshot, mut state) = snapshot_for(&root);

    let previous = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("chdir");
    let result = seam::produce_final_evidence(&snapshot, &mut state);
    std::env::set_current_dir(previous).expect("restore cwd");

    let text = result
        .expect_err("failing utf8 command must still be a loud error")
        .to_string();
    assert!(text.contains("name=utf8-check"), "{text}");
    assert!(text.contains("exit=4"), "{text}");
    let _ = fs::remove_dir_all(&root);
}

fn fixture(name: &str, commands_json: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join(".pi")).expect("mkdir .pi");
    fs::write(root.join("README.md"), "fixture\n").expect("readme");
    fs::write(
        root.join(".pi/live-test.json"),
        format!(
            r#"{{"schema":"pi-autopilot-live-test.v1","workstream":"ws","tasks":["t.md"],
"expectedResultRefPattern":"^refs/autopilot/results/ws/.+$",
"allowedChangedPaths":["src/lib.rs"],"immutablePaths":[],
"verificationCommands":{commands_json},
"fileAssertions":[],"disposable":true}}"#
        ),
    )
    .expect("live-test.json");
    git(&root, &["init"]);
    git(&root, &["config", "user.email", "t@example.invalid"]);
    git(&root, &["config", "user.name", "T"]);
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "fixture"]);
    root
}

fn snapshot_for(root: &Path) -> (FinalSnapshot, CoreState) {
    let tip = git_out(root, &["rev-parse", "--verify", "HEAD"]);
    let tree = git_out(root, &["rev-parse", "--verify", "HEAD^{tree}"]);
    let state = CoreState::open(Some(root.join(".pi/autopilot/events.jsonl"))).expect("state");
    (
        FinalSnapshot {
            workstream: "ws".to_owned(),
            run_id: "run-f15".to_owned(),
            tip,
            tree,
            revision: 1,
            event_tip: "event-tip".to_owned(),
            required_lanes: vec!["L1".to_owned()],
            mode: ClosureMode::Automatic,
        },
        state,
    )
}

fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
}

fn git_out(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}
