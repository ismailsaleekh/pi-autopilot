use super::{CompactionReason, RpcError, RpcEvent};
use crate::generated::pi_rpc::{FORBIDDEN_ORDERS, ORDER_STATES, ORDER_TRANSITIONS};

pub struct EventOrder {
    state: &'static str,
}
impl Default for EventOrder {
    fn default() -> Self {
        Self::new()
    }
}
impl EventOrder {
    #[must_use]
    pub fn new() -> Self {
        Self { state: "idle" }
    }
    pub fn begin_cycle(&mut self) {
        if self.state == "settled" {
            self.state = "idle";
        }
    }
    pub fn accept(&mut self, event: &RpcEvent) -> Result<(), RpcError> {
        let key = self.order_key(event);
        if FORBIDDEN_ORDERS.iter().any(|row| {
            (row.from.is_none() || row.from == Some(self.state))
                && (row.event == "*" || row.event == key)
        }) {
            return Err(if self.state == "settled" {
                RpcError::OutOfOrderEvent(format!("event {event:?} arrived after agent_settled"))
            } else {
                RpcError::ProtocolViolation(
                    "automatic compaction emitted while auto-compaction is disabled".to_owned(),
                )
            });
        }
        let next = ORDER_TRANSITIONS
            .iter()
            .find(|row| row.from == self.state && row.event == key)
            .map(|row| row.to)
            .ok_or_else(|| {
                RpcError::OutOfOrderEvent(format!(
                    "event {event:?} is invalid in state {}",
                    self.state
                ))
            })?;
        self.state = next;
        Ok(())
    }
    pub fn finish(&self) -> Result<(), RpcError> {
        if ORDER_STATES
            .iter()
            .any(|row| row.name == self.state && row.terminal_ok)
        {
            Ok(())
        } else {
            Err(RpcError::OutOfOrderEvent(format!(
                "stream ended before agent_settled from state {}",
                self.state
            )))
        }
    }
    fn order_key(&self, event: &RpcEvent) -> &'static str {
        match event {
            RpcEvent::AgentStart => "agent_start",
            RpcEvent::AgentEnd { will_retry: false } => "agent_end_retry_false",
            RpcEvent::AgentEnd { will_retry: true } => "agent_end_retry_true",
            RpcEvent::AgentSettled => "agent_settled",
            RpcEvent::CompactionStart {
                reason: CompactionReason::Manual,
            } => "manual_compaction_start",
            RpcEvent::CompactionStart {
                reason: CompactionReason::Threshold | CompactionReason::Overflow,
            } => "threshold_or_overflow_compaction_start",
            RpcEvent::CompactionEnd { will_retry, .. } => match (self.state, will_retry) {
                ("compacting_after_end", false) => "compaction_end_retry_false",
                ("compacting_after_end", true) => "compaction_end_retry_true",
                _ => "compaction_end",
            },
            RpcEvent::AutoRetryStart
            | RpcEvent::AutoRetryEnd { .. }
            | RpcEvent::SummarizationRetryScheduled
            | RpcEvent::SummarizationRetryAttemptStart
            | RpcEvent::SummarizationRetryFinished => "retry_progress",
            RpcEvent::QueueUpdate { .. }
            | RpcEvent::ExtensionUiRequest
            | RpcEvent::ExtensionError => match self.state {
                "running" => "running_progress",
                "after_end_no_retry" | "after_end_retry" => "post_end_chatter",
                _ => "idle_chatter",
            },
            RpcEvent::EntryAppended { .. } => "idle_chatter",
            _ => "running_progress",
        }
    }
}
