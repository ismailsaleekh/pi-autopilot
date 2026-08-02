#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use drivers::{runner, vcs::GitVcs};
use kernel::generated::{
    BackgroundAction, ContractId, CoreToHostDonePayload, CoreToHostSpawnPayload,
    CoreToHostSpawnWavePayload, CoreToHostUiPayload, EventRow, Id, ModeId, SeamEnvelope, Sha,
};
use sha2::{Digest as ShaDigest, Sha256};

#[test]
fn command_routing_all_public_commands_reach_driver_surfaces() {
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
    let plan_wave = planning_wave_payload(plan);
    assert_p1_wave_is_parallel(&plan_wave);
    for action in &plan_wave.actions {
        assert!(action.bg_run.command.0.contains(" --spec "));
        assert!(
            !action
                .bg_run
                .command
                .0
                .contains("autopilot-agent-run --assignment")
        );
    }

    let ready = complete_planning_until_ready(plan_wave, &event_log, &repo);
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
        close_status.contains("rejection:lifecycle-close:CloseNotReady:"),
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
fn one_unit_work_map_reaches_ready_and_dispatches_one_lane() {
    let root = temp_dir("one-unit-plan");
    let repo = root.join("repo");
    let vcs = GitVcs::new(&root);
    vcs.init_fixture(&repo).expect("fixture repo");
    let task_paths = write_task_pack(&repo, "set-one-unit-plan");
    vcs.stage_all(&repo).expect("stage task");
    vcs.snapshot(&repo, "task commit").expect("task commit");
    let event_log = root.join("events.jsonl");

    let plan_raw = format!("autopilot-plan main {}", task_paths.join(" "));
    let plan = send_with_log(&plan_raw, &event_log, Some(&repo));
    let plan_wave = planning_wave_payload(plan);
    assert_p1_wave_is_parallel(&plan_wave);
    let ready = complete_planning_until_ready_with_work_map(
        plan_wave,
        &event_log,
        &repo,
        Some(one_unit_work_map()),
    );
    assert!(done_status(&ready).contains("ready-to-execute:workstream=main"));
    let approved: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(repo.join(".pi/autopilot/main/approved-plan.json"))
            .expect("approved plan"),
    )
    .expect("approved json");
    assert_eq!(
        approved["units"].as_array().expect("approved units").len(),
        1
    );

    let run = send_with_log("autopilot main", &event_log, Some(&repo));
    assert_eq!(run.kind, "spawn", "single-lane run response: {:?}", run);
    let spawn_payload: CoreToHostSpawnPayload =
        serde_json::from_value(run.payload).expect("run spawn payload");
    assert_eq!(spawn_payload.action.assignment_id.0, "assignment-main-L1");
}

#[test]
fn failed_plan_review_projection_is_loud_unconsumed_and_retryable() {
    let root = temp_dir("plan-review-retry");
    let repo = root.join("repo");
    let vcs = GitVcs::new(&root);
    vcs.init_fixture(&repo).expect("fixture repo");
    let task_paths = write_task_pack(&repo, "set-plan-review-retry");
    vcs.stage_all(&repo).expect("stage task");
    vcs.snapshot(&repo, "task commit").expect("task commit");
    let event_log = root.join("events.jsonl");

    let plan_raw = format!("autopilot-plan main {}", task_paths.join(" "));
    let plan = send_with_log(&plan_raw, &event_log, Some(&repo));
    let plan_wave = planning_wave_payload(plan);
    assert_p1_wave_is_parallel(&plan_wave);
    let spawn_payload = complete_planning_until_assignment(
        plan_wave,
        &event_log,
        &repo,
        "planning-main-plan-reviewer-01",
    );

    fs::write(
        repo.join(".pi/autopilot/main/work-map.md"),
        "{\"units\":[]}",
    )
    .expect("poison work map");
    let failed = send_planning_completion(&spawn_payload, &event_log, &repo, 900);
    let failed_status = done_status(&failed);
    assert!(
        failed_status.contains("rejection:planning-postprocess:CONTEXT_GAP:approved-plan:expected at least 1 approved unit, got 0"),
        "unexpected status: {failed_status}"
    );
    assert!(!repo.join(".pi/autopilot/main/approved-plan.json").exists());
    assert!(!fs::read_to_string(&event_log)
        .expect("event log")
        .contains("planning-result-consumed:action-planning-main-plan-reviewer-01:planning-main-plan-reviewer-01"));

    fs::write(
        repo.join(".pi/autopilot/main/work-map.md"),
        one_unit_work_map(),
    )
    .expect("repair work map");
    let retried = send_planning_completion(&spawn_payload, &event_log, &repo, 901);
    assert!(done_status(&retried).contains("ready-to-execute:workstream=main"));
    assert!(repo.join(".pi/autopilot/main/approved-plan.json").exists());
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
fn autonomous_two_command_flow_creates_result_ref() {
    let root = temp_dir("auto-close");
    let repo = complete_run_repo(&root, "hello-health", 1, &["L1"]);
    let event_log = root.join("events.jsonl");
    append_unit_closed(&event_log, &repo, "L1");

    let close = send_with_log("autopilot hello-health", &event_log, Some(&repo));
    let status = done_status(&close);
    assert_controller_close_line(&status);
    let result_ref = status.trim_start_matches("lifecycle:close:result_ref=");
    assert_ref_at(
        &repo,
        result_ref,
        git_stdout(
            &repo,
            &[
                "rev-parse",
                "--verify",
                "refs/heads/autopilot/run/hello-health/main",
            ],
        )
        .trim(),
    );
}

#[test]
fn first_lane_integration_does_not_finalize_multilane_run() {
    let root = temp_dir("multi-no-first-close");
    let repo = complete_run_repo(&root, "multi", 2, &["L1"]);
    let event_log = root.join("events.jsonl");
    append_unit_closed(&event_log, &repo, "L1");

    let response = send_with_log("autopilot multi", &event_log, Some(&repo));
    assert_ne!(done_status_or_kind(&response), "lifecycle-close");
    assert_no_result_refs(&repo);
}

#[test]
fn aggregate_completion_finalizes_exactly_once() {
    let root = temp_dir("aggregate-once");
    let repo = complete_run_repo(&root, "agg", 2, &["L1", "L2"]);
    let event_log = root.join("events.jsonl");
    append_unit_closed(&event_log, &repo, "L1");
    append_unit_closed(&event_log, &repo, "L2");

    let first = done_status(&send_with_log("autopilot agg", &event_log, Some(&repo)));
    assert_controller_close_line(&first);
    let second = done_status(&send_with_log("autopilot agg", &event_log, Some(&repo)));
    assert_eq!(first, second);
    let log = fs::read_to_string(&event_log).expect("event log");
    assert_eq!(log.matches("final:evidence-produced").count(), 1);
}

#[test]
fn active_or_unknown_job_blocks_finalization() {
    let root = temp_dir("active-blocks");
    let repo = complete_run_repo(&root, "busy", 1, &["L1"]);
    let event_log = root.join("events.jsonl");
    append_unit_closed(&event_log, &repo, "L1");
    append_active_binding(&event_log, &repo, "busy");

    let response = send_with_log("autopilot busy", &event_log, Some(&repo));
    assert!(!done_status_or_kind(&response).starts_with("lifecycle:close:result_ref="));
    assert_no_result_refs(&repo);
}

#[test]
fn final_evidence_is_bound_to_exact_tip() {
    let root = temp_dir("tip-bound");
    let repo = complete_run_repo(&root, "tipbound", 1, &["L1"]);
    let event_log = root.join("events.jsonl");
    append_unit_closed(&event_log, &repo, "L1");
    let old_tip = git_stdout(
        &repo,
        &[
            "rev-parse",
            "--verify",
            "refs/heads/autopilot/run/tipbound/main",
        ],
    )
    .trim()
    .to_owned();

    let status = done_status(&send_with_log(
        "autopilot tipbound",
        &event_log,
        Some(&repo),
    ));
    assert_controller_close_line(&status);
    fs::write(
        repo.join("src/lib.rs"),
        "pub fn changed() -> &'static str { \"new\" }\n",
    )
    .expect("edit");
    git_stdout(&repo, &["add", "src/lib.rs"]);
    git_stdout(&repo, &["commit", "-m", "move final tip"]);
    let new_tip = git_stdout(&repo, &["rev-parse", "--verify", "HEAD"])
        .trim()
        .to_owned();
    git_stdout(
        &repo,
        &[
            "update-ref",
            "refs/heads/autopilot/run/tipbound/main",
            &new_tip,
        ],
    );
    let _ = send_with_log("autopilot tipbound", &event_log, Some(&repo));
    let log = fs::read_to_string(&event_log).expect("event log");
    assert!(log.contains(&format!("final-commands-pass:{old_tip}")));
    assert!(!log.contains(&format!("final-commands-pass:{new_tip}")));
}

#[test]
fn manual_and_automatic_modes_share_lifecycle_machine() {
    let root = temp_dir("manual-mode");
    let repo = complete_run_repo(&root, "manual", 1, &["L1"]);
    let event_log = root.join("events.jsonl");
    append_unit_closed(&event_log, &repo, "L1");

    let awaiting = send_frame_env(
        frame_json(1, "autopilot manual"),
        &event_log,
        Some(&repo),
        &[("AUTOPILOT_CLOSURE_MODE", "operator_ratified")],
    );
    let awaiting_status = done_status(&awaiting);
    assert!(awaiting_status.starts_with("lifecycle:awaiting-close:workstream=manual;"));
    assert_no_result_refs(&repo);

    let args = close_command_for_state(&repo, &event_log, "manual", "run-manual");
    let closed = send_frame_env(
        frame_json(2, &args),
        &event_log,
        Some(&repo),
        &[("AUTOPILOT_CLOSURE_MODE", "operator_ratified")],
    );
    assert_controller_close_line(&done_status(&closed));
}

#[test]
fn publication_crash_recovers_only_with_matching_prepared_intent() {
    let root = temp_dir("prepared-recovery");
    let repo = complete_run_repo(&root, "recover", 1, &["L1"]);
    let event_log = root.join("events.jsonl");
    append_unit_closed(&event_log, &repo, "L1");
    let tip = git_stdout(
        &repo,
        &[
            "rev-parse",
            "--verify",
            "refs/heads/autopilot/run/recover/main",
        ],
    )
    .trim()
    .to_owned();
    let prepared = serde_json::json!({
        "schema":"PublicationPrepared",
        "run_id":"run-recover",
        "tip":tip,
        "result_ref":"refs/autopilot/results/recover/run-recover",
        "gate_digest":"digest-for-test"
    });
    let path = repo.join(".pi/autopilot/recover/close/publication-prepared.json");
    fs::create_dir_all(path.parent().expect("prepared parent")).expect("prepared dir");
    fs::write(
        &path,
        serde_json::to_vec_pretty(&prepared).expect("prepared json"),
    )
    .expect("prepared");

    let status = done_status(&send_with_log("autopilot recover", &event_log, Some(&repo)));
    assert_eq!(
        status,
        "lifecycle:close:result_ref=refs/autopilot/results/recover/run-recover"
    );
    assert_ref_at(
        &repo,
        "refs/autopilot/results/recover/run-recover",
        prepared["tip"].as_str().expect("tip"),
    );
}

#[test]
fn close_signal_is_exact_whole_line() {
    let root = temp_dir("exact-line");
    let repo = complete_run_repo(&root, "exact", 1, &["L1"]);
    let event_log = root.join("events.jsonl");
    append_unit_closed(&event_log, &repo, "L1");
    let status = done_status(&send_with_log("autopilot exact", &event_log, Some(&repo)));
    assert_controller_close_line(&status);
    assert!(!status.contains(";archive="));
    assert!(!status.contains(";sequence="));
}

#[test]
fn forward_integrated_is_progress_not_final() {
    let root = temp_dir("forward-progress");
    let repo = complete_run_repo(&root, "progress", 1, &[]);
    let event_log = root.join("events.jsonl");
    let response = send_with_log(
        "append:integration:integration:forward-integrated",
        &event_log,
        Some(&repo),
    );
    assert!(done_status(&response).contains("state:sequence="));
    let response = send_with_log("autopilot progress", &event_log, Some(&repo));
    assert!(!done_status_or_kind(&response).starts_with("lifecycle:close:result_ref="));
    assert_no_result_refs(&repo);
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

fn planning_wave_payload(envelope: SeamEnvelope) -> CoreToHostSpawnWavePayload {
    assert_eq!(
        envelope.kind, "spawn-wave",
        "planning response: {:?}",
        envelope
    );
    serde_json::from_value(envelope.payload).expect("planning spawn-wave payload")
}

fn assert_p1_wave_is_parallel(wave: &CoreToHostSpawnWavePayload) {
    assert!(
        wave.actions.len() > 1,
        "P1 planning wave must carry more than one action, got {}",
        wave.actions.len()
    );
}

fn complete_planning_until_ready(
    spawn_wave: CoreToHostSpawnWavePayload,
    event_log: &Path,
    cwd: &Path,
) -> SeamEnvelope {
    complete_planning_until_ready_with_work_map(spawn_wave, event_log, cwd, None)
}

fn complete_planning_until_ready_with_work_map(
    spawn_wave: CoreToHostSpawnWavePayload,
    event_log: &Path,
    cwd: &Path,
    work_map_override: Option<String>,
) -> SeamEnvelope {
    let mut next_id = 2;
    let mut pending = VecDeque::new();
    acknowledge_spawn_wave(&spawn_wave, event_log, cwd, &mut next_id);
    pending.extend(spawn_wave.actions);
    for _step in 0..100 {
        let Some(action) = pending.pop_front() else {
            panic!("planning queue drained before ready-to-execute");
        };
        let response = send_planning_completion_with_work_map(
            &action,
            event_log,
            cwd,
            next_id,
            work_map_override.as_deref(),
        );
        next_id += 2;
        match response.kind.as_str() {
            "done" => {
                let status = done_status(&response);
                if status.contains("ready-to-execute:workstream=main") {
                    assert!(
                        pending.is_empty(),
                        "planning reached ready with {} issued actions still pending",
                        pending.len()
                    );
                    return response;
                }
                if status.starts_with("rejection:") || status.starts_with("planning:blocked:") {
                    return response;
                }
            }
            "spawn-wave" => {
                let wave = planning_wave_payload(response);
                acknowledge_spawn_wave(&wave, event_log, cwd, &mut next_id);
                pending.extend(wave.actions);
            }
            other => panic!("planning step returned unexpected frame kind {other}"),
        }
    }
    panic!("planning did not become ready");
}

fn complete_planning_until_assignment(
    spawn_wave: CoreToHostSpawnWavePayload,
    event_log: &Path,
    cwd: &Path,
    target_assignment_id: &str,
) -> BackgroundAction {
    let mut next_id = 2;
    let mut pending = VecDeque::new();
    acknowledge_spawn_wave(&spawn_wave, event_log, cwd, &mut next_id);
    pending.extend(spawn_wave.actions);
    for _step in 0..100 {
        let Some(action) = pending.pop_front() else {
            panic!("planning queue drained before issuing {target_assignment_id}");
        };
        if action.assignment_id.0 == target_assignment_id {
            return action;
        }
        let response = send_planning_completion(&action, event_log, cwd, next_id);
        next_id += 2;
        match response.kind.as_str() {
            "done" => {
                let status = done_status(&response);
                assert!(
                    !status.contains("ready-to-execute:workstream=main"),
                    "planning became ready before issuing {target_assignment_id}: {status}"
                );
                assert!(
                    !status.starts_with("rejection:") && !status.starts_with("planning:blocked:"),
                    "planning stopped before issuing {target_assignment_id}: {status}"
                );
            }
            "spawn-wave" => {
                let wave = planning_wave_payload(response);
                acknowledge_spawn_wave(&wave, event_log, cwd, &mut next_id);
                pending.extend(wave.actions);
            }
            other => panic!("planning step returned unexpected frame kind {other}"),
        }
    }
    panic!("planning did not issue {target_assignment_id}");
}

fn acknowledge_spawn_wave(
    wave: &CoreToHostSpawnWavePayload,
    event_log: &Path,
    cwd: &Path,
    next_id: &mut u64,
) {
    for action in &wave.actions {
        let ack = send_spawn_result(action, event_log, cwd, *next_id);
        *next_id += 1;
        let status = done_status(&ack);
        assert!(
            !status.starts_with("rejection:"),
            "spawn-result ack rejected for {}: {status}",
            action.assignment_id.0
        );
    }
}

fn send_spawn_result(
    action: &BackgroundAction,
    event_log: &Path,
    cwd: &Path,
    id: u64,
) -> SeamEnvelope {
    let cwd = fs::canonicalize(cwd).expect("canonical cwd");
    send_frame(
        serde_json::json!({
            "v":1,
            "id":id,
            "kind":"spawn-result",
            "payload":{
                "action_id":action.action_id.0,
                "assignment_id":action.assignment_id.0,
                "status":"launched",
                "task_id":format!("task-{}", action.action_id.0)
            }
        }),
        event_log,
        Some(&cwd),
    )
}

fn send_planning_completion(
    action: &BackgroundAction,
    event_log: &Path,
    cwd: &Path,
    id: u64,
) -> SeamEnvelope {
    send_planning_completion_with_work_map(action, event_log, cwd, id, None)
}

fn send_planning_completion_with_work_map(
    action: &BackgroundAction,
    event_log: &Path,
    cwd: &Path,
    id: u64,
    work_map_override: Option<&str>,
) -> SeamEnvelope {
    let cwd = fs::canonicalize(cwd).expect("canonical cwd");
    let assignment_id = &action.assignment_id.0;
    let spec_path = cwd
        .join(".pi/autopilot/main/planning/specs")
        .join(format!("{assignment_id}.json"));
    let spec_text = fs::read_to_string(&spec_path).expect("planning spec");
    let spec: serde_json::Value = serde_json::from_str(&spec_text).expect("planning spec json");
    let boundary_id = spec["boundary_id"].as_str().expect("boundary");
    let raw_output =
        common::planning_replay_output(boundary_id, &spec, &spec_path, work_map_override);
    let carrier_path = cwd
        .join(".pi/autopilot/main/planning/carriers")
        .join(format!("{assignment_id}.json"));
    let carrier = serde_json::json!({
        "schema":"autopilot.planning_carrier.v1",
        "action_id":action.action_id.0,
        "assignment_id":assignment_id,
        "run_revision":action.run_revision,
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
    fs::create_dir_all(carrier_path.parent().expect("planning carrier directory"))
        .expect("planning carrier fixture directory");
    fs::write(
        &carrier_path,
        serde_json::to_vec(&carrier).expect("planning carrier serialize"),
    )
    .expect("planning carrier fixture file");
    let completed = send_frame(
        serde_json::json!({
            "v":1,
            "id":id,
            "kind":"task-completed",
            "payload":{
                "task_id":format!("task-{}", action.action_id.0),
                "action_id":action.action_id.0,
                "assignment_id":assignment_id,
                "status":"completed"
            }
        }),
        event_log,
        Some(&cwd),
    );
    let agent_result = send_frame(
        serde_json::json!({"v":1,"id":id + 1,"kind":"agent-result","payload":{"assignment_id":assignment_id,"carrier":carrier}}),
        event_log,
        Some(&cwd),
    );
    assert_eq!(
        agent_result.kind, "done",
        "agent-result follow-up response: {:?}",
        agent_result
    );
    completed
}

fn one_unit_work_map() -> String {
    serde_json::json!({"units":[{"id":"U1","objective":"Deliver the one accepted work unit.","criteria":["The focused acceptance path passes."],"links":["W1"]}]}).to_string()
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
    send_frame_env(frame, event_log, cwd, &[])
}

fn send_frame_env(
    frame: serde_json::Value,
    event_log: &Path,
    cwd: Option<&Path>,
    envs: &[(&str, &str)],
) -> SeamEnvelope {
    let mut child = spawn_core_env(event_log, cwd, envs);
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
    spawn_core_env(event_log, cwd, &[])
}

fn spawn_core_env(event_log: &Path, cwd: Option<&Path>, envs: &[(&str, &str)]) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_autopilot-core"));
    let exe = std::env::current_exe().expect("current exe");
    command
        .env("AUTOPILOT_CORE_EVENT_LOG", event_log)
        .env("AUTOPILOT_NODE_EXECUTABLE", &exe)
        .env("AUTOPILOT_AGENT_RUNNER_WRAPPER", &exe)
        .env(
            "AUTOPILOT_CHILD_ADDON_PATH",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in envs {
        command.env(name, value);
    }
    if let Some(path) = cwd {
        command.current_dir(path);
    }
    command.spawn().expect("spawn autopilot-core")
}

fn frame_json(id: u64, raw: &str) -> serde_json::Value {
    serde_json::json!({"v":1,"id":id,"kind":"command","payload":{"raw":raw,"background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true}}})
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
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("git stdout")
}

fn complete_run_repo(root: &Path, workstream: &str, units: usize, _closed: &[&str]) -> PathBuf {
    let repo = root.join("repo");
    let vcs = GitVcs::new(root);
    vcs.init_fixture(&repo).expect("fixture repo");
    fs::create_dir_all(repo.join("src")).expect("src dir");
    fs::write(
        repo.join("src/lib.rs"),
        "pub fn health_status() -> &'static str { \"ok\" }\n",
    )
    .expect("lib");
    git_stdout(&repo, &["add", "src/lib.rs"]);
    git_stdout(&repo, &["commit", "-m", "fixture implementation"]);
    fs::create_dir_all(repo.join(".pi/autopilot").join(workstream)).expect("autopilot dir");
    let approved_units = (1..=units)
        .map(|index| {
            serde_json::json!({
                "id": format!("U{index}"),
                "operator_order": index,
                "decisions": [],
                "criteria": [format!("AC-U{index}-1")],
                "dependencies": [],
                "predecessor_forward_criteria": [],
                "downstream_release_edges": [format!("EDGE{index}")]
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        repo.join(".pi/autopilot")
            .join(workstream)
            .join("approved-plan.json"),
        serde_json::to_vec_pretty(&serde_json::json!({"units": approved_units}))
            .expect("approved json"),
    )
    .expect("approved plan");
    let head = git_stdout(&repo, &["rev-parse", "--verify", "HEAD"]);
    git_stdout(
        &repo,
        &[
            "update-ref",
            &format!("refs/heads/autopilot/run/{workstream}/main"),
            head.trim(),
        ],
    );
    repo
}

fn append_unit_closed(event_log: &Path, repo: &Path, lane: &str) {
    let status = done_status(&send_with_log(
        &format!("append:final-precondition:unit-closed:{lane}"),
        event_log,
        Some(repo),
    ));
    assert!(status.contains("state:sequence="));
}

fn append_active_binding(event_log: &Path, repo: &Path, workstream: &str) {
    let binding = runner::IssuedRunnerBinding {
        action_id: Id("action-active".to_owned()),
        assignment_id: Id("assignment-active".to_owned()),
        run_revision: 1,
        workstream: Id(workstream.to_owned()),
        role_id: Id("implementer".to_owned()),
        mode: ModeId("lane-delivery".to_owned()),
        boundary_id: ContractId("delivery".to_owned()),
        result_contract: ContractId("autopilot.delivery_result.v2".to_owned()),
        prompt_path: "prompt".to_owned(),
        prompt_digest: "digest".to_owned(),
        spec_path: "spec".to_owned(),
        spec_digest: "digest".to_owned(),
        carrier_path: "carrier".to_owned(),
        session_id: Id("session".to_owned()),
        boundary_digest: "digest".to_owned(),
        result_contract_digest: "digest".to_owned(),
        settings_digest: "digest".to_owned(),
        context_digest: "digest".to_owned(),
        skills_digest: "digest".to_owned(),
        subscription_digest: "digest".to_owned(),
        mode_parameter: None,
        lane_id: Some(Id("L1".to_owned())),
        attempt: Some(1),
        base_commit: Some(Sha(git_stdout(repo, &["rev-parse", "--verify", "HEAD"])
            .trim()
            .to_owned())),
        worktree: None,
        required_focused_evidence: 0,
    };
    let reference = runner::binding_ref(&binding).expect("binding ref");
    let status = done_status(&send_with_log(
        &format!("append:test:{}", reference.0),
        event_log,
        Some(repo),
    ));
    assert!(status.contains("state:sequence="));
}

fn done_status_or_kind(envelope: &SeamEnvelope) -> String {
    if envelope.kind == "done" {
        done_status(envelope)
    } else {
        envelope.kind.clone()
    }
}

fn assert_controller_close_line(status: &str) {
    let Some(result_ref) = status.strip_prefix("lifecycle:close:result_ref=") else {
        panic!("not a close line: {status}");
    };
    assert!(!result_ref.is_empty(), "missing result ref");
    assert!(
        !result_ref.contains(';'),
        "result ref line has suffix: {status}"
    );
    let parts = result_ref.split('/').collect::<Vec<_>>();
    assert_eq!(parts.first(), Some(&"refs"), "{status}");
    assert_eq!(parts.get(1), Some(&"autopilot"), "{status}");
    assert_eq!(parts.get(2), Some(&"results"), "{status}");
    assert_eq!(parts.len(), 5, "{status}");
    for component in &parts[3..] {
        assert!(
            component
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')),
            "{status}"
        );
    }
}

fn assert_ref_at(repo: &Path, reference: &str, expected: &str) {
    let actual = git_stdout(repo, &["rev-parse", "--verify", reference]);
    assert_eq!(actual.trim(), expected);
}

fn assert_no_result_refs(repo: &Path) {
    let output = Command::new("git")
        .current_dir(repo)
        .args([
            "for-each-ref",
            "--format=%(refname)",
            "refs/autopilot/results",
        ])
        .output()
        .expect("git for-each-ref");
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .expect("utf8")
            .trim()
            .is_empty()
    );
}

fn close_command_for_state(
    repo: &Path,
    event_log: &Path,
    workstream: &str,
    run_id: &str,
) -> String {
    let state = done_status(&send_with_log("state", event_log, Some(repo)));
    let revision = state
        .split("revision=")
        .nth(1)
        .and_then(|rest| rest.split(';').next())
        .expect("revision");
    let hash = state.split("hash=").nth(1).expect("hash");
    let tip = git_stdout(
        repo,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/heads/autopilot/run/{workstream}/main"),
        ],
    );
    let tip = tip.trim();
    let tree = git_stdout(repo, &["rev-parse", "--verify", &format!("{tip}^{{tree}}")]);
    format!(
        "autopilot-close {workstream} --run {run_id} --expected-revision {revision} --expected-event-tip sha256:{hash} --expected-tip {tip} --expected-tree {} --expected-final-digest sha256:{}",
        tree.trim(),
        "1".repeat(64)
    )
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
