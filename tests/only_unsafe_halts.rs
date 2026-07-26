use kernel::failure::{
    EvidenceDisposition, Failure, HardBoundary, OperationDisposition, OperatorDecision,
    ProcessDisposition, RecoveryRoute, RetryPolicy,
};

#[test]
fn only_unsafe_stops_its_operation() {
    let non_stopping = [
        Failure::Transient {
            retry: RetryPolicy::Backoff,
        },
        Failure::Recoverable {
            route: RecoveryRoute::Tier1,
        },
        Failure::Paused {
            needs: OperatorDecision::ChooseAfterExhaustion,
        },
    ];

    for failure in non_stopping {
        let supervision = failure.supervision();
        assert_eq!(supervision.process, ProcessDisposition::Continue);
        assert_eq!(supervision.operation, OperationDisposition::Continue);
        assert_eq!(supervision.evidence, EvidenceDisposition::Preserve);
    }

    let boundary = HardBoundary::MeteredFrontierRoute;
    let supervision = Failure::Unsafe { boundary }.supervision();
    assert_eq!(supervision.process, ProcessDisposition::Continue);
    assert_eq!(supervision.operation, OperationDisposition::Halt(boundary));
    assert_eq!(supervision.evidence, EvidenceDisposition::Preserve);
}

#[test]
fn failure_match_has_no_do_nothing_arm() {
    let failures = [
        Failure::Transient {
            retry: RetryPolicy::Immediate,
        },
        Failure::Recoverable {
            route: RecoveryRoute::Tier2,
        },
        Failure::Paused {
            needs: OperatorDecision::ReissueDecision,
        },
        Failure::Unsafe {
            boundary: HardBoundary::UnsafeCleanup,
        },
    ];

    for failure in failures {
        let variant = match failure {
            Failure::Transient { retry } => {
                let _ = retry;
                "Transient"
            }
            Failure::Recoverable { route } => {
                let _ = route;
                "Recoverable"
            }
            Failure::Paused { needs } => {
                let _ = needs;
                "Paused"
            }
            Failure::Unsafe { boundary } => {
                let _ = boundary;
                "Unsafe"
            }
        };
        assert_ne!(variant, "Noop");
        assert_ne!(variant, "Ignore");
    }
}
