use kdl::{KdlDocument, KdlEntry, KdlNode, KdlValue};
use kernel::failure::Failure;
use kernel::generated::{Id, Ref, Sha};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq)]
pub struct AssignmentState<L = Id, B = Sha, C = Sha> {
    pub assignment_id: Id,
    pub lane_id: L,
    pub run_revision: u64,
    pub base_commit: B,
    pub current_commit: C,
    pub dirty_paths: Vec<String>,
    pub completed: Vec<Id>,
    pub remaining: Vec<Id>,
    pub next_action: String,
    pub session_ref: Ref,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckpointInput {
    pub assignment_id: Id,
    pub run_revision: u64,
    pub session_ref: Ref,
    pub identity: AssignmentIdentity,
    pub handoff: AgentHandoff,
}

impl CheckpointInput {
    pub fn planning(
        assignment_id: Id,
        run_revision: u64,
        session_ref: Ref,
        handoff: AgentHandoff,
    ) -> Self {
        Self {
            assignment_id,
            run_revision,
            session_ref,
            identity: AssignmentIdentity::Planning,
            handoff,
        }
    }

    // Public constructor mirrors the serialized execution identity fields; grouping would change callers/API.
    #[allow(clippy::too_many_arguments)]
    pub fn execution(
        assignment_id: Id,
        run_revision: u64,
        session_ref: Ref,
        lane_id: Id,
        base_commit: Sha,
        current_commit: Sha,
        preservation: PreservationEvidence,
        handoff: AgentHandoff,
    ) -> Self {
        Self {
            assignment_id,
            run_revision,
            session_ref,
            identity: AssignmentIdentity::Execution(ExecutionIdentity {
                lane_id,
                base_commit,
                current_commit,
                preservation,
            }),
            handoff,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentIdentity {
    Planning,
    Execution(ExecutionIdentity),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecutionIdentity {
    pub lane_id: Id,
    pub base_commit: Sha,
    pub current_commit: Sha,
    pub preservation: PreservationEvidence,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreservationEvidence {
    CleanCurrentCommit {
        commit: Sha,
    },
    VerifiedPreservationCommit {
        commit: Sha,
        dirty_paths: Vec<String>,
    },
    NoPreservationCommit {
        dirty_paths: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ContextPercent(f64);

impl ContextPercent {
    pub fn new(percent: f64) -> Result<Self, ContextBudgetError> {
        if !percent.is_finite() {
            return Err(ContextBudgetError::NonFinite);
        }
        if percent < 0.0 {
            return Err(ContextBudgetError::Negative { percent });
        }
        if percent > 100.0 {
            return Err(ContextBudgetError::AboveMaximum { percent });
        }
        Ok(Self(percent))
    }

    pub fn as_f64(self) -> f64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextBudget {
    Known(ContextPercent),
    Unknown,
}

impl ContextBudget {
    pub fn known(percent: f64) -> Result<Self, ContextBudgetError> {
        Ok(Self::Known(ContextPercent::new(percent)?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ContextBudgetError {
    NonFinite,
    Negative { percent: f64 },
    AboveMaximum { percent: f64 },
}

pub trait IntoContextBudget {
    fn into_context_budget(self) -> Result<ContextBudget, ContextBudgetError>;
}

impl IntoContextBudget for ContextBudget {
    fn into_context_budget(self) -> Result<ContextBudget, ContextBudgetError> {
        Ok(self)
    }
}

impl IntoContextBudget for ContextPercent {
    fn into_context_budget(self) -> Result<ContextBudget, ContextBudgetError> {
        Ok(ContextBudget::Known(self))
    }
}

impl IntoContextBudget for f64 {
    fn into_context_budget(self) -> Result<ContextBudget, ContextBudgetError> {
        ContextBudget::known(self)
    }
}

impl IntoContextBudget for i32 {
    fn into_context_budget(self) -> Result<ContextBudget, ContextBudgetError> {
        ContextBudget::known(f64::from(self))
    }
}

impl IntoContextBudget for u8 {
    fn into_context_budget(self) -> Result<ContextBudget, ContextBudgetError> {
        ContextBudget::known(f64::from(self))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckpointRecord {
    pub assignment_id: Id,
    pub context_percent: ContextPercent,
    pub identity: AssignmentIdentity,
    pub resume_overlay: ResumeOverlay,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResumeOverlay {
    pub assignment_id: Id,
    pub session_ref: Ref,
    pub run_revision: u64,
    pub handoff: AgentHandoff,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentHandoff {
    pub schema: HandoffSchema,
    pub completed: Vec<String>,
    pub remaining: Vec<String>,
    pub critical_state: BTreeMap<String, Value>,
    pub next_action: String,
    #[serde(flatten)]
    pub extras: BTreeMap<String, Value>,
}

impl AgentHandoff {
    pub fn new(
        completed: Vec<String>,
        remaining: Vec<String>,
        critical_state: BTreeMap<String, Value>,
        next_action: String,
    ) -> Self {
        Self {
            schema: HandoffSchema::V1,
            completed,
            remaining,
            critical_state,
            next_action,
            extras: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CheckpointPolicy {
    pub handoff_contract: String,
    pub thresholds: BTreeMap<String, u64>,
    pub bounds: HandoffBounds,
    pub slot_sets: BTreeMap<String, SlotSet>,
    pub roles: BTreeMap<String, RoleCheckpointPolicy>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct HandoffBounds {
    pub completed_max_entries: usize,
    pub remaining_max_entries: usize,
    pub entry_max_bytes: usize,
    pub total_max_bytes: usize,
    pub critical_state_max_slots: usize,
    pub critical_state_value_max_bytes: usize,
    pub critical_state_array_max_entries: usize,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct SlotSet {
    pub output_contract: String,
    pub slots: Vec<CheckpointSlot>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RoleCheckpointPolicy {
    pub interruptible: bool,
    pub slot_set: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CheckpointSlot {
    pub key: String,
    pub value_type: CheckpointSlotType,
    pub required: bool,
    pub max_entries: Option<usize>,
    pub max_bytes: usize,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum CheckpointSlotType {
    String,
    ArrayString,
}

impl CheckpointPolicy {
    pub fn parse() -> Result<Self, String> {
        Self::parse_source(include_str!("../../../data/checkpoint-policy.kdl"))
    }

    pub fn parse_source(source: &str) -> Result<Self, String> {
        let doc = source
            .parse::<KdlDocument>()
            .map_err(|error| format!("checkpoint policy KDL parse error: {error}"))?;
        let mut schema_seen = false;
        let mut version_seen = false;
        let mut handoff_contract = None;
        let mut thresholds = BTreeMap::new();
        let mut bounds = None;
        let mut slot_sets = BTreeMap::new();
        let mut roles = BTreeMap::new();

        for node in doc.nodes() {
            match node.name().value() {
                "schema" => {
                    let value = arg_string(node, 0)?;
                    if value != "autopilot.checkpoint-policy.v1" {
                        return Err(format!("bad checkpoint policy schema `{value}`"));
                    }
                    schema_seen = true;
                }
                "version" => {
                    let value = arg_u64(node, 0)?;
                    if value != 1 {
                        return Err(format!("bad checkpoint policy version `{value}`"));
                    }
                    version_seen = true;
                }
                "doc" => {}
                "handoff_contract" => {
                    handoff_contract = Some(arg_string(node, 0)?.to_owned());
                }
                "threshold" => {
                    let key = arg_string(node, 0)?.to_owned();
                    let percent = prop_u64(node, "percent")?;
                    if thresholds.insert(key.clone(), percent).is_some() {
                        return Err(format!("duplicate threshold `{key}`"));
                    }
                    nonempty_prop(node, "basis")?;
                }
                "handoff_bounds" => {
                    if bounds.is_some() {
                        return Err("duplicate handoff_bounds".to_owned());
                    }
                    nonempty_prop(node, "basis")?;
                    bounds = Some(HandoffBounds {
                        completed_max_entries: prop_usize(node, "completed_max_entries")?,
                        remaining_max_entries: prop_usize(node, "remaining_max_entries")?,
                        entry_max_bytes: prop_usize(node, "entry_max_bytes")?,
                        total_max_bytes: prop_usize(node, "total_max_bytes")?,
                        critical_state_max_slots: prop_usize(node, "critical_state_max_slots")?,
                        critical_state_value_max_bytes: prop_usize(
                            node,
                            "critical_state_value_max_bytes",
                        )?,
                        critical_state_array_max_entries: prop_usize(
                            node,
                            "critical_state_array_max_entries",
                        )?,
                    });
                }
                "slot_set" => {
                    let id = arg_string(node, 0)?.to_owned();
                    let output_contract = nonempty_prop(node, "output_contract")?.to_owned();
                    nonempty_prop(node, "rationale")?;
                    let children = node
                        .children()
                        .ok_or_else(|| format!("slot_set `{id}` missing slots"))?;
                    let mut slots = Vec::new();
                    let mut slot_keys = BTreeSet::new();
                    for child in children.nodes() {
                        if child.name().value() != "slot" {
                            return Err(format!(
                                "slot_set `{id}` has unknown child `{}`",
                                child.name().value()
                            ));
                        }
                        let key = arg_string(child, 0)?.to_owned();
                        if !slot_keys.insert(key.clone()) {
                            return Err(format!("slot_set `{id}` duplicates slot `{key}`"));
                        }
                        let value_type = match prop_string(child, "type")? {
                            "string" => CheckpointSlotType::String,
                            "array<string>" => CheckpointSlotType::ArrayString,
                            other => {
                                return Err(format!(
                                    "checkpoint slot `{key}` has unsupported type `{other}`"
                                ));
                            }
                        };
                        let required = prop_bool(child, "required")?;
                        let max_entries = if value_type == CheckpointSlotType::ArrayString {
                            Some(prop_usize(child, "max_entries")?)
                        } else {
                            None
                        };
                        let max_bytes = prop_usize(child, "max_bytes")?;
                        nonempty_prop(child, "doc")?;
                        slots.push(CheckpointSlot {
                            key,
                            value_type,
                            required,
                            max_entries,
                            max_bytes,
                        });
                    }
                    if slot_sets
                        .insert(
                            id.clone(),
                            SlotSet {
                                output_contract,
                                slots,
                            },
                        )
                        .is_some()
                    {
                        return Err(format!("duplicate slot_set `{id}`"));
                    }
                }
                "role_policy" => {
                    let role_id = arg_string(node, 0)?.to_owned();
                    let interruptible = prop_bool(node, "interruptible")?;
                    let slot_set = prop_string_optional(node, "slot_set")?.map(str::to_owned);
                    nonempty_prop(node, "reason")?;
                    if interruptible && slot_set.is_none() {
                        return Err(format!("interruptible role `{role_id}` missing slot_set"));
                    }
                    if !interruptible && slot_set.is_some() {
                        return Err(format!(
                            "non-interruptible role `{role_id}` must not declare slot_set"
                        ));
                    }
                    if roles
                        .insert(
                            role_id.clone(),
                            RoleCheckpointPolicy {
                                interruptible,
                                slot_set,
                            },
                        )
                        .is_some()
                    {
                        return Err(format!("duplicate role_policy `{role_id}`"));
                    }
                }
                other => return Err(format!("unknown checkpoint policy node `{other}`")),
            }
        }

        if !schema_seen {
            return Err("missing checkpoint policy schema".to_owned());
        }
        if !version_seen {
            return Err("missing checkpoint policy version".to_owned());
        }
        let policy = Self {
            handoff_contract: handoff_contract
                .ok_or_else(|| "missing handoff_contract".to_owned())?,
            thresholds,
            bounds: bounds.ok_or_else(|| "missing handoff_bounds".to_owned())?,
            slot_sets,
            roles,
        };
        policy.validate_shape()?;
        for (role_id, role) in &policy.roles {
            match &role.slot_set {
                Some(slot_set_id) if !policy.slot_sets.contains_key(slot_set_id) => {
                    return Err(format!(
                        "role `{role_id}` references unknown slot_set `{slot_set_id}`"
                    ));
                }
                _ => {}
            }
        }
        Ok(policy)
    }

    pub fn validate_shape(&self) -> Result<(), String> {
        let arm = self
            .thresholds
            .get("arm")
            .ok_or_else(|| "missing arm threshold".to_owned())?;
        let checkpoint = self
            .thresholds
            .get("checkpoint")
            .ok_or_else(|| "missing checkpoint threshold".to_owned())?;
        if !(0 < *arm && *arm < *checkpoint && *checkpoint < 100) {
            return Err(format!(
                "incoherent thresholds arm={arm} checkpoint={checkpoint}"
            ));
        }

        let bounds = &self.bounds;
        for (name, value) in [
            ("completed_max_entries", bounds.completed_max_entries),
            ("remaining_max_entries", bounds.remaining_max_entries),
            ("entry_max_bytes", bounds.entry_max_bytes),
            ("total_max_bytes", bounds.total_max_bytes),
            ("critical_state_max_slots", bounds.critical_state_max_slots),
            (
                "critical_state_value_max_bytes",
                bounds.critical_state_value_max_bytes,
            ),
            (
                "critical_state_array_max_entries",
                bounds.critical_state_array_max_entries,
            ),
        ] {
            if value == 0 {
                return Err(format!("bound `{name}` must be positive"));
            }
        }
        if bounds.entry_max_bytes > bounds.total_max_bytes
            || bounds.critical_state_value_max_bytes > bounds.total_max_bytes
            || bounds.completed_max_entries * bounds.entry_max_bytes > bounds.total_max_bytes
            || bounds.remaining_max_entries * bounds.entry_max_bytes > bounds.total_max_bytes
        {
            return Err("handoff bounds exceed total_max_bytes".to_owned());
        }

        for (slot_set_id, slot_set) in &self.slot_sets {
            if slot_set.output_contract.trim().is_empty() {
                return Err(format!("slot_set `{slot_set_id}` missing output_contract"));
            }
            if slot_set.slots.len() > bounds.critical_state_max_slots {
                return Err(format!(
                    "slot_set `{slot_set_id}` exceeds critical_state_max_slots"
                ));
            }
            if !slot_set.slots.iter().any(|slot| slot.required) {
                return Err(format!("slot_set `{slot_set_id}` has no required slots"));
            }
            for slot in &slot_set.slots {
                if slot.max_bytes == 0 || slot.max_bytes > bounds.critical_state_value_max_bytes {
                    return Err(format!("slot `{}` has incoherent max_bytes", slot.key));
                }
                match slot.max_entries {
                    Some(max_entries)
                        if max_entries == 0
                            || max_entries > bounds.critical_state_array_max_entries =>
                    {
                        return Err(format!("slot `{}` has incoherent max_entries", slot.key));
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }

    pub fn role(&self, role_id: &str) -> Result<&RoleCheckpointPolicy, String> {
        self.roles
            .get(role_id)
            .ok_or_else(|| format!("unknown checkpoint role `{role_id}`"))
    }

    pub fn interruptible_roles(&self) -> impl Iterator<Item = &str> {
        self.roles
            .iter()
            .filter(|(_, policy)| policy.interruptible)
            .map(|(role_id, _)| role_id.as_str())
    }

    pub fn required_slots(&self, role_id: &str) -> Result<Vec<&CheckpointSlot>, String> {
        let role = self.role(role_id)?;
        if !role.interruptible {
            return Err(format!("role `{role_id}` is not interruptible"));
        }
        let slot_set_id = role
            .slot_set
            .as_ref()
            .ok_or_else(|| format!("role `{role_id}` missing slot_set"))?;
        let slots = self.slot_sets.get(slot_set_id).ok_or_else(|| {
            format!("role `{role_id}` references unknown slot_set `{slot_set_id}`")
        })?;
        Ok(slots.slots.iter().filter(|slot| slot.required).collect())
    }

    pub fn required_slot_names(&self, role_id: &str) -> Result<Vec<String>, String> {
        Ok(self
            .required_slots(role_id)?
            .into_iter()
            .map(|slot| slot.key.clone())
            .collect())
    }

    pub fn required_slot_names_from_handoff(
        &self,
        handoff: &AgentHandoff,
    ) -> Result<Vec<String>, String> {
        let mut names = handoff.critical_state.keys().cloned().collect::<Vec<_>>();
        names.sort();
        Ok(names)
    }

    pub fn validate_handoff_text(&self, role_id: &str, text: &str) -> Result<AgentHandoff, String> {
        let value: Value = serde_json::from_str(text)
            .map_err(|error| format!("agent-run handoff is not strict JSON: {error}"))?;
        let handoff: AgentHandoff = serde_json::from_value(value)
            .map_err(|error| format!("agent-run typed handoff deserialize failed: {error}"))?;
        self.validate_handoff_with_total(role_id, handoff, text.len())
    }

    pub fn validate_handoff(
        &self,
        role_id: &str,
        handoff: AgentHandoff,
    ) -> Result<AgentHandoff, String> {
        let total_bytes = serde_json::to_vec(&handoff)
            .map_err(|error| format!("checkpoint handoff serialize failed: {error}"))?
            .len();
        self.validate_handoff_with_total(role_id, handoff, total_bytes)
    }

    fn validate_handoff_with_total(
        &self,
        role_id: &str,
        handoff: AgentHandoff,
        total_bytes: usize,
    ) -> Result<AgentHandoff, String> {
        if handoff.completed.iter().any(|item| item.trim().is_empty())
            || handoff.remaining.iter().any(|item| item.trim().is_empty())
            || handoff.next_action.trim().is_empty()
        {
            return Err("agent-run handoff contains blank required entries".to_owned());
        }
        validate_string_list(
            "completed",
            &handoff.completed,
            self.bounds.completed_max_entries,
            self.bounds.entry_max_bytes,
        )?;
        validate_string_list(
            "remaining",
            &handoff.remaining,
            self.bounds.remaining_max_entries,
            self.bounds.entry_max_bytes,
        )?;
        enforce_bound(
            "entry_max_bytes",
            handoff.next_action.len(),
            self.bounds.entry_max_bytes,
            "next_action",
        )?;
        enforce_bound(
            "critical_state_max_slots",
            handoff.critical_state.len(),
            self.bounds.critical_state_max_slots,
            "critical_state",
        )?;
        for (key, value) in &handoff.critical_state {
            if !json_depth_two(value) {
                return Err(format!(
                    "agent-run handoff critical_state slot `{key}` exceeds depth 2"
                ));
            }
            let value_bytes = serde_json::to_vec(value)
                .map_err(|error| format!("checkpoint handoff value serialize failed: {error}"))?
                .len();
            enforce_bound(
                "critical_state_value_max_bytes",
                value_bytes,
                self.bounds.critical_state_value_max_bytes,
                &format!("critical_state.{key}"),
            )?;
        }
        for slot in self.required_slots(role_id)? {
            let value = handoff.critical_state.get(&slot.key).ok_or_else(|| {
                format!(
                    "agent-run role `{role_id}` missing required critical_state slot `{}`",
                    slot.key
                )
            })?;
            let value_bytes = serde_json::to_vec(value)
                .map_err(|error| format!("checkpoint handoff slot serialize failed: {error}"))?
                .len();
            enforce_bound(
                "max_bytes",
                value_bytes,
                slot.max_bytes,
                &format!("critical_state.{}", slot.key),
            )?;
            match slot.value_type {
                CheckpointSlotType::String => {
                    if value.as_str().is_none_or(|item| item.trim().is_empty()) {
                        return Err(format!(
                            "agent-run critical_state slot `{}` must be a non-empty string",
                            slot.key
                        ));
                    }
                }
                CheckpointSlotType::ArrayString => {
                    let values = value.as_array().ok_or_else(|| {
                        format!(
                            "agent-run critical_state slot `{}` must be an array",
                            slot.key
                        )
                    })?;
                    let max_entries = slot.max_entries.expect("array slot has max_entries");
                    enforce_bound(
                        "max_entries",
                        values.len(),
                        max_entries,
                        &format!("critical_state.{}", slot.key),
                    )?;
                    if values.is_empty()
                        || values
                            .iter()
                            .any(|item| item.as_str().is_none_or(|text| text.trim().is_empty()))
                    {
                        return Err(format!(
                            "agent-run critical_state slot `{}` must contain non-empty strings",
                            slot.key
                        ));
                    }
                }
            }
        }
        enforce_bound(
            "total_max_bytes",
            total_bytes,
            self.bounds.total_max_bytes,
            "handoff",
        )?;
        Ok(handoff)
    }
}

fn validate_string_list(
    field: &str,
    values: &[String],
    max_entries: usize,
    entry_max_bytes: usize,
) -> Result<(), String> {
    enforce_bound(
        if field == "completed" {
            "completed_max_entries"
        } else {
            "remaining_max_entries"
        },
        values.len(),
        max_entries,
        field,
    )?;
    for (index, value) in values.iter().enumerate() {
        enforce_bound(
            "entry_max_bytes",
            value.len(),
            entry_max_bytes,
            &format!("{field}[{index}]"),
        )?;
    }
    Ok(())
}

fn enforce_bound(bound: &str, observed: usize, limit: usize, location: &str) -> Result<(), String> {
    if observed > limit {
        return Err(format!(
            "checkpoint handoff violates {bound} at {location}: observed {observed} > limit {limit}"
        ));
    }
    Ok(())
}

fn json_depth_two(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => true,
        Value::Array(items) => items.iter().all(|item| {
            matches!(
                item,
                Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
            )
        }),
        Value::Object(_) => false,
    }
}

fn arg_value(node: &KdlNode, index: usize) -> Result<&KdlValue, String> {
    node.entries()
        .iter()
        .filter(|entry| entry.name().is_none())
        .nth(index)
        .map(KdlEntry::value)
        .ok_or_else(|| format!("node `{}` missing argument {index}", node.name().value()))
}

fn arg_string(node: &KdlNode, index: usize) -> Result<&str, String> {
    arg_value(node, index)?.as_string().ok_or_else(|| {
        format!(
            "node `{}` argument {index} must be string",
            node.name().value()
        )
    })
}

fn arg_u64(node: &KdlNode, index: usize) -> Result<u64, String> {
    let integer = arg_value(node, index)?.as_integer().ok_or_else(|| {
        format!(
            "node `{}` argument {index} must be integer",
            node.name().value()
        )
    })?;
    u64::try_from(integer).map_err(|_| {
        format!(
            "node `{}` argument {index} must be non-negative",
            node.name().value()
        )
    })
}

fn prop_value<'a>(node: &'a KdlNode, key: &str) -> Result<&'a KdlValue, String> {
    node.entry(key)
        .map(KdlEntry::value)
        .ok_or_else(|| format!("node `{}` missing property `{key}`", node.name().value()))
}

fn prop_string<'a>(node: &'a KdlNode, key: &str) -> Result<&'a str, String> {
    prop_value(node, key)?.as_string().ok_or_else(|| {
        format!(
            "node `{}` property `{key}` must be string",
            node.name().value()
        )
    })
}

fn prop_string_optional<'a>(node: &'a KdlNode, key: &str) -> Result<Option<&'a str>, String> {
    match node.entry(key) {
        Some(entry) => entry.value().as_string().map(Some).ok_or_else(|| {
            format!(
                "node `{}` property `{key}` must be string",
                node.name().value()
            )
        }),
        None => Ok(None),
    }
}

fn nonempty_prop<'a>(node: &'a KdlNode, key: &str) -> Result<&'a str, String> {
    let value = prop_string(node, key)?;
    if value.trim().is_empty() {
        return Err(format!(
            "node `{}` property `{key}` must be non-empty",
            node.name().value()
        ));
    }
    Ok(value)
}

fn prop_bool(node: &KdlNode, key: &str) -> Result<bool, String> {
    prop_value(node, key)?.as_bool().ok_or_else(|| {
        format!(
            "node `{}` property `{key}` must be bool",
            node.name().value()
        )
    })
}

fn prop_u64(node: &KdlNode, key: &str) -> Result<u64, String> {
    let integer = prop_value(node, key)?.as_integer().ok_or_else(|| {
        format!(
            "node `{}` property `{key}` must be integer",
            node.name().value()
        )
    })?;
    u64::try_from(integer).map_err(|_| {
        format!(
            "node `{}` property `{key}` must be non-negative",
            node.name().value()
        )
    })
}

fn prop_usize(node: &KdlNode, key: &str) -> Result<usize, String> {
    usize::try_from(prop_u64(node, key)?).map_err(|_| {
        format!(
            "node `{}` property `{key}` does not fit usize",
            node.name().value()
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HandoffSchema {
    #[serde(rename = "autopilot.agent-handoff.v1")]
    V1,
}

#[derive(Debug, Clone, PartialEq)]
// Keep the public enum shape stable for checkpoint callers; boxing the variant would alter matching/construction API.
#[allow(clippy::large_enum_variant)]
pub enum ContextDecision {
    Continue,
    SoftWarning,
    CheckpointAndSettle(CheckpointRecord),
    Unknown(UnknownBudget),
}

impl ContextDecision {
    pub fn apply_action(
        &self,
        action: ContextAction,
    ) -> Result<ContextActionOutcome, ContextActionError> {
        match (self, action) {
            (Self::Continue | Self::SoftWarning, ContextAction::StartWork)
            | (Self::Continue | Self::SoftWarning, ContextAction::ClaimTerminalSuccess) => {
                Ok(ContextActionOutcome::Allowed)
            }
            (Self::CheckpointAndSettle(_), ContextAction::StartWork)
            | (Self::CheckpointAndSettle(_), ContextAction::ClaimTerminalSuccess) => {
                Err(ContextActionError::CheckpointRequired)
            }
            (Self::Unknown(_), ContextAction::StartWork) => {
                Err(ContextActionError::UnknownBlocksWork)
            }
            (Self::Unknown(_), ContextAction::ClaimTerminalSuccess) => {
                Err(ContextActionError::UnknownBlocksTerminalSuccess)
            }
            (Self::Unknown(_), ContextAction::InjectRetainedHandoff(overlay)) => {
                Ok(ContextActionOutcome::ResumeOnly { overlay })
            }
            (
                Self::Continue | Self::SoftWarning | Self::CheckpointAndSettle(_),
                ContextAction::InjectRetainedHandoff(_),
            ) => Err(ContextActionError::RecoveryOnlyWhenBudgetUnknown),
        }
    }

    pub fn allows_new_work(&self) -> bool {
        self.apply_action(ContextAction::StartWork).is_ok()
    }

    pub fn allows_terminal_success(&self) -> bool {
        self.apply_action(ContextAction::ClaimTerminalSuccess)
            .is_ok()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnknownBudget;

#[derive(Debug, Clone, PartialEq)]
pub enum ContextAction {
    StartWork,
    ClaimTerminalSuccess,
    InjectRetainedHandoff(ResumeOverlay),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ContextActionOutcome {
    Allowed,
    ResumeOnly { overlay: ResumeOverlay },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextActionError {
    UnknownBlocksWork,
    UnknownBlocksTerminalSuccess,
    CheckpointRequired,
    RecoveryOnlyWhenBudgetUnknown,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CheckpointError {
    Budget(ContextBudgetError),
    Identity(IdentityError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityError {
    PlanningCarriesLane,
    PlanningCarriesBaseCommit,
    PlanningCarriesCurrentCommit,
    PlanningCarriesDirtyPaths,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CompactionOutcome {
    Resumed {
        overlay: ResumeOverlay,
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

pub trait CheckpointSource {
    fn render_checkpoint(&self, percent: ContextPercent)
        -> Result<CheckpointRecord, IdentityError>;
}

pub fn observe_context<B, S>(budget: B, state: &S) -> Result<ContextDecision, CheckpointError>
where
    B: IntoContextBudget,
    S: CheckpointSource + ?Sized,
{
    let budget = budget
        .into_context_budget()
        .map_err(CheckpointError::Budget)?;
    match budget {
        ContextBudget::Unknown => Ok(ContextDecision::Unknown(UnknownBudget)),
        ContextBudget::Known(percent) if percent.as_f64() >= 85.0 => state
            .render_checkpoint(percent)
            .map(ContextDecision::CheckpointAndSettle)
            .map_err(CheckpointError::Identity),
        ContextBudget::Known(percent) if percent.as_f64() >= 75.0 => {
            Ok(ContextDecision::SoftWarning)
        }
        ContextBudget::Known(_) => Ok(ContextDecision::Continue),
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
        Err(failure) => CompactionOutcome::Recoverable {
            checkpoint,
            failure,
        },
    }
}

impl CheckpointSource for CheckpointInput {
    fn render_checkpoint(
        &self,
        percent: ContextPercent,
    ) -> Result<CheckpointRecord, IdentityError> {
        Ok(CheckpointRecord {
            assignment_id: self.assignment_id.clone(),
            context_percent: percent,
            identity: self.identity.clone(),
            resume_overlay: ResumeOverlay {
                assignment_id: self.assignment_id.clone(),
                session_ref: self.session_ref.clone(),
                run_revision: self.run_revision,
                handoff: self.handoff.clone(),
            },
        })
    }
}

impl CheckpointSource for AssignmentState<Id, Sha, Sha> {
    fn render_checkpoint(
        &self,
        percent: ContextPercent,
    ) -> Result<CheckpointRecord, IdentityError> {
        let preservation = if self.dirty_paths.is_empty() {
            PreservationEvidence::CleanCurrentCommit {
                commit: self.current_commit.clone(),
            }
        } else {
            PreservationEvidence::NoPreservationCommit {
                dirty_paths: self.dirty_paths.clone(),
            }
        };
        let input = CheckpointInput::execution(
            self.assignment_id.clone(),
            self.run_revision,
            self.session_ref.clone(),
            self.lane_id.clone(),
            self.base_commit.clone(),
            self.current_commit.clone(),
            preservation,
            AgentHandoff::new(
                ids(&self.completed),
                ids(&self.remaining),
                BTreeMap::new(),
                self.next_action.clone(),
            ),
        );
        input.render_checkpoint(percent)
    }
}

impl CheckpointSource for AssignmentState<Option<Id>, Option<Sha>, Option<Sha>> {
    fn render_checkpoint(
        &self,
        percent: ContextPercent,
    ) -> Result<CheckpointRecord, IdentityError> {
        if self.lane_id.is_some() {
            return Err(IdentityError::PlanningCarriesLane);
        }
        if self.base_commit.is_some() {
            return Err(IdentityError::PlanningCarriesBaseCommit);
        }
        if self.current_commit.is_some() {
            return Err(IdentityError::PlanningCarriesCurrentCommit);
        }
        if !self.dirty_paths.is_empty() {
            return Err(IdentityError::PlanningCarriesDirtyPaths);
        }
        let input = CheckpointInput::planning(
            self.assignment_id.clone(),
            self.run_revision,
            self.session_ref.clone(),
            AgentHandoff::new(
                ids(&self.completed),
                ids(&self.remaining),
                BTreeMap::new(),
                self.next_action.clone(),
            ),
        );
        input.render_checkpoint(percent)
    }
}

fn ids(values: &[Id]) -> Vec<String> {
    values.iter().map(|value| value.0.clone()).collect()
}
