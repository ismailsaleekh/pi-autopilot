use crate::fold::fold_all;
use crate::generated::{EventKind, EventRow, Ref, StateCache};
use crate::state::State;

#[derive(Clone, Debug, PartialEq)]
pub enum LogEffect {
    Append(EventRow),
    Store(CacheImage),
}

#[derive(Clone, Debug, PartialEq)]
pub struct CacheImage {
    pub state: State,
    pub cache: StateCache,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppendRefusal {
    SequenceOverflow,
    RevisionOverflow,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AppendPlan {
    Write(LogEffect),
    Refused(AppendRefusal),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplayUse {
    Full,
    Cache,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Replay {
    pub state: State,
    pub used: ReplayUse,
}

pub fn plan_append(state: &State, kind: EventKind, artifact_refs: Vec<Ref>) -> AppendPlan {
    let sequence = match state.sequence.checked_add(1) {
        Some(next) => next,
        None => return AppendPlan::Refused(AppendRefusal::SequenceOverflow),
    };
    let new_revision = match state.revision.checked_add(1) {
        Some(next) => next,
        None => return AppendPlan::Refused(AppendRefusal::RevisionOverflow),
    };
    AppendPlan::Write(LogEffect::Append(EventRow {
        sequence,
        previous_revision: state.revision,
        new_revision,
        kind,
        artifact_refs,
    }))
}

pub fn cache_image(state: State) -> LogEffect {
    let cache = StateCache {
        sequence: state.sequence,
        state_hash: state.state_hash(),
    };
    LogEffect::Store(CacheImage { state, cache })
}

pub fn replay(events: &[EventRow], cache: Option<&CacheImage>) -> Replay {
    if let Some(image) = cache
        && let Some(state) = verified_replay(events, image)
    {
        return Replay {
            state,
            used: ReplayUse::Cache,
        };
    }
    Replay {
        state: fold_all(events),
        used: ReplayUse::Full,
    }
}

fn verified_replay(events: &[EventRow], image: &CacheImage) -> Option<State> {
    if image.state.sequence != image.cache.sequence {
        return None;
    }
    if image.state.state_hash() != image.cache.state_hash {
        return None;
    }
    let row_count = match usize::try_from(image.state.rows) {
        Ok(value) if value <= events.len() => value,
        _ => return None,
    };
    let prefix = fold_all(&events[..row_count]);
    if prefix != image.state || prefix.state_hash() != image.cache.state_hash {
        return None;
    }
    Some(
        events[row_count..]
            .iter()
            .fold(image.state.clone(), crate::fold::fold),
    )
}
