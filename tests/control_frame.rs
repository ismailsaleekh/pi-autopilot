use drivers::control::{
    ControlFrameDocument, ControlObservation, ControlPolicy, FrameInput, TaskStatus,
};
use kernel::generated::{
    ActionKind, BackgroundAction, BackgroundActionBgRun, Bytes, ControlFrameCounts, Id, Nullable,
    Ref, SupersessionState, TriggerKind, Uuidv7,
};
use serde_json::Value;

#[test]
fn control_data_declares_d76_actions_and_timeouts() {
    let policy = ControlPolicy::package().expect("control.kdl parses");

    assert_eq!(
        policy.action_kinds,
        vec![
            "launch-background",
            "reconcile-background",
            "read-failure-log",
            "stop-background",
            "request-operator",
            "return-idle",
        ]
    );
    assert_eq!(policy.focused_timeout.0, "30m");
    assert_eq!(policy.integration_timeout.0, "30m");
    assert_eq!(policy.final_suite_timeout.0, "4h");
    assert_eq!(policy.handoff_timeout.0, "2m");
}

#[test]
fn d76_control_frame_fields_are_present() {
    let frame = ControlFrameDocument::build(FrameInput {
        frame_id: Uuidv7("01890f9e-0000-7000-8000-000000000001".to_owned()),
        run_id: Uuidv7("01890f9e-0000-7000-8000-000000000002".to_owned()),
        run_revision: 42,
        trigger_kind: TriggerKind("background-completed".to_owned()),
        trigger_refs: vec![Ref("action-1".to_owned())],
        counts: ControlFrameCounts {
            implementers: 5,
            validators: 2,
            fixers: 1,
            deterministic_jobs: 1,
            queued_candidates: 2,
        },
        observations: vec![ControlObservation::BackgroundTask {
            task_id: Id("task-1".to_owned()),
            status: TaskStatus::Completed,
        }],
        actions: vec![action("action-2", "assignment-2", "echo ok")],
        next_watchdog_at: Nullable(None),
    });

    let value = serde_json::to_value(frame.as_generated()).expect("frame serializes");
    let object = value.as_object().expect("frame object");
    for key in [
        "schema",
        "frame_id",
        "run_id",
        "run_revision",
        "trigger",
        "counts",
        "observations",
        "actions",
        "next_watchdog_at",
        "return_to_idle",
    ] {
        assert!(object.contains_key(key), "missing {key}");
    }
    assert_eq!(
        value["schema"],
        Value::String("autopilot.control_frame.v1".to_owned())
    );
    assert_eq!(value["trigger"]["kind"], "background-completed");
    assert_eq!(value["counts"]["implementers"], 5);
}

#[test]
fn observations_are_structurally_bounded() {
    let frame = ControlFrameDocument::build(FrameInput {
        frame_id: Uuidv7("01890f9e-0000-7000-8000-000000000003".to_owned()),
        run_id: Uuidv7("01890f9e-0000-7000-8000-000000000004".to_owned()),
        run_revision: 7,
        trigger_kind: TriggerKind("background-failed".to_owned()),
        trigger_refs: Vec::new(),
        counts: ControlFrameCounts {
            implementers: 0,
            validators: 0,
            fixers: 0,
            deterministic_jobs: 0,
            queued_candidates: 0,
        },
        observations: vec![ControlObservation::BackgroundTask {
            task_id: Id("task-2".to_owned()),
            status: TaskStatus::Failed,
        }],
        actions: Vec::new(),
        next_watchdog_at: Nullable(None),
    });
    let value = serde_json::to_value(frame.as_generated()).expect("frame serializes");
    let observation = value["observations"][0]
        .as_object()
        .expect("bounded observation");
    for forbidden in [
        "diff",
        "transcript",
        "log",
        "plan_prose",
        "test_output",
        "reasoning",
    ] {
        assert!(
            !observation.contains_key(forbidden),
            "forbidden {forbidden}"
        );
    }
    assert_eq!(observation.len(), 3);
}

#[test]
fn return_to_idle_is_true_when_no_actions_remain() {
    let frame = ControlFrameDocument::build(FrameInput {
        frame_id: Uuidv7("01890f9e-0000-7000-8000-000000000005".to_owned()),
        run_id: Uuidv7("01890f9e-0000-7000-8000-000000000006".to_owned()),
        run_revision: 8,
        trigger_kind: TriggerKind("watchdog".to_owned()),
        trigger_refs: Vec::new(),
        counts: ControlFrameCounts {
            implementers: 0,
            validators: 0,
            fixers: 0,
            deterministic_jobs: 0,
            queued_candidates: 0,
        },
        observations: Vec::new(),
        actions: Vec::new(),
        next_watchdog_at: Nullable(None),
    });
    assert!(frame.as_generated().return_to_idle);
}

fn action(action_id: &str, assignment_id: &str, command: &str) -> BackgroundAction {
    BackgroundAction {
        action_id: Id(action_id.to_owned()),
        assignment_id: Id(assignment_id.to_owned()),
        kind: ActionKind::LaunchBackground,
        bg_run: BackgroundActionBgRun {
            name: "demo".to_owned(),
            command: Bytes(command.to_owned()),
            is_agent: false,
            timeout_seconds: Some(1800),
            notify_on_completion: true,
            trigger_on_completion: true,
        },
        run_revision: 42,
        expires_at: None,
        supersession_state: SupersessionState("live".to_owned()),
    }
}
