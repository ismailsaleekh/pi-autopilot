use kernel::generated::{Id, Ref};

pub const COOPERATIVE_WAIT_SECONDS: u64 = 120;

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct AssignmentHandle {
    pub assignment_id: Id,
    pub task_id: Id,
    pub child_session_ref: Ref,
    pub worktree_ref: Ref,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CooperativeCheckpoint {
    pub assignment_id: Id,
    pub checkpoint_ref: Ref,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ResumeLaunch {
    pub assignment_id: Id,
    pub previous_task_id: Id,
    pub retained_child_session_ref: Ref,
    pub retained_worktree_ref: Ref,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum HandoffAction {
    PauseRequest {
        assignment_id: Id,
    },
    WaitForCheckpoint {
        assignment_id: Id,
        max_seconds: u64,
        checkpoint_ref: Option<Ref>,
    },
    BgKill {
        task_id: Id,
    },
    BgRun {
        assignment_id: Id,
        previous_task_id: Id,
    },
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct HandoffOutcome {
    pub actions: Vec<HandoffAction>,
    pub resumed: Vec<ResumeLaunch>,
    pub retained_child_sessions: Vec<Ref>,
    pub retained_worktrees: Vec<Ref>,
}

pub fn intentional_handoff(
    active: &[AssignmentHandle],
    checkpoints: &[CooperativeCheckpoint],
) -> HandoffOutcome {
    let mut actions = Vec::new();
    let mut resumed = Vec::new();
    let mut retained_child_sessions = Vec::new();
    let mut retained_worktrees = Vec::new();

    for assignment in active {
        actions.push(HandoffAction::PauseRequest {
            assignment_id: assignment.assignment_id.clone(),
        });
        let checkpoint_ref = checkpoints
            .iter()
            .find(|checkpoint| checkpoint.assignment_id == assignment.assignment_id)
            .map(|checkpoint| checkpoint.checkpoint_ref.clone());
        actions.push(HandoffAction::WaitForCheckpoint {
            assignment_id: assignment.assignment_id.clone(),
            max_seconds: COOPERATIVE_WAIT_SECONDS,
            checkpoint_ref,
        });
        actions.push(HandoffAction::BgKill {
            task_id: assignment.task_id.clone(),
        });
        actions.push(HandoffAction::BgRun {
            assignment_id: assignment.assignment_id.clone(),
            previous_task_id: assignment.task_id.clone(),
        });
        retained_child_sessions.push(assignment.child_session_ref.clone());
        retained_worktrees.push(assignment.worktree_ref.clone());
        resumed.push(ResumeLaunch {
            assignment_id: assignment.assignment_id.clone(),
            previous_task_id: assignment.task_id.clone(),
            retained_child_session_ref: assignment.child_session_ref.clone(),
            retained_worktree_ref: assignment.worktree_ref.clone(),
        });
    }

    HandoffOutcome {
        actions,
        resumed,
        retained_child_sessions,
        retained_worktrees,
    }
}

pub fn claims_cross_session_reattachment(actions: &[HandoffAction]) -> bool {
    actions.iter().any(|action| match action {
        HandoffAction::BgRun { .. }
        | HandoffAction::BgKill { .. }
        | HandoffAction::PauseRequest { .. }
        | HandoffAction::WaitForCheckpoint { .. } => false,
    })
}
