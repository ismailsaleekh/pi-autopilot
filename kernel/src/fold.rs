use crate::generated::EventRow;
use crate::state::{State, apply};

pub fn fold(state: State, event: &EventRow) -> State {
    apply(state, event)
}

pub fn fold_all(events: &[EventRow]) -> State {
    events.iter().fold(State::EMPTY, fold)
}
