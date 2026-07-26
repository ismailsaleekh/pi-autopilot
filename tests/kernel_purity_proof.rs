use drivers::sim::SimPlatform;
use kernel::effect::{
    ActionId, CommandBytes, Effect, Label, LaunchBackground, LogId, OperatorMessage, TaskId,
};
use kernel::platform::Platform;

fn small_step(seed: u64) -> Vec<Effect> {
    let mut platform = SimPlatform::new(seed);
    let first = platform.entropy().next();
    platform.advance(3);
    let second = platform.entropy().next();
    let mark = platform.clock().read();

    let effects = vec![
        Effect::LaunchBackground(LaunchBackground {
            action: ActionId(first),
            name: Label(b"unit".to_vec()),
            command: CommandBytes(first.to_le_bytes().to_vec()),
            agent: true,
            timeout_secs: 1_800,
            trigger_on_completion: true,
        }),
        Effect::ReconcileBackground(TaskId(second)),
        Effect::ReadFailureLog(LogId(mark.0)),
        Effect::StopBackground(TaskId(first ^ second)),
        Effect::RequestOperator(OperatorMessage(second.to_le_bytes().to_vec())),
        Effect::ReturnIdle,
    ];

    for effect in effects {
        platform.apply(effect);
    }

    platform.effects().to_vec()
}

fn bytes(effects: &[Effect]) -> Vec<u8> {
    format!("{effects:?}").into_bytes()
}

fn effect_kind(effect: &Effect) -> &'static str {
    match effect {
        Effect::LaunchBackground(_) => "launch-background",
        Effect::ReconcileBackground(_) => "reconcile-background",
        Effect::ReadFailureLog(_) => "read-failure-log",
        Effect::StopBackground(_) => "stop-background",
        Effect::RequestOperator(_) => "request-operator",
        Effect::ReturnIdle => "return-idle",
    }
}

#[test]
fn same_seed_same_effect_bytes() {
    let left = bytes(&small_step(11));
    let right = bytes(&small_step(11));
    assert_eq!(left, right);
}

#[test]
fn different_seed_different_effect_bytes() {
    let left = bytes(&small_step(11));
    let right = bytes(&small_step(12));
    assert_ne!(left, right);
}

#[test]
fn effect_has_no_no_op_variant() {
    let effects = small_step(11);
    let kinds: Vec<&'static str> = effects.iter().map(effect_kind).collect();
    assert_eq!(
        kinds,
        vec![
            "launch-background",
            "reconcile-background",
            "read-failure-log",
            "stop-background",
            "request-operator",
            "return-idle",
        ]
    );
}
