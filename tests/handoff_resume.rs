use std::sync::atomic::{AtomicU64, Ordering};

use drivers::{
    handoff::{
        AssignmentHandle, COOPERATIVE_WAIT_SECONDS, CooperativeCheckpoint, HandoffAction,
        claims_cross_session_reattachment, intentional_handoff,
    },
    recovery::{
        FileAssignmentLock, LockAcquire, LockState, ProcessProbe, RestartDecision, RestartInput,
        ResultArtifact, reconcile_restart,
    },
};
use kernel::generated::{Id, Ref};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn handoff_pauses_checkpoints_kills_and_resumes_with_new_bg_run() {
    let active = vec![AssignmentHandle {
        assignment_id: id("a1"),
        task_id: id("task-old"),
        child_session_ref: rf("session/a1.json"),
        worktree_ref: rf("worktrees/a1"),
    }];
    let checkpoints = vec![CooperativeCheckpoint {
        assignment_id: id("a1"),
        checkpoint_ref: rf("checkpoints/a1.json"),
    }];

    let outcome = intentional_handoff(&active, &checkpoints);

    assert_eq!(
        outcome.actions,
        vec![
            HandoffAction::PauseRequest {
                assignment_id: id("a1")
            },
            HandoffAction::WaitForCheckpoint {
                assignment_id: id("a1"),
                max_seconds: COOPERATIVE_WAIT_SECONDS,
                checkpoint_ref: Some(rf("checkpoints/a1.json"))
            },
            HandoffAction::BgKill {
                task_id: id("task-old")
            },
            HandoffAction::BgRun {
                assignment_id: id("a1"),
                previous_task_id: id("task-old")
            },
        ]
    );
    assert_eq!(COOPERATIVE_WAIT_SECONDS, 120);
    assert_eq!(outcome.retained_child_sessions, vec![rf("session/a1.json")]);
    assert_eq!(outcome.retained_worktrees, vec![rf("worktrees/a1")]);
    assert_eq!(outcome.resumed[0].previous_task_id, id("task-old"));
    assert!(
        !claims_cross_session_reattachment(&outcome.actions),
        "handoff resumes via new bg_run rather than claiming task reattachment"
    );
}

#[test]
fn live_process_lock_is_visible_wait_not_duplicate_or_kill() {
    let root = temp_root("live-lock");
    let probe = FakeProbe { live_pid: 41 };
    let first = FileAssignmentLock::acquire(&root, &id("a1"), 41, &probe);
    let first = match first {
        LockAcquire::Acquired(lock) => lock,
        other => panic!("first acquisition should create OS lock, got {other:?}"),
    };

    let second = FileAssignmentLock::acquire(&root, &id("a1"), 99, &probe);
    assert_eq!(second, LockAcquire::HeldByLive { pid: 41 });

    let decision = reconcile_restart(&RestartInput {
        assignment_id: id("a1"),
        event_refs: Vec::new(),
        git_refs: Vec::new(),
        create_once_refs: Vec::new(),
        checkpoint_refs: Vec::new(),
        result: None,
        lock: LockState::HeldByLive { pid: 41 },
    });
    assert_eq!(
        decision,
        RestartDecision::VisibleWait {
            assignment_id: id("a1"),
            holder_pid: 41
        }
    );
    assert_ne!(
        decision,
        RestartDecision::ResumeWithNewBgRun {
            assignment_id: id("a1")
        },
        "live holder must not cause a duplicate runner"
    );

    first.release().expect("release lock");
}

#[test]
fn restart_accepts_no_result_without_exact_evidence() {
    let decision = reconcile_restart(&RestartInput {
        assignment_id: id("a1"),
        event_refs: vec![rf("event/result"), rf("artifact/a")],
        git_refs: vec![rf("commit/a")],
        create_once_refs: vec![rf("artifact/a")],
        checkpoint_refs: Vec::new(),
        result: Some(ResultArtifact {
            result_ref: rf("result/a"),
            event_ref: rf("event/result"),
            commit_ref: rf("commit/a"),
            evidence_refs: Vec::new(),
        }),
        lock: LockState::Free,
    });
    assert_eq!(
        decision,
        RestartDecision::RejectResult {
            assignment_id: id("a1"),
            reason: "result-without-evidence:result/a".to_owned()
        }
    );

    let accepted = reconcile_restart(&RestartInput {
        assignment_id: id("a1"),
        event_refs: vec![rf("event/result"), rf("artifact/a")],
        git_refs: vec![rf("commit/a")],
        create_once_refs: vec![rf("artifact/a")],
        checkpoint_refs: Vec::new(),
        result: Some(ResultArtifact {
            result_ref: rf("result/a"),
            event_ref: rf("event/result"),
            commit_ref: rf("commit/a"),
            evidence_refs: vec![rf("evidence/a")],
        }),
        lock: LockState::Free,
    });
    assert_eq!(
        accepted,
        RestartDecision::AcceptResult {
            result_ref: rf("result/a")
        }
    );
}

struct FakeProbe {
    live_pid: u32,
}

impl ProcessProbe for FakeProbe {
    fn is_live(&self, pid: u32) -> bool {
        pid == self.live_pid
    }
}

fn id(value: &str) -> Id {
    Id(value.to_owned())
}

fn rf(value: &str) -> Ref {
    Ref(value.to_owned())
}

fn temp_root(name: &str) -> std::path::PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("autopilot-{name}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&root).expect("temp root");
    root
}
