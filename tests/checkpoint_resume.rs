use drivers::checkpoint::{
    AssignmentState, CheckpointRecord, CompactionOutcome, Compactor, ContextDecision, SideEffects,
    compact_and_resume, observe_context,
};
use kernel::failure::{Failure, RecoveryRoute};
use kernel::generated::{Id, Ref, Sha};

#[test]
fn eighty_five_percent_checkpoints_and_settles_without_validation_or_integration() {
    let state = state();
    let effects = SideEffects::default();
    assert_eq!(observe_context(74, &state), ContextDecision::Continue);
    assert_eq!(observe_context(79, &state), ContextDecision::SoftWarning);
    let checkpoint = match observe_context(85, &state) {
        ContextDecision::CheckpointAndSettle(record) => record,
        other => panic!("expected checkpoint, got {other:?}"),
    };
    assert_eq!(checkpoint.assignment_id, id("assignment"));
    assert_eq!(checkpoint.context_percent, 85);
    assert!(
        checkpoint
            .preservation_commit
            .0
            .starts_with("preserve-assignment-9")
    );
    assert!(checkpoint.resume_overlay.contains("remaining=u2"));
    assert_eq!(
        effects.validation_started, 0,
        "checkpoint triggered no validation"
    );
    assert_eq!(
        effects.integration_started, 0,
        "checkpoint triggered no integration"
    );
}

#[test]
fn successful_compaction_resumes_same_session_overlay() {
    let checkpoint = checkpoint();
    let mut compactor = ScriptedCompactor {
        fail: false,
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
fn compaction_failure_is_recoverable_and_spawns_no_replacement() {
    let checkpoint = checkpoint();
    let mut compactor = ScriptedCompactor {
        fail: true,
        calls: 0,
    };
    let mut effects = SideEffects::default();
    let outcome = compact_and_resume(checkpoint.clone(), &mut compactor, &mut effects);
    assert_eq!(compactor.calls, 1);
    assert_eq!(
        outcome,
        CompactionOutcome::Recoverable {
            checkpoint,
            failure: Failure::Recoverable {
                route: RecoveryRoute::Tier1
            },
        }
    );
    assert_eq!(
        effects.replacement_spawned, 0,
        "failed compaction did not spawn replacement"
    );
    assert_eq!(
        effects.validation_started, 0,
        "failed compaction triggered no validation"
    );
    assert_eq!(
        effects.integration_started, 0,
        "failed compaction triggered no integration"
    );
}

struct ScriptedCompactor {
    fail: bool,
    calls: usize,
}

impl Compactor for ScriptedCompactor {
    fn compact_same_session(&mut self, _checkpoint: &CheckpointRecord) -> Result<(), Failure> {
        self.calls += 1;
        if self.fail {
            Err(Failure::Recoverable {
                route: RecoveryRoute::Tier1,
            })
        } else {
            Ok(())
        }
    }
}

fn state() -> AssignmentState {
    AssignmentState {
        assignment_id: id("assignment"),
        lane_id: id("lane"),
        run_revision: 9,
        base_commit: Sha("base".to_owned()),
        current_commit: Sha("current".to_owned()),
        dirty_paths: vec!["src/lib.rs".to_owned()],
        completed: vec![id("u1")],
        remaining: vec![id("u2")],
        next_action: "resume edits".to_owned(),
        session_ref: Ref("session:file".to_owned()),
    }
}

fn checkpoint() -> CheckpointRecord {
    match observe_context(85, &state()) {
        ContextDecision::CheckpointAndSettle(record) => record,
        other => panic!("expected checkpoint, got {other:?}"),
    }
}

fn id(value: &str) -> Id {
    Id(value.to_owned())
}
