use super::SemanticRecoveryPolicy;

#[test]
fn package_semantic_recovery_is_one_attempt_same_gate() {
    assert_eq!(
        SemanticRecoveryPolicy::package().expect("package policy"),
        SemanticRecoveryPolicy { max_attempts: 1 }
    );
}

#[test]
fn semantic_recovery_rejects_loop_or_weakened_gate() {
    for source in [
        concat!(
            "semantic_recovery scope=\"typed-model-rejection\" max_attempts=2 ",
            "revalidation=\"same-gate\" exhaustion=\"paused-operator-decision\" ",
            "session=\"fresh-recovery-assignment\""
        ),
        concat!(
            "semantic_recovery scope=\"typed-model-rejection\" max_attempts=1 ",
            "revalidation=\"weaker-gate\" exhaustion=\"paused-operator-decision\" ",
            "session=\"fresh-recovery-assignment\""
        ),
        concat!(
            "semantic_recovery scope=\"all-failures\" max_attempts=1 ",
            "revalidation=\"same-gate\" exhaustion=\"paused-operator-decision\" ",
            "session=\"fresh-recovery-assignment\""
        ),
    ] {
        assert!(SemanticRecoveryPolicy::parse(source).is_err());
    }
}
