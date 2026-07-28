use drivers::checkpoint::{
    compact_and_resume, observe_context, AgentHandoff, AssignmentIdentity, CheckpointInput,
    CheckpointRecord, CompactionOutcome, Compactor, ContextAction, ContextActionError,
    ContextActionOutcome, ContextBudget, ContextBudgetError, ContextDecision, ExecutionIdentity,
    HandoffSchema, PreservationEvidence, ResumeOverlay, SideEffects,
};
use kernel::failure::{Failure, HardBoundary};
use kernel::generated::{Id, Ref, Sha};
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn checkpoint_known_percent_boundaries_keep_75_85_semantics_without_integer_quantization() {
    let input = planning_input();

    assert_eq!(
        observe_context(74.9, &input).unwrap(),
        ContextDecision::Continue
    );
    assert_eq!(
        observe_context(75.0, &input).unwrap(),
        ContextDecision::SoftWarning
    );
    assert_eq!(
        observe_context(84.9, &input).unwrap(),
        ContextDecision::SoftWarning
    );

    let checkpoint = checkpoint_at(85.0, &input);
    assert_eq!(checkpoint.context_percent.as_f64(), 85.0);

    let checkpoint = checkpoint_at(100.0, &input);
    assert_eq!(checkpoint.context_percent.as_f64(), 100.0);
}

#[test]
fn checkpoint_unknown_budget_blocks_work_and_terminal_success_but_allows_typed_recovery() {
    let input = planning_input();
    let decision = observe_context(ContextBudget::Unknown, &input).unwrap();
    let overlay = resume_overlay();

    assert!(!decision.allows_new_work());
    assert!(!decision.allows_terminal_success());
    assert_eq!(
        decision.apply_action(ContextAction::StartWork),
        Err(ContextActionError::UnknownBlocksWork)
    );
    assert_eq!(
        decision.apply_action(ContextAction::ClaimTerminalSuccess),
        Err(ContextActionError::UnknownBlocksTerminalSuccess)
    );
    assert_eq!(
        decision.apply_action(ContextAction::InjectRetainedHandoff(overlay.clone())),
        Ok(ContextActionOutcome::ResumeOnly { overlay })
    );
}

#[test]
fn checkpoint_invalid_known_percent_is_loudly_rejected() {
    let input = planning_input();

    assert_eq!(
        observe_context(f64::NAN, &input),
        Err(drivers::checkpoint::CheckpointError::Budget(
            ContextBudgetError::NonFinite
        ))
    );
    assert_eq!(
        observe_context(f64::INFINITY, &input),
        Err(drivers::checkpoint::CheckpointError::Budget(
            ContextBudgetError::NonFinite
        ))
    );
    assert_eq!(
        observe_context(-0.1, &input),
        Err(drivers::checkpoint::CheckpointError::Budget(
            ContextBudgetError::Negative { percent: -0.1 }
        ))
    );
    assert_eq!(
        observe_context(100.1, &input),
        Err(drivers::checkpoint::CheckpointError::Budget(
            ContextBudgetError::AboveMaximum { percent: 100.1 }
        ))
    );
}

#[test]
fn checkpoint_planning_identity_without_lane_or_git_identity() {
    let input = planning_input();
    let checkpoint = checkpoint_at(85.0, &input);

    assert_eq!(checkpoint.assignment_id, id("plan-assignment"));
    assert_eq!(checkpoint.identity, AssignmentIdentity::Planning);
    assert_eq!(
        checkpoint.resume_overlay.assignment_id,
        id("plan-assignment")
    );
    assert_eq!(checkpoint.resume_overlay.session_ref, rf("session:plan"));
    assert_eq!(checkpoint.resume_overlay.run_revision, 11);
}

#[test]
fn checkpoint_execution_identity_keeps_git_invariants_and_models_absent_preservation() {
    let input = execution_input(PreservationEvidence::NoPreservationCommit {
        dirty_paths: vec!["drivers/src/checkpoint/mod.rs".to_owned()],
    });
    let checkpoint = checkpoint_at(85.0, &input);

    assert_eq!(
        checkpoint.identity,
        AssignmentIdentity::Execution(ExecutionIdentity {
            lane_id: id("lane-a"),
            base_commit: sha("base-real"),
            current_commit: sha("current-real"),
            preservation: PreservationEvidence::NoPreservationCommit {
                dirty_paths: vec!["drivers/src/checkpoint/mod.rs".to_owned()],
            },
        })
    );
}

#[test]
fn checkpoint_no_fabricated_commit_id_appears_in_dirty_record() {
    let input = execution_input(PreservationEvidence::NoPreservationCommit {
        dirty_paths: vec!["src/lib.rs".to_owned()],
    });
    let checkpoint = checkpoint_at(85.0, &input);

    let AssignmentIdentity::Execution(identity) = checkpoint.identity else {
        panic!("expected execution identity");
    };
    assert_eq!(identity.base_commit, sha("base-real"));
    assert_eq!(identity.current_commit, sha("current-real"));
    assert_eq!(
        identity.preservation,
        PreservationEvidence::NoPreservationCommit {
            dirty_paths: vec!["src/lib.rs".to_owned()],
        }
    );
}

#[test]
fn checkpoint_successful_compaction_resumes_same_session_with_typed_overlay() {
    let checkpoint = checkpoint_at(85.0, &planning_input());
    let mut compactor = ScriptedCompactor {
        failure: None,
        calls: 0,
    };
    let mut effects = SideEffects::default();

    let outcome = compact_and_resume(checkpoint.clone(), &mut compactor, &mut effects);

    assert_eq!(compactor.calls, 1);
    assert_eq!(
        outcome,
        CompactionOutcome::Resumed {
            overlay: checkpoint.resume_overlay
        }
    );
    assert_eq!(effects.replacement_spawned, 0);
    assert_eq!(effects.validation_started, 0);
    assert_eq!(effects.integration_started, 0);
}

#[test]
fn checkpoint_compaction_failure_preserves_concrete_cause() {
    let checkpoint = checkpoint_at(85.0, &planning_input());
    let cause = Failure::Unsafe {
        boundary: HardBoundary::EvidenceThreateningMutation,
    };
    let mut compactor = ScriptedCompactor {
        failure: Some(cause),
        calls: 0,
    };
    let mut effects = SideEffects::default();

    let outcome = compact_and_resume(checkpoint.clone(), &mut compactor, &mut effects);

    assert_eq!(compactor.calls, 1);
    assert_eq!(
        outcome,
        CompactionOutcome::Recoverable {
            checkpoint,
            failure: cause
        }
    );
    assert_eq!(effects.replacement_spawned, 0);
    assert_eq!(effects.validation_started, 0);
    assert_eq!(effects.integration_started, 0);
}

#[test]
fn checkpoint_typed_overlay_round_trips_unicode_and_retains_unknown_handoff_fields() {
    let mut critical_state = BTreeMap::new();
    critical_state.insert(
        "ledger".to_owned(),
        json!(["alpha\u{2028}beta", "gamma\u{2029}delta"]),
    );
    critical_state.insert("cursor".to_owned(), json!(3));
    let mut handoff = AgentHandoff::new(
        vec!["done\u{2028}one".to_owned()],
        vec!["left\u{2029}two".to_owned()],
        critical_state,
        "resume after unicode \u{2028} and \u{2029}".to_owned(),
    );
    handoff.extras.insert(
        "transport_note".to_owned(),
        json!("extra\u{2028}frame\u{2029}field"),
    );
    let overlay = ResumeOverlay {
        assignment_id: id("unicode-assignment"),
        session_ref: rf("session:unicode"),
        run_revision: 41,
        handoff,
    };

    let encoded = serde_json::to_string(&overlay).unwrap();
    let decoded: ResumeOverlay = serde_json::from_str(&encoded).unwrap();

    assert_eq!(decoded, overlay);
    assert_eq!(decoded.handoff.schema, HandoffSchema::V1);
    assert_eq!(
        decoded.handoff.extras["transport_note"],
        json!("extra\u{2028}frame\u{2029}field")
    );
}

struct ScriptedCompactor {
    failure: Option<Failure>,
    calls: usize,
}

impl Compactor for ScriptedCompactor {
    fn compact_same_session(&mut self, _checkpoint: &CheckpointRecord) -> Result<(), Failure> {
        self.calls += 1;
        match self.failure {
            Some(failure) => Err(failure),
            None => Ok(()),
        }
    }
}

fn checkpoint_at(percent: f64, input: &CheckpointInput) -> CheckpointRecord {
    match observe_context(percent, input).unwrap() {
        ContextDecision::CheckpointAndSettle(record) => record,
        other => panic!("expected checkpoint, got {other:?}"),
    }
}

fn planning_input() -> CheckpointInput {
    CheckpointInput::planning(id("plan-assignment"), 11, rf("session:plan"), handoff())
}

fn execution_input(preservation: PreservationEvidence) -> CheckpointInput {
    CheckpointInput::execution(
        id("exec-assignment"),
        12,
        rf("session:exec"),
        id("lane-a"),
        sha("base-real"),
        sha("current-real"),
        preservation,
        handoff(),
    )
}

fn resume_overlay() -> ResumeOverlay {
    ResumeOverlay {
        assignment_id: id("plan-assignment"),
        session_ref: rf("session:plan"),
        run_revision: 11,
        handoff: handoff(),
    }
}

fn handoff() -> AgentHandoff {
    let mut critical_state = BTreeMap::new();
    critical_state.insert("ledger".to_owned(), json!(["kept"]));
    AgentHandoff::new(
        vec!["completed-a".to_owned()],
        vec!["remaining-b".to_owned()],
        critical_state,
        "continue with remaining-b".to_owned(),
    )
}

fn id(value: &str) -> Id {
    Id(value.to_owned())
}

fn rf(value: &str) -> Ref {
    Ref(value.to_owned())
}

fn sha(value: &str) -> Sha {
    Sha(value.to_owned())
}
