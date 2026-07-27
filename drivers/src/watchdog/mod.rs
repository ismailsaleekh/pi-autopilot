use kernel::{
    effect::Effect,
    generated::{ActionKind, BackgroundAction, Bytes, Duration, Id, SupersessionState},
};

use crate::control::{data_blocks, one};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchdogConfig {
    pub minutes: u32,
    pub command: String,
    pub display_name: String,
    pub is_agent: bool,
    pub notify_on_completion: bool,
    pub trigger_on_completion: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WatchdogError {
    Malformed(String),
    Missing(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct WatchdogTurn {
    pub effects: Vec<Effect>,
}

impl WatchdogConfig {
    pub fn package() -> Result<Self, WatchdogError> {
        let block = data_blocks("watchdog")
            .map_err(WatchdogError::Malformed)?
            .into_iter()
            .find(|block| block.id == "heartbeat")
            .ok_or_else(|| WatchdogError::Missing("watchdog heartbeat".to_owned()))?;
        Ok(Self {
            minutes: one(&block.fields, "minutes")
                .map_err(WatchdogError::Malformed)?
                .parse()
                .map_err(|_| WatchdogError::Malformed("watchdog minutes".to_owned()))?,
            command: one(&block.fields, "command").map_err(WatchdogError::Malformed)?,
            display_name: one(&block.fields, "display_name").map_err(WatchdogError::Malformed)?,
            is_agent: flag(&block.fields, "isAgent")?,
            notify_on_completion: flag(&block.fields, "notifyOnCompletion")?,
            trigger_on_completion: flag(&block.fields, "triggerOnCompletion")?,
        })
    }

    pub fn arm_action(
        &self,
        active_work: bool,
        already_armed: bool,
        action_id: Id,
        run_revision: u64,
    ) -> Option<BackgroundAction> {
        if !active_work || already_armed {
            return None;
        }
        Some(BackgroundAction {
            assignment_id: Id("watchdog-heartbeat".to_owned()),
            action_id,
            kind: ActionKind::LaunchBackground,
            command_bytes: Bytes(self.command.clone()),
            display_name: self.display_name.clone(),
            is_agent: self.is_agent,
            timeout: Some(Duration(format!("{}m", self.minutes))),
            notify_on_completion: self.notify_on_completion,
            trigger_on_completion: self.trigger_on_completion,
            run_revision,
            expires_at: None,
            supersession_state: SupersessionState("live".to_owned()),
        })
    }

    pub fn completed_turn(
        &self,
        work_remains: bool,
        next_action_id: Id,
        run_revision: u64,
    ) -> WatchdogTurn {
        let mut effects = vec![Effect::ReconcileBackground(Id(
            "watchdog-heartbeat".to_owned()
        ))];
        if let Some(action) = self.arm_action(work_remains, false, next_action_id, run_revision) {
            effects.push(Effect::LaunchBackground(action));
        }
        WatchdogTurn { effects }
    }
}

impl WatchdogTurn {
    pub const fn has_semantic_authority(&self) -> bool {
        false
    }
}

fn flag(
    fields: &std::collections::BTreeMap<String, Vec<String>>,
    key: &str,
) -> Result<bool, WatchdogError> {
    match one(fields, key).map_err(WatchdogError::Malformed)?.as_str() {
        "#true" => Ok(true),
        "#false" => Ok(false),
        value => Err(WatchdogError::Malformed(format!("{key}: {value}"))),
    }
}
