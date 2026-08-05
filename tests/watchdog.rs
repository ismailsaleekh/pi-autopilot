use drivers::watchdog::WatchdogConfig;
use kernel::{effect::Effect, generated::Id};

#[test]
fn watchdog_arms_from_data_as_one_heartbeat_wait() {
    let config = WatchdogConfig::package().expect("control.kdl watchdog config");
    let action = config
        .arm_action(true, false, Id("wd-1".to_owned()), 11)
        .expect("work arms watchdog");

    assert_eq!(config.minutes, 25);
    assert_eq!(
        action.bg_run.command.0,
        "autopilot-heartbeat-wait --minutes 25"
    );
    assert!(!action.bg_run.is_agent);
    assert!(action.bg_run.notify_on_completion);
    assert!(!action.bg_run.trigger_on_completion);
    assert!(
        config
            .arm_action(true, true, Id("wd-2".to_owned()), 11)
            .is_none()
    );
    assert!(
        config
            .arm_action(false, false, Id("wd-3".to_owned()), 11)
            .is_none()
    );
}

#[test]
fn watchdog_fires_once_and_rearms_while_work_remains() {
    let config = WatchdogConfig::package().expect("control.kdl watchdog config");
    let turn = config.completed_turn(true, Id("wd-next".to_owned()), 12);

    let reconciles = turn
        .effects
        .iter()
        .filter(|effect| matches!(effect, Effect::ReconcileBackground(_)))
        .count();
    let launches = turn
        .effects
        .iter()
        .filter(|effect| matches!(effect, Effect::LaunchBackground(_)))
        .count();

    assert_eq!(reconciles, 1);
    assert_eq!(launches, 1);
}

#[test]
fn watchdog_has_no_semantic_authority() {
    let config = WatchdogConfig::package().expect("control.kdl watchdog config");
    let turn = config.completed_turn(true, Id("wd-next".to_owned()), 12);
    let before = SemanticState {
        run: "executing".to_owned(),
        lane: "implementing".to_owned(),
    };
    let after = apply_nonsemantic_watchdog_effects(before.clone(), &turn.effects);

    assert!(!turn.has_semantic_authority());
    assert_eq!(after, before);
    assert!(turn.effects.iter().all(|effect| matches!(
        effect,
        Effect::ReconcileBackground(_) | Effect::LaunchBackground(_)
    )));
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SemanticState {
    run: String,
    lane: String,
}

fn apply_nonsemantic_watchdog_effects(state: SemanticState, effects: &[Effect]) -> SemanticState {
    for effect in effects {
        match effect {
            Effect::ReconcileBackground(_) | Effect::LaunchBackground(_) => {}
            Effect::ReadFailureLog(_)
            | Effect::StopBackground(_)
            | Effect::RequestOperator(_)
            | Effect::ReturnIdle => {
                return SemanticState {
                    run: "changed".to_owned(),
                    lane: "changed".to_owned(),
                };
            }
        }
    }
    state
}
