#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use drivers::runner;
use drivers::seam::{self, CoreState};
use kernel::generated::{CoreToHostDonePayload, CoreToHostSpawnPayload, EventRow, SeamEnvelope};
use sha2::{Digest as ShaDigest, Sha256};

static CWD_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn multi_unit_plan_dispatches_next_lane_after_integration() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let fixture = AdvanceFixture::new("dispatch-next", 2, false);
    let original_head = git_out(&fixture.root, &["rev-parse", "--verify", "HEAD^{commit}"]);
    let mut state = fixture.state();
    let first = send_command(&mut state, "autopilot main");
    let first_spawn = spawn_payload(first);
    assert_eq!(first_spawn.action.assignment_id.0, "assignment-main-L1");

    let after_l1 = fixture.complete_lane(&mut state, &first_spawn, "l1");
    assert_eq!(after_l1.kind, "spawn", "response: {after_l1:?}");
    let next = spawn_payload(after_l1);
    assert_eq!(next.action.assignment_id.0, "assignment-main-L2");
    assert_eq!(fixture.count_agent_spawns("assignment-main-L2"), 1);
    let run_main = git_out(
        &fixture.root,
        &[
            "rev-parse",
            "--verify",
            "refs/heads/autopilot/run/main/main^{commit}",
        ],
    );
    let next_spec = fixture.delivery_spec(&next);
    assert_eq!(next_spec["base_commit"], run_main);
    let next_worktree = PathBuf::from(next_spec["worktree"].as_str().expect("worktree"));
    assert_eq!(
        git_out(&next_worktree, &["rev-parse", "--verify", "HEAD^{commit}"]),
        run_main
    );
    assert_ne!(run_main, original_head);
}

#[test]
fn deleting_run_main_after_execution_begins_is_loud() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let fixture = AdvanceFixture::new("run-main-delete", 2, false);
    let mut state = fixture.state();
    let first = send_command(&mut state, "autopilot main");
    assert_eq!(first.kind, "spawn", "response: {first:?}");
    run(
        &fixture.root,
        &["update-ref", "-d", "refs/heads/autopilot/run/main/main"],
    );
    let refused = send_command(&mut state, "autopilot main");
    assert_eq!(refused.kind, "done", "response: {refused:?}");
    let status = done_status(&refused);
    assert!(
        status.contains("run-main missing after execution began"),
        "{status}"
    );
}

#[test]
fn wrong_preexisting_run_main_before_execution_is_loud_and_not_adopted() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let fixture = AdvanceFixture::new("run-main-wrong-preexisting", 1, false);
    let baseline = git_out(&fixture.root, &["rev-parse", "--verify", "HEAD^{commit}"]);
    let baseline_tree = git_out(&fixture.root, &["rev-parse", "--verify", "HEAD^{tree}"]);
    let foreign = git_out(
        &fixture.root,
        &["commit-tree", &baseline_tree, "-m", "foreign run-main"],
    );
    assert_ne!(foreign, baseline);
    run(
        &fixture.root,
        &[
            "update-ref",
            "refs/heads/autopilot/run/main/main",
            &foreign,
            "",
        ],
    );

    let mut state = fixture.state();
    let refused = send_command(&mut state, "autopilot main");
    assert_eq!(refused.kind, "done", "response: {refused:?}");
    let status = done_status(&refused);
    assert!(
        status.contains("run-main preexisting baseline drift"),
        "{status}"
    );
    assert!(status.contains(&baseline), "{status}");
    assert!(status.contains(&foreign), "{status}");
    assert_eq!(
        git_out(
            &fixture.root,
            &[
                "rev-parse",
                "--verify",
                "refs/heads/autopilot/run/main/main^{commit}",
            ],
        ),
        foreign,
        "foreign preexisting run-main must not be adopted or overwritten"
    );
    assert_eq!(fixture.count_agent_spawns("assignment-main-L1"), 0);
}

#[test]
fn sequential_plan_reaches_closure_and_result_ref() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let fixture = AdvanceFixture::new("closure", 2, false);
    let mut state = fixture.state();
    let first = spawn_payload(send_command(&mut state, "autopilot main"));
    let second = spawn_payload(fixture.complete_lane(&mut state, &first, "l1"));
    let closed = fixture.complete_lane(&mut state, &second, "l2");

    assert_eq!(closed.kind, "done", "response: {closed:?}");
    let status = done_status(&closed);
    assert!(
        status.contains("lifecycle:close:result_ref=refs/autopilot/results/main/"),
        "status: {status}"
    );
    let refs = git_out(
        &fixture.root,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/autopilot/results/main",
        ],
    );
    let result_refs = refs.lines().collect::<Vec<_>>();
    assert_eq!(result_refs.len(), 1, "result refs: {result_refs:?}");
}

#[test]
fn forward_validator_blocker_launches_one_context_bound_recovery_engineer() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let fixture = AdvanceFixture::new("validator-recovery", 1, false);
    let mut state = fixture.state();
    let delivery_spawn = spawn_payload(send_command(&mut state, "autopilot main"));
    let delivery_spec = fixture.delivery_spec(&delivery_spawn);
    let worktree = PathBuf::from(delivery_spec["worktree"].as_str().expect("worktree"));
    let changed_path = "l1.txt";
    fs::write(
        worktree.join(changed_path),
        "candidate requiring one surgical validation repair\n",
    )
    .expect("worktree edit");
    let delivery_carrier_path =
        PathBuf::from(delivery_spec["carrier_path"].as_str().expect("carrier"));
    fs::create_dir_all(delivery_carrier_path.parent().expect("carrier parent"))
        .expect("carrier dir");
    fs::write(
        &delivery_carrier_path,
        serde_json::to_vec_pretty(&delivery_carrier(&delivery_spec, changed_path))
            .expect("delivery carrier"),
    )
    .expect("delivery carrier write");
    let validation_spawn = spawn_payload(send_task_completed(
        &mut state,
        "task-delivery-validator-recovery",
        &delivery_spawn.action.action_id.0,
        &delivery_spawn.action.assignment_id.0,
    ));
    let validation_spec = fixture.validation_spec(&worktree, &validation_spawn);
    let validation_carrier_path = PathBuf::from(
        validation_spec["carrier_path"]
            .as_str()
            .expect("validation carrier"),
    );
    fs::create_dir_all(
        validation_carrier_path
            .parent()
            .expect("validation carrier parent"),
    )
    .expect("validation carrier dir");
    fs::write(
        &validation_carrier_path,
        serde_json::to_vec_pretty(&validation_blocked_carrier(&validation_spec))
            .expect("blocked validation carrier"),
    )
    .expect("blocked validation carrier write");

    let recovery_spawn = spawn_payload(send_task_completed(
        &mut state,
        "task-validation-validator-recovery",
        &validation_spawn.action.action_id.0,
        &validation_spawn.action.assignment_id.0,
    ));
    assert_eq!(
        recovery_spawn.action.assignment_id.0,
        "recovery-assignment-main-L1-a1"
    );
    let recovery_spec_path = worktree.join(format!(
        ".pi/autopilot/runner/specs/{}.json",
        recovery_spawn.action.assignment_id.0
    ));
    let recovery_spec: serde_json::Value =
        serde_json::from_slice(&fs::read(recovery_spec_path).expect("recovery spec"))
            .expect("recovery spec json");
    assert_eq!(recovery_spec["role_id"], "recovery-engineer");
    assert_eq!(recovery_spec["mode"], "forward-critical");
    let assignment_path = PathBuf::from(
        recovery_spec["assignment_path"]
            .as_str()
            .expect("assignment path"),
    );
    let assignment: serde_json::Value =
        serde_json::from_slice(&fs::read(assignment_path).expect("recovery assignment"))
            .expect("recovery assignment json");
    assert_eq!(assignment["recovery"]["trigger_phase"], "validation");
    assert_eq!(assignment["recovery"]["repair_mode"], "forward-critical");
    assert_eq!(assignment["recovery"]["attempt_budget"], 1);
    assert!(
        assignment["recovery"]["diagnosis_details"][0]
            .as_str()
            .expect("diagnosis detail")
            .contains("surgical source repair")
    );

    let events = fs::read_to_string(&fixture.event_path).expect("events before replay");
    let lines = events.lines().collect::<Vec<_>>();
    let pending = lines
        .iter()
        .rposition(|line| line.contains("recovery:pending"))
        .expect("durable validation recovery pending event");
    fs::write(
        &fixture.event_path,
        format!("{}\n", lines[..=pending].join("\n")),
    )
    .expect("project validation crash before recovery issue");
    state = fixture.state();
    let replayed_recovery = spawn_payload(send_command(&mut state, "autopilot main"));
    assert_eq!(
        replayed_recovery.action.assignment_id,
        recovery_spawn.action.assignment_id
    );
    assert_eq!(
        replayed_recovery.action.action_id,
        recovery_spawn.action.action_id
    );
    let recovery_spawn = replayed_recovery;

    fs::write(
        worktree.join(changed_path),
        "candidate repaired by recovery engineer\n",
    )
    .expect("recovery edit");
    let recovery_carrier_path = PathBuf::from(
        recovery_spec["carrier_path"]
            .as_str()
            .expect("recovery carrier"),
    );
    fs::create_dir_all(
        recovery_carrier_path
            .parent()
            .expect("recovery carrier parent"),
    )
    .expect("recovery carrier dir");
    fs::write(
        &recovery_carrier_path,
        serde_json::to_vec_pretty(&delivery_carrier(&recovery_spec, changed_path))
            .expect("recovery carrier"),
    )
    .expect("recovery carrier write");
    let revalidation_spawn = spawn_payload(send_task_completed(
        &mut state,
        "task-recovery-validator-recovery",
        &recovery_spawn.action.action_id.0,
        &recovery_spawn.action.assignment_id.0,
    ));
    let revalidation_spec = fixture.validation_spec(&worktree, &revalidation_spawn);
    assert_eq!(revalidation_spec["semantic_round"], 2);
    assert_eq!(revalidation_spec["validation_attempt"], 2);
    let revalidation_carrier_path = PathBuf::from(
        revalidation_spec["carrier_path"]
            .as_str()
            .expect("revalidation carrier"),
    );
    fs::create_dir_all(
        revalidation_carrier_path
            .parent()
            .expect("revalidation carrier parent"),
    )
    .expect("revalidation carrier dir");
    fs::write(
        &revalidation_carrier_path,
        serde_json::to_vec_pretty(&validation_carrier(&revalidation_spec))
            .expect("revalidation carrier"),
    )
    .expect("revalidation carrier write");
    let closed = send_task_completed(
        &mut state,
        "task-revalidation-validator-recovery",
        &revalidation_spawn.action.action_id.0,
        &revalidation_spawn.action.assignment_id.0,
    );
    assert_eq!(closed.kind, "done", "revalidation response: {closed:?}");
    assert!(
        done_status(&closed).contains("lifecycle:close:result_ref=refs/autopilot/results/main/"),
        "status: {}",
        done_status(&closed)
    );
    let events = fs::read_to_string(&fixture.event_path).expect("events");
    assert!(events.contains("validation:recovery-required"), "{events}");
    assert!(events.contains("agent:delivery-accepted"), "{events}");
}

#[test]
fn unsafe_validator_blocker_fails_closed_without_recovery_engineer() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let fixture = AdvanceFixture::new("validator-unsafe-no-recovery", 1, false);
    let mut state = fixture.state();
    let delivery_spawn = spawn_payload(send_command(&mut state, "autopilot main"));
    let delivery_spec = fixture.delivery_spec(&delivery_spawn);
    let worktree = PathBuf::from(delivery_spec["worktree"].as_str().expect("worktree"));
    fs::write(worktree.join("l1.txt"), "candidate\n").expect("worktree edit");
    let delivery_carrier_path =
        PathBuf::from(delivery_spec["carrier_path"].as_str().expect("carrier"));
    fs::create_dir_all(delivery_carrier_path.parent().expect("carrier parent"))
        .expect("carrier dir");
    fs::write(
        &delivery_carrier_path,
        serde_json::to_vec_pretty(&delivery_carrier(&delivery_spec, "l1.txt"))
            .expect("delivery carrier"),
    )
    .expect("delivery carrier write");
    let validation_spawn = spawn_payload(send_task_completed(
        &mut state,
        "task-delivery-validator-unsafe",
        &delivery_spawn.action.action_id.0,
        &delivery_spawn.action.assignment_id.0,
    ));
    let validation_spec = fixture.validation_spec(&worktree, &validation_spawn);
    let validation_carrier_path = PathBuf::from(
        validation_spec["carrier_path"]
            .as_str()
            .expect("validation carrier"),
    );
    fs::create_dir_all(
        validation_carrier_path
            .parent()
            .expect("validation carrier parent"),
    )
    .expect("validation carrier dir");
    fs::write(
        &validation_carrier_path,
        serde_json::to_vec_pretty(&validation_blocked_carrier_with_kind(
            &validation_spec,
            "unsafe-boundary",
        ))
        .expect("unsafe validation carrier"),
    )
    .expect("unsafe validation carrier write");

    let stopped = send_task_completed(
        &mut state,
        "task-validation-validator-unsafe",
        &validation_spawn.action.action_id.0,
        &validation_spawn.action.assignment_id.0,
    );
    assert_eq!(stopped.kind, "done", "response: {stopped:?}");
    assert!(
        done_status(&stopped).contains("validation-recovery-inadmissible"),
        "response: {stopped:?}"
    );
    let events = fs::read_to_string(&fixture.event_path).expect("events");
    assert!(events.contains("recovery:inadmissible"), "{events}");
    assert!(!events.contains("validation:recovery-required"), "{events}");
    assert!(
        !events.contains("recovery-assignment-main-L1-a1"),
        "{events}"
    );
}

#[test]
fn seven_unit_plan_advances_beyond_the_six_lane_window_and_closes() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let fixture = AdvanceFixture::new("seven-unit-closure", 7, true);
    let mut state = fixture.state();
    let mut response = send_command(&mut state, "autopilot main");

    for index in 1..=7 {
        let spawned = spawn_payload(response);
        assert_eq!(
            spawned.action.assignment_id.0,
            format!("assignment-main-L{index}"),
            "unit {index} must retain its stable lane identity across allocation windows"
        );
        response = fixture.complete_lane(&mut state, &spawned, &format!("l{index}"));
    }

    assert_eq!(response.kind, "done", "response: {response:?}");
    assert!(
        done_status(&response).contains("lifecycle:close:result_ref=refs/autopilot/results/main/"),
        "status: {}",
        done_status(&response)
    );
    assert_eq!(fixture.count_agent_spawns("assignment-main-L7"), 1);
}

#[test]
fn parallel_seven_unit_window_counts_live_lanes_as_continuations() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let fixture = AdvanceFixture::new("parallel-seven-unit-window", 7, false);
    let mut state = fixture.state();

    for index in 1..=4 {
        let spawned = spawn_payload(send_command(&mut state, "autopilot main"));
        assert_eq!(
            spawned.action.assignment_id.0,
            format!("assignment-main-L{index}"),
            "independent lane {index} must dispatch without double-counting live lanes"
        );
    }

    let waiting = send_command(&mut state, "autopilot main");
    assert_eq!(waiting.kind, "done", "response: {waiting:?}");
    let status = done_status(&waiting);
    assert!(status.contains("dispatch:waiting"), "status: {status}");
    assert!(status.contains("active_implementers=4"), "status: {status}");
    assert!(!status.contains("ParallelCapExceeded"), "status: {status}");
    assert_eq!(fixture.count_agent_spawns("assignment-main-L7"), 0);
}

#[test]
fn advance_waits_while_work_is_in_flight() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let fixture = AdvanceFixture::new("wait-in-flight", 2, true);
    let mut state = fixture.state();
    let first = send_command(&mut state, "autopilot main");
    assert_eq!(first.kind, "spawn");
    let waiting = send_command(&mut state, "autopilot main");

    assert_eq!(waiting.kind, "done", "response: {waiting:?}");
    let status = done_status(&waiting);
    assert!(status.contains("dispatch:waiting"), "status: {status}");
    assert!(status.contains("active_implementers=1"), "status: {status}");
    assert!(!status.contains("dispatch-stuck"), "status: {status}");
    assert_eq!(fixture.count_agent_spawns("assignment-main-L1"), 1);
}

#[test]
fn quiescent_incomplete_run_fails_loudly() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let fixture = AdvanceFixture::new("stuck", 2, true);
    let mut state = fixture.state();
    let baseline = git_out(&fixture.root, &["rev-parse", "--verify", "HEAD^{commit}"]);
    run(
        &fixture.root,
        &[
            "update-ref",
            "refs/heads/autopilot/run/main/main",
            &baseline,
            "",
        ],
    );
    let appended = send_command(&mut state, "append:final-precondition:unit-closed:L1");
    assert_eq!(appended.kind, "done");

    let stuck = send_command(&mut state, "autopilot main");
    assert_eq!(stuck.kind, "done", "response: {stuck:?}");
    let status = done_status(&stuck);
    assert!(
        status.contains("rejection:dispatch-stuck"),
        "status: {status}"
    );
    assert!(status.contains("blocked=[L2:"), "status: {status}");
    assert!(
        status.contains("unmet_dependency_gate:unit-complete:U1"),
        "status: {status}"
    );
    assert!(status.contains("active_implementers=0"), "status: {status}");
    assert!(status.contains("active_validators=0"), "status: {status}");
    assert!(!status.starts_with("state:"), "status: {status}");
    assert!(
        git_out(
            &fixture.root,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "refs/autopilot/results/main",
            ],
        )
        .is_empty(),
        "stuck run must not publish a result ref"
    );
}

#[test]
fn integration_replay_does_not_double_dispatch() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let fixture = AdvanceFixture::new("replay", 2, false);
    let mut state = fixture.state();
    let first = spawn_payload(send_command(&mut state, "autopilot main"));
    let completed = fixture.complete_lane_with_terminal(&mut state, &first, "l1");
    let next = spawn_payload(completed.response.clone());
    assert_eq!(next.action.assignment_id.0, "assignment-main-L2");

    let replay = send_task_completed(
        &mut state,
        &completed.task_id,
        &completed.validation_action_id,
        &completed.validation_assignment_id,
    );
    assert_eq!(replay.kind, "done");
    assert!(done_status(&replay).contains("already-consumed"));
    assert_eq!(fixture.count_agent_spawns("assignment-main-L2"), 1);
}

/// LIVE run 18 regression: a unit gated on a predecessor's forward criterion must
/// become dispatchable once that predecessor CLOSES.
///
/// `predecessor_forward_criteria` is synthesized by the package: the unit at operator
/// order N carries `FC{N-1}`. Readiness required a `gate:FC{N-1}` ref, but nothing ever
/// appended one and the fallback was a stub that always returned false, so
/// `predecessor_gates_met` was permanently false. LIVE run 18 closed L1 and then
/// deadlocked with `dispatch-stuck ... blocked=[L2:unmet_dependency_gate:FC1]`.
///
/// This drives the exact shape: 2 units where U2 declares FC1.
#[test]
fn forward_criteria_gate_opens_when_the_predecessor_closes() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    // block_after_first = true => U2 declares predecessor_forward_criteria ["FC1"].
    let fixture = AdvanceFixture::new("forward-gate", 2, true);
    let mut state = fixture.state();

    let first = spawn_payload(send_command(&mut state, "autopilot main"));
    assert_eq!(first.action.assignment_id.0, "assignment-main-L1");

    // Closing L1 must satisfy FC1 and therefore make L2 dispatchable.
    let after_l1 = fixture.complete_lane(&mut state, &first, "l1");
    assert_eq!(
        after_l1.kind, "spawn",
        "closing L1 must satisfy FC1 and dispatch L2, not deadlock: {after_l1:?}"
    );
    let next = spawn_payload(after_l1);
    assert_eq!(next.action.assignment_id.0, "assignment-main-L2");

    // The gate must be recorded as real evidence in the event log.
    let events = fs::read_to_string(&fixture.event_path).expect("events");
    assert!(events.contains("gate:unit-complete:U1"), "events: {events}");
}

/// A lane with a LIVE implementer binding must never be dispatched twice.
///
/// The exclusion that must do this work is `lane_has_live_delivery`, which is derived
/// from the runner invocation log (an implementer binding for the lane that is not yet
/// terminal-consumed). That signal is independent of the dispatch path and self-clears
/// when the attempt becomes terminal, so it can represent *temporary* liveness in an
/// append-only fold. A permanent `unit-active:` latch deliberately does NOT exist: in a
/// fold that never removes refs it could never be cleared, permanently bricking any lane
/// whose attempt ended without closing its unit.
///
/// This asserts the DISPATCH DECISION itself, not an incidental downstream error.
#[test]
fn active_lane_is_never_redispatched() {
    let _guard = CWD_LOCK.lock().expect("cwd lock");
    let fixture = AdvanceFixture::new("active-exclusion", 2, true);
    let mut state = fixture.state();

    let first = send_command(&mut state, "autopilot main");
    assert_eq!(first.kind, "spawn", "first advance must dispatch L1");
    assert_eq!(fixture.count_agent_spawns("assignment-main-L1"), 1);

    // L1's delivery is live. A second advance must NOT dispatch anything, and must
    // report Waiting (work is genuinely in flight) rather than Stuck.
    let again = send_command(&mut state, "autopilot main");
    assert_eq!(
        again.kind, "done",
        "must not spawn while L1 delivery is live: {again:?}"
    );
    let status = done_status(&again);
    // A dispatch must not even be ATTEMPTED. If the exclusion is broken the run tries to
    // re-issue L1 and dies downstream (e.g. a dirty delivery worktree); that is a
    // second-order symptom, so name it explicitly rather than letting it masquerade as
    // an unrelated driver error.
    assert!(
        !status.contains("driver-error"),
        "second advance must not attempt a dispatch while L1 is live: {status}"
    );
    assert!(status.contains("dispatch:waiting"), "status: {status}");
    assert!(!status.contains("dispatch-stuck"), "status: {status}");
    assert!(
        status.contains("active_implementers=1"),
        "the live implementer must be what holds the run open: {status}"
    );
    assert_eq!(
        fixture.count_agent_spawns("assignment-main-L1"),
        1,
        "L1 must never be dispatched twice"
    );

    // No permanent liveness latch may be reintroduced: it cannot be cleared by an
    // append-only fold and would brick the lane forever.
    let events = fs::read_to_string(&fixture.event_path).expect("events");
    assert!(!events.contains("unit-active:"), "events: {events}");
    assert!(!events.contains("lane-active:"), "events: {events}");
}

struct AdvanceFixture {
    root: PathBuf,
    event_path: PathBuf,
    previous: PathBuf,
}

struct CompletedLane {
    response: SeamEnvelope,
    task_id: String,
    validation_action_id: String,
    validation_assignment_id: String,
}

impl AdvanceFixture {
    fn new(name: &str, units: usize, block_after_first: bool) -> Self {
        let root = temp_repo(name);
        fs::write(root.join("README.md"), "advance fixture\n").expect("readme");
        git_init(&root);
        write_approved_plan(&root, units, block_after_first);
        configure_runner_env();
        let previous = std::env::current_dir().expect("cwd");
        std::env::set_current_dir(&root).expect("chdir fixture");
        let event_path = root.join(".pi/autopilot/events.jsonl");
        Self {
            root,
            event_path,
            previous,
        }
    }

    fn state(&self) -> CoreState {
        CoreState::open(Some(self.event_path.clone())).expect("state")
    }

    fn complete_lane(
        &self,
        state: &mut CoreState,
        delivery_spawn: &CoreToHostSpawnPayload,
        label: &str,
    ) -> SeamEnvelope {
        self.complete_lane_with_terminal(state, delivery_spawn, label)
            .response
    }

    fn complete_lane_with_terminal(
        &self,
        state: &mut CoreState,
        delivery_spawn: &CoreToHostSpawnPayload,
        label: &str,
    ) -> CompletedLane {
        let delivery_spec = self.delivery_spec(delivery_spawn);
        let worktree = PathBuf::from(delivery_spec["worktree"].as_str().expect("worktree"));
        let changed_path = format!("{label}.txt");
        fs::write(
            worktree.join(&changed_path),
            format!("advance fixture changed by {label}\n"),
        )
        .expect("worktree edit");
        let carrier_path = PathBuf::from(delivery_spec["carrier_path"].as_str().expect("carrier"));
        fs::create_dir_all(carrier_path.parent().expect("carrier parent")).expect("carrier dir");
        fs::write(
            &carrier_path,
            serde_json::to_vec_pretty(&delivery_carrier(&delivery_spec, &changed_path))
                .expect("delivery carrier"),
        )
        .expect("delivery carrier write");

        let validation = send_task_completed(
            state,
            &format!("task-delivery-{label}"),
            &delivery_spawn.action.action_id.0,
            &delivery_spawn.action.assignment_id.0,
        );
        assert_eq!(
            validation.kind, "spawn",
            "validation response: {validation:?}"
        );
        let validation_spawn = spawn_payload(validation);
        let validation_spec = self.validation_spec(&worktree, &validation_spawn);
        let validation_carrier_path = PathBuf::from(
            validation_spec["carrier_path"]
                .as_str()
                .expect("validation carrier"),
        );
        fs::create_dir_all(
            validation_carrier_path
                .parent()
                .expect("validation carrier parent"),
        )
        .expect("validation carrier dir");
        fs::write(
            &validation_carrier_path,
            serde_json::to_vec_pretty(&validation_carrier(&validation_spec))
                .expect("validation carrier"),
        )
        .expect("validation carrier write");

        let task_id = format!("task-validation-{label}");
        let response = send_task_completed(
            state,
            &task_id,
            &validation_spawn.action.action_id.0,
            &validation_spawn.action.assignment_id.0,
        );
        CompletedLane {
            response,
            task_id,
            validation_action_id: validation_spawn.action.action_id.0,
            validation_assignment_id: validation_spawn.action.assignment_id.0,
        }
    }

    fn delivery_spec(&self, spawn: &CoreToHostSpawnPayload) -> serde_json::Value {
        let lane = spawn
            .action
            .assignment_id
            .0
            .rsplit('-')
            .next()
            .expect("lane suffix");
        let path = self.root.join(format!(
            ".pi/autopilot/main/worktrees/{lane}/.pi/autopilot/runner/specs/{}.json",
            spawn.action.assignment_id.0
        ));
        serde_json::from_slice(&fs::read(path).expect("delivery spec")).expect("delivery spec json")
    }

    fn validation_spec(
        &self,
        worktree: &Path,
        spawn: &CoreToHostSpawnPayload,
    ) -> serde_json::Value {
        let path = worktree.join(format!(
            ".pi/autopilot/main/validation/{}/agent-run-spec.json",
            spawn.action.assignment_id.0
        ));
        serde_json::from_slice(&fs::read(path).expect("validation spec"))
            .expect("validation spec json")
    }

    fn count_agent_spawns(&self, assignment_id: &str) -> usize {
        let text = fs::read_to_string(&self.event_path).unwrap_or_default();
        text.lines()
            .filter_map(|line| serde_json::from_str::<EventRow>(line).ok())
            .filter(|event| event.kind.0 == "agent:spawn")
            .filter(|event| {
                event
                    .artifact_refs
                    .iter()
                    .any(|reference| reference.0 == assignment_id)
            })
            .count()
    }
}

impl Drop for AdvanceFixture {
    fn drop(&mut self) {
        let _ = std::env::set_current_dir(&self.previous);
    }
}

fn write_approved_plan(root: &Path, units: usize, block_after_first: bool) {
    let rows = (1..=units)
        .map(|index| {
            let dependencies = if !block_after_first || index == 1 {
                Vec::<String>::new()
            } else {
                vec![format!("U{}", index - 1)]
            };
            let predecessor_forward_criteria = if block_after_first && index > 1 {
                vec![format!("unit-complete:U{}", index - 1)]
            } else {
                Vec::new()
            };
            serde_json::json!({
                "id": format!("U{index}"),
                "kind": "implementation",
                "objective": format!("deliver U{index}"),
                "operator_order": index,
                "decisions": [],
                "criteria": [format!("AC{index}")],
                "criterion_text": [{"id": format!("AC{index}"), "text": format!("criterion text {index}")}],
                "dependencies": dependencies,
                "predecessor_forward_criteria": predecessor_forward_criteria,
                "downstream_release_edges": [format!("EDGE{index}")],
                "files": [format!("l{index}.txt")],
                "commands": [{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],
                "package_checks": []
            })
        })
        .collect::<Vec<_>>();
    let repo_authority =
        runner::repository_authority_binding(root, "main").expect("repo authority");
    let dir = root.join(".pi/autopilot/main");
    fs::create_dir_all(&dir).expect("plan dir");
    fs::write(
        dir.join("approved-plan.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "repository_authority": {
                "manifest_path": repo_authority.path,
                "manifest_digest": repo_authority.digest,
                "head_commit": repo_authority.manifest.head_commit,
                "head_tree": repo_authority.manifest.head_tree,
            },
            "units": rows
        }))
        .expect("plan json"),
    )
    .expect("approved plan");
}

fn delivery_carrier(spec: &serde_json::Value, changed_path: &str) -> serde_json::Value {
    let typed: kernel::generated::AgentRunSpec =
        serde_json::from_value(spec.clone()).expect("delivery spec");
    let profile = kernel::generated::TERMINAL_PROFILES
        .iter()
        .find(|row| row.0 == "delivery-status.v2")
        .expect("delivery profile");
    let mut submission = serde_json::json!({
        "actual_changed_paths": [changed_path],
        "execution_audit_ref": "audit:delivery",
        "focused_evidence_refs": ["evidence:0", "evidence:1"],
        "terminal_status": "succeeded",
        "hard_boundary_violations": []
    });
    if spec["role_id"] == "recovery-engineer" {
        submission["recovery_disposition"] = serde_json::json!("repaired");
    }
    let submission_digest = sha256_hex(&serde_json::to_vec(&submission).expect("submission"));
    let binding = drivers::runner::child::carrier_binding(&typed);
    let tool_call_id = "delivery-tool-call-advance";
    let audit = serde_json::json!({"schema":"autopilot.tool_audit.v1","tool_call_id":tool_call_id,"profile_id":profile.0,"tool_name":profile.1,"boundary_id":profile.2,"result_contract":profile.3,"schema_digest":profile.4,"binding":binding,"submission_digest":submission_digest,"delivery_policy":{"version":drivers::runner::DELIVERY_POLICY_VERSION,"assignment_path":typed.assignment_path.as_ref().expect("assignment path").0.clone(),"assignment_digest":typed.assignment_digest.as_ref().expect("assignment digest").0.clone(),"worktree":typed.worktree.as_ref().expect("worktree").0.clone(),"cwd":typed.cwd.0.clone(),"policy_digest":drivers::runner::delivery_policy_digest(&typed.assignment_path.as_ref().expect("assignment path").0,&typed.assignment_digest.as_ref().expect("assignment digest").0,&typed.worktree.as_ref().expect("worktree").0,&typed.cwd.0),"active_overrides":["bash","edit","write"],"denials":{"schema":"autopilot.delivery_policy_denials.v1","overflowed":false,"entries":[]}}});
    let audit_bytes = serde_json::to_vec_pretty(&audit).expect("audit");
    let audit_path = PathBuf::from(spec["carrier_path"].as_str().expect("carrier"))
        .with_extension("tool-audit.json");
    fs::write(&audit_path, &audit_bytes).expect("audit write");
    let spec_bytes =
        fs::read_to_string(spec["spec_path"].as_str().expect("spec path")).expect("spec bytes");
    serde_json::json!({
        "schema":"autopilot.delivery_result.v2",
        "assignment_id":spec["assignment_id"],
        "role_id":spec["role_id"],
        "mode":spec["mode"],
        "run_revision":spec["run_revision"],
        "workstream":spec["workstream"],
        "lane_id":spec["lane_id"],
        "attempt":spec["attempt"],
        "base_commit":spec["base_commit"],
        "worktree":spec["worktree"],
        "action_id":spec["action_id"],
        "prompt_path":spec["prompt_path"],
        "prompt_digest":spec["prompt_digest"],
        "spec_path":spec["spec_path"],
        "spec_digest":sha256_hex(spec_bytes.as_bytes()),
        "spec_bytes":spec_bytes,
        "carrier_path":spec["carrier_path"],
        "boundary_id":spec["boundary_id"],
        "boundary_digest":spec["boundary_digest"],
        "result_contract":spec["result_contract"],
        "result_contract_digest":spec["result_contract_digest"],
        "settings_digest":spec["settings_digest"],
        "context_digest":spec["context_digest"],
        "skills_digest":spec["skills_digest"],
        "subscription_digest":spec["subscription_digest"],
        "runtime_extension_digest":spec["runtime_extension_digest"],
        "terminal_profile_id":profile.0,
        "tool_name":profile.1,
        "tool_schema_digest":profile.4,
        "carrier_binding":binding,
        "tool_call_id":tool_call_id,
        "tool_audit_ref":audit_path.display().to_string(),
        "tool_audit_digest":sha256_hex(&audit_bytes),
        "submission_digest":submission_digest,
        "submission":submission
    })
}

fn validation_carrier(spec: &serde_json::Value) -> serde_json::Value {
    validation_carrier_with_outcome(spec, false, "source-defect")
}

fn validation_blocked_carrier(spec: &serde_json::Value) -> serde_json::Value {
    validation_carrier_with_outcome(spec, true, "source-defect")
}

fn validation_blocked_carrier_with_kind(
    spec: &serde_json::Value,
    finding_kind: &str,
) -> serde_json::Value {
    validation_carrier_with_outcome(spec, true, finding_kind)
}

fn validation_carrier_with_outcome(
    spec: &serde_json::Value,
    blocked: bool,
    finding_kind: &str,
) -> serde_json::Value {
    let typed: kernel::generated::AgentRunSpec =
        serde_json::from_value(spec.clone()).expect("validation spec");
    let assignment_path = PathBuf::from(spec["assignment_path"].as_str().expect("assignment"));
    let assignment_bytes = fs::read(&assignment_path).expect("assignment bytes");
    let assignment: kernel::generated::ValidationAssignmentV2 =
        serde_json::from_slice(&assignment_bytes).expect("assignment json");
    let context_path = PathBuf::from(
        spec["context_manifest_path"]
            .as_str()
            .expect("context manifest"),
    );
    let context_bytes = fs::read(&context_path).expect("context bytes");
    let context: kernel::generated::ValidationContextV2 =
        serde_json::from_slice(&context_bytes).expect("context json");
    let evidence_ref = context
        .evidence
        .first()
        .expect("validation evidence")
        .evidence_ref
        .0
        .clone();
    let criterion_results = context
        .criteria
        .iter()
        .enumerate()
        .map(|(index, criterion)| {
            serde_json::json!({
                "criterion_id": criterion.criterion_id,
                "verdict": if blocked && index == 0 { "FAIL" } else { "PASS" },
                "evidence_refs": [evidence_ref],
                "finding_ids": if blocked && index == 0 { vec!["finding-validation-1"] } else { Vec::<&str>::new() },
                "covered_paths": criterion.covered_paths,
                "semantic_surface_ids": criterion.semantic_surface_ids,
                "forward_edge_ids": criterion.forward_edge_ids
            })
        })
        .collect::<Vec<_>>();
    let findings = if blocked {
        let criterion = context.criteria.first().expect("blocked criterion");
        vec![serde_json::json!({
            "finding_id":"finding-validation-1",
            "kind":finding_kind,
            "effect":"forward-blocking",
            "summary":"issued scope defect",
            "detail":"the exact issued criterion requires a surgical source repair",
            "criterion_ids":[criterion.criterion_id],
            "edge_ids":criterion.forward_edge_ids,
            "evidence_refs":[evidence_ref],
            "covered_paths":criterion.covered_paths,
            "semantic_surface_ids":criterion.semantic_surface_ids
        })]
    } else {
        Vec::new()
    };
    let submission = serde_json::json!({
        "schema":"autopilot.validation_submission.v2",
        "validation_id": assignment.validation_id,
        "assignment_id": assignment.assignment_id,
        "scope": assignment.scope,
        "exact_commit": assignment.exact_commit,
        "exact_tree": assignment.exact_tree,
        "outcome":if blocked { "BLOCKED" } else { "FORWARD_READY" },
        "criterion_results": criterion_results,
        "findings": findings
    });
    let typed_submission: kernel::generated::ValidationSubmissionV2 =
        serde_json::from_value(submission.clone()).expect("typed submission");
    drivers::runner::child::admit_validation_submission(&typed, &typed_submission)
        .expect("admitted validation submission");
    let submission_digest = sha256_hex(&serde_json::to_vec(&submission).expect("submission"));
    let profile = kernel::generated::TERMINAL_PROFILES
        .iter()
        .find(|row| row.0 == "validation-status.v2")
        .expect("validation profile");
    let binding = drivers::runner::child::carrier_binding(&typed);
    let tool_call_id = "validation-tool-call-advance";
    let audit = serde_json::json!({"schema":"autopilot.tool_audit.v1","tool_call_id":tool_call_id,"profile_id":profile.0,"tool_name":profile.1,"boundary_id":profile.2,"result_contract":profile.3,"schema_digest":profile.4,"binding":binding,"submission_digest":submission_digest});
    let audit_bytes = serde_json::to_vec_pretty(&audit).expect("audit");
    let audit_path = PathBuf::from(spec["carrier_path"].as_str().expect("carrier"))
        .with_extension("tool-audit.json");
    fs::write(&audit_path, &audit_bytes).expect("audit write");
    let spec_bytes =
        fs::read_to_string(spec["spec_path"].as_str().expect("spec path")).expect("spec bytes");
    serde_json::json!({
        "schema":"autopilot.validation_result.v2",
        "action_id":spec["action_id"],
        "assignment_id":spec["assignment_id"],
        "validation_id": assignment.validation_id,
        "validation_key": assignment.validation_key,
        "validation_attempt": assignment.validation_attempt,
        "semantic_round": assignment.semantic_round,
        "run_revision":spec["run_revision"],
        "workstream":spec["workstream"],
        "role_id":spec["role_id"],
        "mode":spec["mode"],
        "producer_assignment_ids": assignment.producer_assignment_ids,
        "exact_commit": assignment.exact_commit,
        "exact_tree": assignment.exact_tree,
        "assignment_path": spec["assignment_path"],
        "assignment_digest": sha256_hex(&assignment_bytes),
        "context_manifest_path": spec["context_manifest_path"],
        "context_manifest_digest": sha256_hex(&context_bytes),
        "prompt_path":spec["prompt_path"],
        "prompt_digest":spec["prompt_digest"],
        "spec_path":spec["spec_path"],
        "spec_digest":sha256_hex(spec_bytes.as_bytes()),
        "spec_bytes":spec_bytes,
        "carrier_path":spec["carrier_path"],
        "boundary_id":spec["boundary_id"],
        "boundary_digest":spec["boundary_digest"],
        "result_contract":spec["result_contract"],
        "result_contract_digest":spec["result_contract_digest"],
        "settings_digest":spec["settings_digest"],
        "skills_digest":spec["skills_digest"],
        "subscription_digest":spec["subscription_digest"],
        "runtime_extension_digest":spec["runtime_extension_digest"],
        "terminal_profile_id":profile.0,
        "tool_name":profile.1,
        "tool_schema_digest":profile.4,
        "carrier_binding":binding,
        "tool_call_id":tool_call_id,
        "tool_audit_ref":audit_path.display().to_string(),
        "tool_audit_digest":sha256_hex(&audit_bytes),
        "submission_digest":submission_digest,
        "submission":submission
    })
}

fn configure_runner_env() {
    unsafe {
        std::env::set_var(
            "AUTOPILOT_NODE_EXECUTABLE",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_AGENT_RUNNER_WRAPPER",
            std::env::current_exe().expect("exe"),
        );
        std::env::set_var(
            "AUTOPILOT_CHILD_ADDON_PATH",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/child-extension.ts"),
        );
        std::env::set_var(
            "AUTOPILOT_VALIDATOR_COMMAND",
            std::env::current_exe().expect("exe"),
        );
    }
}

fn send_command(state: &mut CoreState, raw: &str) -> SeamEnvelope {
    let frame = serde_json::json!({"v":1,"id":1,"kind":"command","payload":{"raw":raw,"background_capabilities":{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true}}});
    send_frame(state, frame)
}

fn send_task_completed(
    state: &mut CoreState,
    task_id: &str,
    action_id: &str,
    assignment_id: &str,
) -> SeamEnvelope {
    send_frame(
        state,
        serde_json::json!({"v":1,"id":2,"kind":"task-completed","payload":{"task_id":task_id,"action_id":action_id,"assignment_id":assignment_id,"status":"completed"}}),
    )
}

fn send_frame(state: &mut CoreState, frame: serde_json::Value) -> SeamEnvelope {
    seam::handle_line(&frame.to_string(), state).expect("handle line")
}

fn spawn_payload(envelope: SeamEnvelope) -> CoreToHostSpawnPayload {
    assert_eq!(envelope.kind, "spawn", "response: {envelope:?}");
    serde_json::from_value(envelope.payload).expect("spawn payload")
}

fn done_status(envelope: &SeamEnvelope) -> String {
    let payload: CoreToHostDonePayload =
        serde_json::from_value(envelope.payload.clone()).expect("done payload");
    payload.status
}

fn git_init(root: &Path) {
    run(root, &["init"]);
    run(root, &["config", "user.email", "advance@example.invalid"]);
    run(root, &["config", "user.name", "Advance Fixture"]);
    fs::write(root.join(".gitignore"), ".pi/autopilot/\n.pi/tasks/\n").expect("gitignore");
    run(root, &["add", "."]);
    run(root, &["commit", "-m", "fixture"]);
}

fn run(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .status()
        .expect("git");
    assert!(status.success(), "git {:?} failed", args);
}

fn git_out(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .expect("git output");
    assert!(output.status.success(), "git {:?} failed", args);
    String::from_utf8(output.stdout)
        .expect("git utf8")
        .trim()
        .to_owned()
}

fn temp_repo(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("pi-autopilot-advance-{name}-{nanos}"));
    fs::create_dir_all(&root).expect("temp root");
    fs::canonicalize(&root).expect("canonical temp root")
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
