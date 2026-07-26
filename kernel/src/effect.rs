#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Effect {
    LaunchBackground(LaunchBackground),
    ReconcileBackground(TaskId),
    ReadFailureLog(LogId),
    StopBackground(TaskId),
    RequestOperator(OperatorMessage),
    ReturnIdle,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchBackground {
    pub action: ActionId,
    pub name: Label,
    pub command: CommandBytes,
    pub agent: bool,
    pub timeout_secs: u32,
    pub trigger_on_completion: bool,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ActionId(pub u64);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct TaskId(pub u64);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LogId(pub u64);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct Label(pub Vec<u8>);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommandBytes(pub Vec<u8>);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct OperatorMessage(pub Vec<u8>);
