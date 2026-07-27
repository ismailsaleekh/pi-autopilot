use drivers::control::{BgRunCall, BgRunGuard, GuardOutcome, GuardRejection};
use kernel::{
    effect::Effect,
    failure::{Failure, HardBoundary},
    generated::{ActionKind, BackgroundAction, Bytes, Duration, Id, SupersessionState},
};

#[test]
fn exact_issued_bytes_are_admitted() {
    let issued = action("act-1", "assign-1", "printf ready");
    let mut guard = BgRunGuard::new(vec![issued.clone()]);
    let mut process = FakeProcess::default();

    let outcome = guard
        .admit(&call("printf ready"))
        .expect("exact launch admitted");
    process.apply(outcome);

    assert_eq!(process.accepted_work, 1);
    assert_eq!(process.effects, vec![Effect::LaunchBackground(issued)]);
}

#[test]
fn one_byte_different_command_is_blocked_and_nothing_runs() {
    let issued = action("act-2", "assign-2", "printf ready");
    let mut guard = BgRunGuard::new(vec![issued.clone()]);
    let process = FakeProcess::default();

    let rejection = guard
        .admit(&call("printf reedy"))
        .expect_err("one byte differs");

    assert!(matches!(rejection, GuardRejection::Mismatch { valid } if *valid == issued));
    assert_eq!(process.accepted_work, 0);
    assert!(process.effects.is_empty());
}

#[test]
fn unissued_bg_run_is_unsafe_and_nothing_runs() {
    let mut guard = BgRunGuard::new(Vec::new());
    let process = FakeProcess::default();

    let rejection = guard
        .admit(&call("printf ready"))
        .expect_err("unissued launch blocked");

    assert!(matches!(
        rejection,
        GuardRejection::Unsafe {
            failure: Failure::Unsafe {
                boundary: HardBoundary::UnissuedBackgroundLaunch
            }
        }
    ));
    assert_eq!(process.accepted_work, 0);
    assert!(process.effects.is_empty());
}

#[test]
fn duplicate_launch_is_idempotent_and_produces_no_second_work() {
    let issued = action("act-3", "assign-3", "printf ready");
    let mut guard = BgRunGuard::new(vec![issued]);
    let mut process = FakeProcess::default();

    let first = guard
        .admit(&call("printf ready"))
        .expect("first launch admitted");
    process.apply(first);
    let second = guard
        .admit(&call("printf ready"))
        .expect("duplicate is idempotent");
    process.apply(second);

    assert_eq!(process.accepted_work, 1);
    assert_eq!(process.effects.len(), 1);
}

#[derive(Default)]
struct FakeProcess {
    accepted_work: usize,
    effects: Vec<Effect>,
}

impl FakeProcess {
    fn apply(&mut self, outcome: GuardOutcome) {
        match outcome {
            GuardOutcome::Accepted { effect, .. } => {
                self.accepted_work += 1;
                self.effects.push(effect);
            }
            GuardOutcome::Duplicate { .. } => {}
        }
    }
}

fn call(command: &str) -> BgRunCall {
    BgRunCall {
        command_bytes: Bytes(command.to_owned()),
        display_name: "demo".to_owned(),
        is_agent: false,
        timeout: Some(Duration("30m".to_owned())),
        notify_on_completion: true,
        trigger_on_completion: true,
    }
}

fn action(action_id: &str, assignment_id: &str, command: &str) -> BackgroundAction {
    BackgroundAction {
        action_id: Id(action_id.to_owned()),
        assignment_id: Id(assignment_id.to_owned()),
        kind: ActionKind::LaunchBackground,
        command_bytes: Bytes(command.to_owned()),
        display_name: "demo".to_owned(),
        is_agent: false,
        timeout: Some(Duration("30m".to_owned())),
        notify_on_completion: true,
        trigger_on_completion: true,
        run_revision: 42,
        expires_at: None,
        supersession_state: SupersessionState("live".to_owned()),
    }
}
