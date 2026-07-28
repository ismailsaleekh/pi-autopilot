use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use kdl::{KdlDocument, KdlEntry, KdlNode, KdlValue};
use serde_json::{Value, json};

const POLICY: &str = include_str!("../data/checkpoint-policy.kdl");
const CONTRACTS: &str = include_str!("../data/contracts.kdl");
const ROLES: &str = include_str!("../data/roles.kdl");

#[test]
fn checkpoint_policy_resolves_declared_roles_and_rejects_unknown() {
    let policy = parse_policy(&policy_source()).expect("checkpoint policy parses");
    let role_ids = parse_role_ids(ROLES).expect("roles parse");

    let declared: BTreeSet<_> = policy.roles.keys().cloned().collect();
    assert_eq!(
        declared, role_ids,
        "every data/roles.kdl role must have an explicit checkpoint interruptibility decision"
    );

    for (role_id, role_policy) in &policy.roles {
        let resolved = policy.role(role_id).expect("declared role resolves");
        assert_eq!(resolved.interruptible, role_policy.interruptible);
        if resolved.interruptible {
            let slot_set = resolved
                .slot_set
                .as_ref()
                .and_then(|id| policy.slot_sets.get(id))
                .unwrap_or_else(|| panic!("{role_id} interruptible role slot_set resolves"));
            assert!(!slot_set.slots.is_empty(), "{role_id} slot_set has slots");
        }
    }

    let error = policy
        .role("not-a-role")
        .expect_err("unknown role rejected");
    assert_eq!(error, "unknown checkpoint role `not-a-role`");
}

#[test]
fn checkpoint_policy_required_slots_depth_and_bounds_are_well_formed() {
    let policy = parse_policy(&policy_source()).expect("checkpoint policy parses");

    assert_eq!(policy.handoff_contract, "autopilot.agent-handoff.v1");
    assert_eq!(policy.thresholds.get("arm"), Some(&75));
    assert_eq!(policy.thresholds.get("checkpoint"), Some(&85));
    validate_policy_shape(&policy).expect("policy shape and bounds are coherent");

    for role_id in policy.interruptible_roles() {
        let handoff = complete_handoff_for_role(&policy, role_id);
        validate_handoff(&policy, role_id, &handoff).unwrap_or_else(|error| {
            panic!("valid handoff for {role_id} rejected: {error}");
        });

        let mut missing = handoff.clone();
        let first_slot = policy
            .required_slots(role_id)
            .expect("required slots")
            .first()
            .expect("at least one slot")
            .key
            .clone();
        missing
            .get_mut("critical_state")
            .and_then(Value::as_object_mut)
            .expect("critical_state object")
            .remove(&first_slot);
        let error =
            validate_handoff(&policy, role_id, &missing).expect_err("missing slot rejected");
        assert_eq!(
            error,
            format!("role `{role_id}` missing required critical_state slot `{first_slot}`")
        );

        let mut deep = handoff;
        deep.get_mut("critical_state")
            .and_then(Value::as_object_mut)
            .expect("critical_state object")
            .insert(
                "unexpected_nested".to_owned(),
                json!({ "nested": "forbidden" }),
            );
        let error = validate_handoff(&policy, role_id, &deep).expect_err("depth overflow rejected");
        assert_eq!(
            error,
            "critical_state slot `unexpected_nested` exceeds depth 2"
        );
    }
}

#[test]
fn checkpoint_policy_agent_handoff_artifact_shape_is_five_required_fields() {
    let contracts = contracts_source();
    let artifact = handoff_artifact(&contracts).expect("agent_handoff artifact exists");
    assert_eq!(
        prop_string(&artifact, "schema").expect("schema prop"),
        "autopilot.agent-handoff.v1"
    );
    assert_eq!(
        prop_string(&artifact, "producer").expect("producer prop"),
        "Model"
    );
    assert_eq!(
        prop_bool(&artifact, "model_produced").expect("model_produced prop"),
        true
    );

    let required = required_child_names(&artifact).expect("required fields");
    assert_eq!(
        required,
        vec![
            "schema",
            "completed",
            "remaining",
            "critical_state",
            "next_action"
        ],
        "autopilot.agent-handoff.v1 must keep exactly five required model-facing fields",
    );

    let critical_state =
        child_named_arg(&artifact, "field", "critical_state").expect("critical_state field");
    assert_eq!(
        prop_string(critical_state, "type").expect("critical_state type"),
        "object"
    );
    let admits = child_text(&artifact, "admits").expect("admits text");
    assert!(
        admits.contains("schema, completed, remaining, critical_state, and next_action"),
        "admits must plainly tell the model what to produce",
    );
}

#[test]
fn checkpoint_policy_agent_handoff_validator_preserves_unknown_properties() {
    let policy = parse_policy(&policy_source()).expect("checkpoint policy parses");
    let mut handoff = complete_handoff_for_role(&policy, "repository-scout");
    handoff
        .as_object_mut()
        .expect("handoff object")
        .insert("separator_marker".to_owned(), json!("A\u{2028}B\u{2029}C"));

    let preserved =
        validate_handoff(&policy, "repository-scout", &handoff).expect("extra fields accepted");
    assert_eq!(
        preserved.get("separator_marker"),
        Some(&json!("A\u{2028}B\u{2029}C"))
    );
}

#[test]
fn malformed_checkpoint_policy_fails_loudly() {
    let broken = policy_source().replace(
        "role_policy \"task-extractor\" interruptible=#true slot_set=\"task-atom-ledger\"",
        "role_policy \"task-extractor\" interruptible=#true slot_set=\"missing-ledger\"",
    );
    let error = parse_policy(&broken).expect_err("malformed policy rejected");
    assert_eq!(
        error,
        "role `task-extractor` references unknown slot_set `missing-ledger`"
    );
}

#[derive(Debug, Clone)]
struct Policy {
    handoff_contract: String,
    thresholds: BTreeMap<String, u64>,
    bounds: HandoffBounds,
    slot_sets: BTreeMap<String, SlotSet>,
    roles: BTreeMap<String, RolePolicy>,
}

#[derive(Debug, Clone)]
struct HandoffBounds {
    completed_max_entries: usize,
    remaining_max_entries: usize,
    entry_max_bytes: usize,
    total_max_bytes: usize,
    critical_state_max_slots: usize,
    critical_state_value_max_bytes: usize,
    critical_state_array_max_entries: usize,
}

#[derive(Debug, Clone)]
struct SlotSet {
    output_contract: String,
    slots: Vec<Slot>,
}

#[derive(Debug, Clone)]
struct Slot {
    key: String,
    value_type: SlotType,
    required: bool,
    max_entries: Option<usize>,
    max_bytes: usize,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum SlotType {
    String,
    ArrayString,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct RolePolicy {
    interruptible: bool,
    slot_set: Option<String>,
}

impl Policy {
    fn role(&self, role_id: &str) -> Result<&RolePolicy, String> {
        self.roles
            .get(role_id)
            .ok_or_else(|| format!("unknown checkpoint role `{role_id}`"))
    }

    fn interruptible_roles(&self) -> impl Iterator<Item = &str> {
        self.roles
            .iter()
            .filter(|(_, policy)| policy.interruptible)
            .map(|(role_id, _)| role_id.as_str())
    }

    fn required_slots(&self, role_id: &str) -> Result<Vec<&Slot>, String> {
        let role = self.role(role_id)?;
        if !role.interruptible {
            return Err(format!("role `{role_id}` is not interruptible"));
        }
        let slot_set_id = role
            .slot_set
            .as_ref()
            .ok_or_else(|| format!("role `{role_id}` missing slot_set"))?;
        let slot_set = self.slot_sets.get(slot_set_id).ok_or_else(|| {
            format!("role `{role_id}` references unknown slot_set `{slot_set_id}`")
        })?;
        Ok(slot_set.slots.iter().filter(|slot| slot.required).collect())
    }
}

fn policy_source() -> String {
    source_from_env("CHECKPOINT_POLICY_KDL", POLICY)
}

fn contracts_source() -> String {
    source_from_env("CHECKPOINT_CONTRACTS_KDL", CONTRACTS)
}

fn source_from_env(var: &str, default: &str) -> String {
    match std::env::var_os(var) {
        Some(path) => std::fs::read_to_string(PathBuf::from(path))
            .unwrap_or_else(|error| panic!("failed to read {var} override: {error}")),
        None => default.to_owned(),
    }
}

fn parse_policy(source: &str) -> Result<Policy, String> {
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
                        "string" => SlotType::String,
                        "array<string>" => SlotType::ArrayString,
                        other => {
                            return Err(format!("slot `{key}` has unsupported type `{other}`"));
                        }
                    };
                    let required = prop_bool(child, "required")?;
                    let max_entries = if value_type == SlotType::ArrayString {
                        Some(prop_usize(child, "max_entries")?)
                    } else {
                        None
                    };
                    let max_bytes = prop_usize(child, "max_bytes")?;
                    nonempty_prop(child, "doc")?;
                    slots.push(Slot {
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
                        RolePolicy {
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
    let policy = Policy {
        handoff_contract: handoff_contract.ok_or_else(|| "missing handoff_contract".to_owned())?,
        thresholds,
        bounds: bounds.ok_or_else(|| "missing handoff_bounds".to_owned())?,
        slot_sets,
        roles,
    };
    validate_policy_shape(&policy)?;
    for (role_id, role) in &policy.roles {
        if let Some(slot_set_id) = &role.slot_set {
            if !policy.slot_sets.contains_key(slot_set_id) {
                return Err(format!(
                    "role `{role_id}` references unknown slot_set `{slot_set_id}`"
                ));
            }
        }
    }
    Ok(policy)
}

fn validate_policy_shape(policy: &Policy) -> Result<(), String> {
    let arm = policy
        .thresholds
        .get("arm")
        .ok_or_else(|| "missing arm threshold".to_owned())?;
    let checkpoint = policy
        .thresholds
        .get("checkpoint")
        .ok_or_else(|| "missing checkpoint threshold".to_owned())?;
    if !(0 < *arm && *arm < *checkpoint && *checkpoint < 100) {
        return Err(format!(
            "incoherent thresholds arm={arm} checkpoint={checkpoint}"
        ));
    }

    let bounds = &policy.bounds;
    let positive = [
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
    ];
    for (name, value) in positive {
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

    for (slot_set_id, slot_set) in &policy.slot_sets {
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
            if let Some(max_entries) = slot.max_entries {
                if max_entries == 0 || max_entries > bounds.critical_state_array_max_entries {
                    return Err(format!("slot `{}` has incoherent max_entries", slot.key));
                }
            }
        }
    }
    Ok(())
}

fn complete_handoff_for_role(policy: &Policy, role_id: &str) -> Value {
    let slots = policy.required_slots(role_id).expect("role slots");
    let mut critical_state = serde_json::Map::new();
    for slot in slots {
        let value = match slot.value_type {
            SlotType::String => json!(format!("{} preserved", slot.key)),
            SlotType::ArrayString => json!([format!("{} item", slot.key)]),
        };
        critical_state.insert(slot.key.clone(), value);
    }
    json!({
        "schema": "autopilot.agent-handoff.v1",
        "completed": ["one completed obligation"],
        "remaining": ["one remaining obligation"],
        "critical_state": critical_state,
        "next_action": "continue with the next unchecked obligation"
    })
}

fn validate_handoff(policy: &Policy, role_id: &str, handoff: &Value) -> Result<Value, String> {
    let object = handoff
        .as_object()
        .ok_or_else(|| "handoff must be an object".to_owned())?;
    if object.get("schema") != Some(&json!("autopilot.agent-handoff.v1")) {
        return Err("handoff schema must be autopilot.agent-handoff.v1".to_owned());
    }
    validate_string_array(
        object,
        "completed",
        policy.bounds.completed_max_entries,
        policy.bounds.entry_max_bytes,
    )?;
    validate_string_array(
        object,
        "remaining",
        policy.bounds.remaining_max_entries,
        policy.bounds.entry_max_bytes,
    )?;
    let next_action = object
        .get("next_action")
        .and_then(Value::as_str)
        .ok_or_else(|| "next_action must be a string".to_owned())?;
    if next_action.trim().is_empty() || next_action.len() > policy.bounds.entry_max_bytes {
        return Err("next_action is blank or oversized".to_owned());
    }
    let critical_state = object
        .get("critical_state")
        .and_then(Value::as_object)
        .ok_or_else(|| "critical_state must be an object".to_owned())?;
    if critical_state.len() > policy.bounds.critical_state_max_slots {
        return Err("critical_state exceeds critical_state_max_slots".to_owned());
    }
    for (key, value) in critical_state {
        if !is_scalar_or_array_of_scalars(value) {
            return Err(format!("critical_state slot `{key}` exceeds depth 2"));
        }
        if serde_json::to_vec(value)
            .map_err(|error| error.to_string())?
            .len()
            > policy.bounds.critical_state_value_max_bytes
        {
            return Err(format!("critical_state slot `{key}` exceeds max_bytes"));
        }
    }
    for slot in policy.required_slots(role_id)? {
        let value = critical_state.get(&slot.key).ok_or_else(|| {
            format!(
                "role `{role_id}` missing required critical_state slot `{}`",
                slot.key
            )
        })?;
        match slot.value_type {
            SlotType::String => {
                if value.as_str().is_none_or(str::is_empty) {
                    return Err(format!(
                        "critical_state slot `{}` must be a non-empty string",
                        slot.key
                    ));
                }
            }
            SlotType::ArrayString => {
                let values = value.as_array().ok_or_else(|| {
                    format!("critical_state slot `{}` must be an array", slot.key)
                })?;
                let max_entries = slot.max_entries.expect("array slot has max entries");
                if values.len() > max_entries {
                    return Err(format!(
                        "critical_state slot `{}` exceeds max_entries",
                        slot.key
                    ));
                }
                for item in values {
                    if item.as_str().is_none_or(str::is_empty) {
                        return Err(format!(
                            "critical_state slot `{}` must contain only non-empty strings",
                            slot.key
                        ));
                    }
                }
            }
        }
    }
    if serde_json::to_vec(handoff)
        .map_err(|error| error.to_string())?
        .len()
        > policy.bounds.total_max_bytes
    {
        return Err("handoff exceeds total_max_bytes".to_owned());
    }
    Ok(handoff.clone())
}

fn validate_string_array(
    object: &serde_json::Map<String, Value>,
    key: &str,
    max_entries: usize,
    max_entry_bytes: usize,
) -> Result<(), String> {
    let values = object
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{key} must be an array"))?;
    if values.len() > max_entries {
        return Err(format!("{key} exceeds max_entries"));
    }
    for value in values {
        let text = value
            .as_str()
            .ok_or_else(|| format!("{key} entries must be strings"))?;
        if text.trim().is_empty() || text.len() > max_entry_bytes {
            return Err(format!("{key} entry is blank or oversized"));
        }
    }
    Ok(())
}

fn is_scalar_or_array_of_scalars(value: &Value) -> bool {
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

fn parse_role_ids(source: &str) -> Result<BTreeSet<String>, String> {
    let doc = source
        .parse::<KdlDocument>()
        .map_err(|error| format!("roles KDL parse error: {error}"))?;
    let mut roles = BTreeSet::new();
    for node in doc.nodes() {
        if node.name().value() == "role" {
            let id = arg_string(node, 0)?.to_owned();
            if !roles.insert(id.clone()) {
                return Err(format!("duplicate role `{id}`"));
            }
        }
    }
    Ok(roles)
}

fn handoff_artifact(source: &str) -> Result<KdlNode, String> {
    let doc = source
        .parse::<KdlDocument>()
        .map_err(|error| format!("contracts KDL parse error: {error}"))?;
    for node in doc.nodes() {
        if node.name().value() == "artifact" && arg_string(node, 0)? == "agent_handoff" {
            return Ok(node.clone());
        }
    }
    Err("missing artifact `agent_handoff`".to_owned())
}

fn required_child_names(artifact: &KdlNode) -> Result<Vec<&str>, String> {
    let children = artifact
        .children()
        .ok_or_else(|| "artifact missing children".to_owned())?;
    let mut names = Vec::new();
    for child in children.nodes() {
        match child.name().value() {
            "field" | "list" | "group" => {
                if prop_bool(child, "required")? {
                    names.push(arg_string(child, 0)?);
                }
            }
            _ => {}
        }
    }
    Ok(names)
}

fn child_named_arg<'a>(
    parent: &'a KdlNode,
    child_name: &str,
    arg: &str,
) -> Result<&'a KdlNode, String> {
    let children = parent
        .children()
        .ok_or_else(|| format!("node `{}` missing children", parent.name().value()))?;
    children
        .nodes()
        .iter()
        .find(|child| child.name().value() == child_name && arg_string(child, 0).ok() == Some(arg))
        .ok_or_else(|| format!("missing child `{child_name}` `{arg}`"))
}

fn child_text(parent: &KdlNode, child_name: &str) -> Result<String, String> {
    let children = parent
        .children()
        .ok_or_else(|| format!("node `{}` missing children", parent.name().value()))?;
    children
        .nodes()
        .iter()
        .find(|child| child.name().value() == child_name)
        .map(|child| arg_string(child, 0).map(str::to_owned))
        .transpose()?
        .ok_or_else(|| format!("missing child `{child_name}`"))
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
