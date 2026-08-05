use std::collections::{BTreeMap, BTreeSet};

use kernel::{
    boundary::Rejection,
    effect::{Effect, OperatorMessage},
    failure::{Failure, HardBoundary},
    generated::{
        ActionKind, BackgroundAction, BackgroundActionBgRun, ControlFrame, ControlFrameCounts,
        ControlFrameTrigger, Duration, Id, Nullable, Ref, SchemaId, Timestamp, TriggerKind, Uuidv7,
    },
};
use kernel_macros::acceptance_boundary;
use serde_json::json;

use crate::roles::kdl::boundary_runtime;

pub const CONTROL_KDL: &str = include_str!("../../../data/control.kdl");
const BOUNDARY_ID: &str = "control.bg-run-exact.v1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlPolicy {
    pub action_kinds: Vec<String>,
    pub focused_timeout: Duration,
    pub integration_timeout: Duration,
    pub final_suite_timeout: Duration,
    pub handoff_timeout: Duration,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlError {
    Malformed(String),
    Missing(String),
}

impl ControlPolicy {
    pub fn package() -> Result<Self, ControlError> {
        let action_kinds: Vec<String> = data_blocks("action_kind")
            .map_err(ControlError::Malformed)?
            .into_iter()
            .map(|block| block.id)
            .collect();
        if action_kinds.len() != 6 {
            return Err(ControlError::Malformed(
                "six action kinds required".to_owned(),
            ));
        }
        Ok(Self {
            action_kinds,
            focused_timeout: timeout("focused-command")?,
            integration_timeout: timeout("integration")?,
            final_suite_timeout: timeout("final-suite")?,
            handoff_timeout: timeout("cooperative-handoff-checkpoint")?,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlObservation {
    BackgroundTask { task_id: Id, status: TaskStatus },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskStatus {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ControlFrameDocument(ControlFrame);

#[derive(Clone, Debug, PartialEq)]
pub struct FrameInput {
    pub frame_id: Uuidv7,
    pub run_id: Uuidv7,
    pub run_revision: u64,
    pub trigger_kind: TriggerKind,
    pub trigger_refs: Vec<Ref>,
    pub counts: ControlFrameCounts,
    pub observations: Vec<ControlObservation>,
    pub actions: Vec<BackgroundAction>,
    pub next_watchdog_at: Nullable<Timestamp>,
}

impl ControlFrameDocument {
    pub fn build(input: FrameInput) -> Self {
        let return_to_idle = input.actions.is_empty();
        Self(ControlFrame {
            schema: SchemaId("autopilot.control_frame.v1".to_owned()),
            frame_id: input.frame_id,
            run_id: input.run_id,
            run_revision: input.run_revision,
            trigger: ControlFrameTrigger {
                kind: input.trigger_kind,
                refs: input.trigger_refs,
            },
            counts: input.counts,
            observations: input
                .observations
                .into_iter()
                .map(observation_value)
                .collect(),
            actions: input.actions,
            next_watchdog_at: input.next_watchdog_at,
            return_to_idle,
        })
    }

    pub const fn as_generated(&self) -> &ControlFrame {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum GuardOutcome {
    Accepted {
        action: BackgroundAction,
        effect: Effect,
    },
    Duplicate {
        action: BackgroundAction,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum GuardRejection {
    Mismatch { valid: Box<BackgroundAction> },
    Unsafe { failure: Failure },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolResultBinding {
    pub action_id: Id,
    pub assignment_id: Id,
    pub task_id: Id,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BindError {
    UnknownAction(Id),
}

#[derive(Clone, Debug, PartialEq)]
pub struct BgRunGuard {
    issued: Vec<BackgroundAction>,
    consumed_assignments: BTreeSet<Id>,
}

impl BgRunGuard {
    pub fn new(issued: Vec<BackgroundAction>) -> Self {
        Self {
            issued,
            consumed_assignments: BTreeSet::new(),
        }
    }

    pub fn admit(&mut self, call: &BackgroundActionBgRun) -> Result<GuardOutcome, GuardRejection> {
        let action = self
            .live_launch()
            .ok_or(GuardRejection::Unsafe {
                failure: HardBoundary::UnissuedBackgroundLaunch.into(),
            })?
            .clone();
        admit_exact_bg_run((&action, call)).map_err(|_rejection| GuardRejection::Mismatch {
            valid: Box::new(action.clone()),
        })?;
        if self.consumed_assignments.contains(&action.assignment_id) {
            return Ok(GuardOutcome::Duplicate { action });
        }
        self.consumed_assignments
            .insert(action.assignment_id.clone());
        Ok(GuardOutcome::Accepted {
            effect: Effect::LaunchBackground(action.clone()),
            action,
        })
    }

    pub fn bind_task(&self, action_id: &Id, task_id: Id) -> Result<ToolResultBinding, BindError> {
        self.issued
            .iter()
            .find(|action| &action.action_id == action_id)
            .map(|action| ToolResultBinding {
                action_id: action.action_id.clone(),
                assignment_id: action.assignment_id.clone(),
                task_id,
            })
            .ok_or_else(|| BindError::UnknownAction(action_id.clone()))
    }

    fn live_launch(&self) -> Option<&BackgroundAction> {
        self.issued.iter().find(|action| {
            action.kind == ActionKind::LaunchBackground && action.supersession_state.0 == "live"
        })
    }
}

pub fn effect_for(action: BackgroundAction) -> Effect {
    match action.kind.clone() {
        ActionKind::LaunchBackground => Effect::LaunchBackground(action),
        ActionKind::ReconcileBackground => Effect::ReconcileBackground(action.action_id),
        ActionKind::ReadFailureLog => Effect::ReadFailureLog(action.action_id),
        ActionKind::StopBackground => Effect::StopBackground(action.action_id),
        ActionKind::RequestOperator => {
            Effect::RequestOperator(OperatorMessage(action.bg_run.command.0.into_bytes()))
        }
        ActionKind::ReturnIdle => Effect::ReturnIdle,
    }
}

#[acceptance_boundary(
    id = "control.bg-run-exact.v1",
    producer = Producer::Package,
    visible = true,
    admits = "A parent bg_run call must byte-match exactly one live package-issued launch action bg_run object. Package-issued actions retain durable completion notification and prohibit parent-turn triggering. Unissued launches are Unsafe(UnissuedBackgroundLaunch).",
    mode = BoundaryMode::Enforce
)]
pub fn admit_exact_bg_run<'a>(
    pair: (&'a BackgroundAction, &'a BackgroundActionBgRun),
) -> Result<&'a BackgroundAction, Rejection> {
    let (action, call) = pair;
    if !action.bg_run.notify_on_completion || action.bg_run.trigger_on_completion {
        boundary_runtime(BOUNDARY_ID).reject("unsafe package completion profile".to_owned())?;
    }
    if &action.bg_run != call {
        boundary_runtime(BOUNDARY_ID)
            .reject("bg_run call did not match the live issued action".to_owned())?;
    }
    Ok(action)
}

fn observation_value(observation: ControlObservation) -> serde_json::Value {
    match observation {
        ControlObservation::BackgroundTask { task_id, status } => json!({
            "kind": "background-task",
            "task_id": task_id,
            "status": match status {
                TaskStatus::Completed => "completed",
                TaskStatus::Failed => "failed",
                TaskStatus::Interrupted => "interrupted",
            },
        }),
    }
}

fn timeout(id: &str) -> Result<Duration, ControlError> {
    for block in data_blocks("timeout").map_err(ControlError::Malformed)? {
        if block.id == id {
            return one(&block.fields, "duration")
                .map(Duration)
                .map_err(ControlError::Malformed);
        }
    }
    Err(ControlError::Missing(id.to_owned()))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DataBlock {
    pub(crate) id: String,
    pub(crate) fields: BTreeMap<String, Vec<String>>,
}

pub(crate) fn data_blocks(kind: &str) -> Result<Vec<DataBlock>, String> {
    let mut out = Vec::new();
    let mut lines = CONTROL_KDL.lines().enumerate();
    while let Some((line_no, raw)) = lines.next() {
        let line = clean(raw);
        if line.is_empty() {
            continue;
        }
        let (head, rest) = line
            .split_once(' ')
            .ok_or_else(|| format!("line {}: expected block", line_no + 1))?;
        let id = quoted(rest)
            .into_iter()
            .next()
            .ok_or_else(|| format!("line {}: missing id", line_no + 1))?;
        let mut fields = BTreeMap::new();
        loop {
            let Some((child_no, child_raw)) = lines.next() else {
                return Err(format!("{head} {id}: missing close"));
            };
            let child = clean(child_raw);
            if child == "}" {
                break;
            }
            if child.is_empty() || head != kind {
                continue;
            }
            let (key, rest) = child
                .split_once(' ')
                .ok_or_else(|| format!("line {}: missing value", child_no + 1))?;
            fields.insert(key.to_owned(), parse_values(rest));
        }
        if head == kind {
            out.push(DataBlock { id, fields });
        }
    }
    Ok(out)
}

pub(crate) fn one(fields: &BTreeMap<String, Vec<String>>, key: &str) -> Result<String, String> {
    fields
        .get(key)
        .and_then(|values| values.first())
        .cloned()
        .ok_or_else(|| format!("missing {key}"))
}

fn parse_values(text: &str) -> Vec<String> {
    let quoted = quoted(text);
    if quoted.is_empty() {
        vec![text.trim().to_owned()]
    } else {
        quoted
    }
}

fn clean(line: &str) -> &str {
    if let Some((before_comment, _comment)) = line.split_once("//") {
        before_comment.trim()
    } else {
        line.trim()
    }
}

fn quoted(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut open = false;
    let mut buf = String::new();
    for c in text.chars() {
        if c == '"' {
            if open {
                out.push(buf.clone());
                buf.clear();
            }
            open = !open;
        } else if open {
            buf.push(c);
        }
    }
    out
}
