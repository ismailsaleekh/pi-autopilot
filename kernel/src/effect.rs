use crate::generated::{BackgroundAction, Id};

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    LaunchBackground(BackgroundAction),
    ReconcileBackground(Id),
    ReadFailureLog(Id),
    StopBackground(Id),
    RequestOperator(OperatorMessage),
    ReturnIdle,
}

impl Eq for Effect {}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct OperatorMessage(pub Vec<u8>);
