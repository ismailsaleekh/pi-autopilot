use kernel::failure::{Failure, RecoveryRoute};
use kernel::generated::{Id, Ref, Sha};

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct AssignmentState {
    pub assignment_id: Id,
    pub lane_id: Id,
    pub run_revision: u64,
    pub base_commit: Sha,
    pub current_commit: Sha,
    pub dirty_paths: Vec<String>,
    pub completed: Vec<Id>,
    pub remaining: Vec<Id>,
    pub next_action: String,
    pub session_ref: Ref,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CheckpointRecord {
    pub assignment_id: Id,
    pub context_percent: u8,
    pub preservation_commit: Sha,
    pub resume_overlay: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum ContextDecision {
    Continue,
    SoftWarning,
    CheckpointAndSettle(CheckpointRecord),
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum CompactionOutcome {
    Resumed {
        overlay: String,
    },
    Recoverable {
        checkpoint: CheckpointRecord,
        failure: Failure,
    },
}

#[derive(Debug, Default, Clone, Eq, PartialEq)]
pub struct SideEffects {
    pub validation_started: usize,
    pub integration_started: usize,
    pub replacement_spawned: usize,
}

pub trait Compactor {
    fn compact_same_session(&mut self, checkpoint: &CheckpointRecord) -> Result<(), Failure>;
}

pub fn observe_context(percent: u8, state: &AssignmentState) -> ContextDecision {
    if percent >= 85 {
        ContextDecision::CheckpointAndSettle(render_checkpoint(percent, state))
    } else if percent >= 75 {
        ContextDecision::SoftWarning
    } else {
        ContextDecision::Continue
    }
}

pub fn compact_and_resume(
    checkpoint: CheckpointRecord,
    compactor: &mut dyn Compactor,
    _effects: &mut SideEffects,
) -> CompactionOutcome {
    match compactor.compact_same_session(&checkpoint) {
        Ok(()) => CompactionOutcome::Resumed {
            overlay: checkpoint.resume_overlay,
        },
        Err(_) => CompactionOutcome::Recoverable {
            checkpoint,
            failure: Failure::Recoverable {
                route: RecoveryRoute::Tier1,
            },
        },
    }
}

fn render_checkpoint(percent: u8, state: &AssignmentState) -> CheckpointRecord {
    let preservation = if state.dirty_paths.is_empty() {
        state.current_commit.clone()
    } else {
        Sha(format!(
            "preserve-{}-{}",
            state.assignment_id.0, state.run_revision
        ))
    };
    let resume_overlay = format!(
        "assignment={} lane={} revision={} checkpoint={} completed={} remaining={} next={} session={}",
        state.assignment_id.0,
        state.lane_id.0,
        state.run_revision,
        preservation.0,
        ids(&state.completed),
        ids(&state.remaining),
        state.next_action,
        state.session_ref.0
    );
    CheckpointRecord {
        assignment_id: state.assignment_id.clone(),
        context_percent: percent,
        preservation_commit: preservation,
        resume_overlay,
    }
}

fn ids(values: &[Id]) -> String {
    let mut out = String::new();
    for value in values {
        if !out.is_empty() {
            out.push(',');
        }
        out.push_str(&value.0);
    }
    out
}
