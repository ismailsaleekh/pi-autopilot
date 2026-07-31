use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use drivers::checkpoint::{CheckpointPolicy, CheckpointSlotType};
use kdl::{KdlDocument, KdlEntry, KdlNode, KdlValue};
use serde_json::{Value, json};

const POLICY: &str = include_str!("../data/checkpoint-policy.kdl");
const CONTRACTS: &str = include_str!("../data/contracts.kdl");
const ROLES: &str = include_str!("../data/roles.kdl");

#[test]
fn checkpoint_policy_resolves_declared_roles_and_rejects_unknown() {
    let policy =
        CheckpointPolicy::parse_source(&policy_source()).expect("checkpoint policy parses");
    let role_ids = parse_role_ids(ROLES).expect("roles parse");

    let declared: BTreeSet<_> = policy.roles.keys().cloned().collect();
    assert_eq!(
        declared, role_ids,
        "every data/roles.kdl role must have an explicit checkpoint interruptibility decision"
    );

    let expected_roles = BTreeMap::from([
        ("task-extractor", (true, Some("task-atom-ledger"))),
        (
            "repository-scout",
            (true, Some("evidence-selection-ledger")),
        ),
        ("context-curator", (true, Some("evidence-selection-ledger"))),
        ("plan-compiler", (true, Some("work-map-ledger"))),
        ("plan-synthesizer", (true, Some("work-map-ledger"))),
        ("plan-reviewer", (true, Some("plan-review-ledger"))),
        ("contradiction-resolver", (true, Some("question-ledger"))),
        ("implementer", (true, Some("delivery-ledger"))),
        ("fixer-integrator", (true, Some("delivery-ledger"))),
        ("onboard", (false, None)),
        ("orchestrator", (false, None)),
        ("context-synthesizer", (false, None)),
        ("execution-allocator", (false, None)),
        ("validator", (false, None)),
        ("bughunter", (false, None)),
    ]);
    assert_eq!(policy.roles.len(), expected_roles.len());
    for (role_id, (interruptible, slot_set)) in expected_roles {
        let role = policy.role(role_id).expect("expected role resolves");
        assert_eq!(
            role.interruptible, interruptible,
            "{role_id} interruptible drift"
        );
        assert_eq!(
            role.slot_set.as_deref(),
            slot_set,
            "{role_id} slot_set drift"
        );
    }

    let expected_slots = BTreeMap::from([
        (
            "task-atom-ledger",
            vec![
                "semantic_lens",
                "authority_coverage",
                "atom_ledger",
                "duplicate_dispositions",
                "unresolved_ambiguities",
            ],
        ),
        (
            "evidence-selection-ledger",
            vec![
                "scope_identity",
                "source_ranges_considered",
                "accepted_outputs",
                "rejected_uncertain_outputs",
                "unvisited_or_gap_refs",
                "budget_identity",
            ],
        ),
        (
            "question-ledger",
            vec![
                "resolution_batch",
                "claim_evidence_ledger",
                "surviving_facts",
                "rejected_facts",
                "unresolved_gaps",
                "pending_questions",
            ],
        ),
        (
            "work-map-ledger",
            vec![
                "input_disposition_matrix",
                "draft_units",
                "dependency_gate_tdd_obligations",
                "merge_conflict_decisions",
                "trace_gaps",
            ],
        ),
        (
            "plan-review-ledger",
            vec![
                "criterion_universe",
                "verdict_ledger",
                "evidence_rationale_refs",
                "checked_dimensions",
                "unreviewed_criteria",
                "blocker_advisory_split",
            ],
        ),
        (
            "delivery-ledger",
            vec![
                "worktree_identity",
                "scope_boundaries",
                "edit_ledger",
                "tdd_command_ledger",
                "evidence_refs",
                "boundary_violations",
                "repair_decisions",
                "draft_delivery_status",
            ],
        ),
    ]);
    for (slot_set_id, expected) in expected_slots {
        let actual = policy.slot_sets[slot_set_id]
            .slots
            .iter()
            .filter(|slot| slot.required)
            .map(|slot| slot.key.as_str())
            .collect::<Vec<_>>();
        assert_eq!(actual, expected, "{slot_set_id} required slots drift");
    }

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
    let policy =
        CheckpointPolicy::parse_source(&policy_source()).expect("checkpoint policy parses");

    assert_eq!(policy.handoff_contract, "autopilot.agent-handoff.v1");
    assert_eq!(policy.thresholds.get("arm"), Some(&75));
    assert_eq!(policy.thresholds.get("checkpoint"), Some(&85));
    policy
        .validate_shape()
        .expect("policy shape and bounds are coherent");

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
            "handoff critical_state slot `unexpected_nested` exceeds depth 2"
        );
    }
}

#[test]
fn checkpoint_policy_runtime_and_tests_share_parsed_handoff_bounds() {
    let policy =
        CheckpointPolicy::parse_source(&policy_source()).expect("checkpoint policy parses");
    assert_eq!(policy.bounds.total_max_bytes, 65_536);
    assert_eq!(policy.bounds.entry_max_bytes, 512);
    assert_eq!(policy.bounds.completed_max_entries, 32);
    assert_eq!(policy.bounds.remaining_max_entries, 32);
    assert_eq!(policy.bounds.critical_state_max_slots, 16);
    assert_eq!(policy.bounds.critical_state_value_max_bytes, 4_096);
    assert_eq!(policy.bounds.critical_state_array_max_entries, 256);

    let mut over_total = complete_handoff_for_role(&policy, "task-extractor");
    over_total
        .as_object_mut()
        .expect("handoff object")
        .insert("padding".to_owned(), json!("x".repeat(66_000)));
    let error = validate_handoff(&policy, "task-extractor", &over_total)
        .expect_err("total_max_bytes enforced by runtime parser");
    assert!(error.contains("total_max_bytes"), "{error}");
    assert!(error.contains("observed"), "{error}");

    let mut over_entry = complete_handoff_for_role(&policy, "task-extractor");
    over_entry["completed"] = json!(["x".repeat(513)]);
    let error = validate_handoff(&policy, "task-extractor", &over_entry)
        .expect_err("entry_max_bytes enforced by runtime parser");
    assert!(error.contains("entry_max_bytes"), "{error}");
    assert!(error.contains("observed 513"), "{error}");
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
    assert!(prop_bool(&artifact, "model_produced").expect("model_produced prop"));

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
    let policy =
        CheckpointPolicy::parse_source(&policy_source()).expect("checkpoint policy parses");
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
    let error = CheckpointPolicy::parse_source(&broken).expect_err("malformed policy rejected");
    assert_eq!(
        error,
        "role `task-extractor` references unknown slot_set `missing-ledger`"
    );
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

fn complete_handoff_for_role(policy: &CheckpointPolicy, role_id: &str) -> Value {
    let slots = policy.required_slots(role_id).expect("role slots");
    let mut critical_state = serde_json::Map::new();
    for slot in slots {
        let value = match slot.value_type {
            CheckpointSlotType::String => json!(format!("{} preserved", slot.key)),
            CheckpointSlotType::ArrayString => json!([format!("{} item", slot.key)]),
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

fn validate_handoff(
    policy: &CheckpointPolicy,
    role_id: &str,
    handoff: &Value,
) -> Result<Value, String> {
    let encoded = serde_json::to_string(handoff).expect("handoff serializes");
    policy
        .validate_handoff_text(role_id, &encoded)
        .and_then(|handoff| {
            serde_json::to_value(handoff)
                .map_err(|error| format!("handoff reserialize failed: {error}"))
        })
        .map_err(|error| {
            error
                .strip_prefix("agent-run ")
                .unwrap_or(error.as_str())
                .to_owned()
        })
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
            "field" | "list" | "group" if prop_bool(child, "required")? => {
                names.push(arg_string(child, 0)?);
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

fn prop_bool(node: &KdlNode, key: &str) -> Result<bool, String> {
    prop_value(node, key)?.as_bool().ok_or_else(|| {
        format!(
            "node `{}` property `{key}` must be bool",
            node.name().value()
        )
    })
}
