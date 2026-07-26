use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use kdl::{KdlDocument, KdlNode};

const WORKFLOW: &str = include_str!("../data/workflow.kdl");
const CONTRACTS: &str = include_str!("../data/contracts.kdl");
static NEXT: AtomicUsize = AtomicUsize::new(0);

#[test]
fn workflow_names_match_contract_enums() {
    check_parity(WORKFLOW, CONTRACTS).expect("workflow and contracts are byte-identical");
}

#[test]
fn spelling_drift_is_caught() {
    let drifted = WORKFLOW.replace("    state \"forward-ready\"", "    state \"forward_ready\"");
    let error = check_parity(&drifted, CONTRACTS).expect_err("drift must fail parity");
    assert!(
        error.contains("forward_ready") || error.contains("forward-ready"),
        "{error}"
    );
    let path = write_copy(drifted);
    assert!(
        path.exists(),
        "drift copy was recorded at {}",
        path.display()
    );
}

fn check_parity(workflow_source: &str, contracts_source: &str) -> Result<(), String> {
    let workflow = WorkflowNames::parse(workflow_source)?;
    let contracts = enum_values(contracts_source)?;
    compare("run_phase", workflow.run_phase, &contracts, 7)?;
    compare("run_health", workflow.run_health, &contracts, 4)?;
    compare("run_outcome", workflow.run_outcome, &contracts, 3)?;
    compare("lane_state", workflow.lane_state, &contracts, 12)?;
    compare("candidate_state", workflow.candidate_state, &contracts, 10)?;
    compare("forward_verdict", workflow.forward_verdict, &contracts, 3)?;
    compare("closure_verdict", workflow.closure_verdict, &contracts, 3)?;
    let criterion = contracts
        .get("criterion_verdict")
        .ok_or("missing enum criterion_verdict")?;
    if criterion != &set(["PASS", "FAIL", "BLOCKED"]) || criterion.len() != 3 {
        return Err(format!("criterion_verdict drift: {criterion:?}"));
    }
    Ok(())
}

struct WorkflowNames {
    run_phase: BTreeSet<String>,
    run_health: BTreeSet<String>,
    run_outcome: BTreeSet<String>,
    lane_state: BTreeSet<String>,
    candidate_state: BTreeSet<String>,
    forward_verdict: BTreeSet<String>,
    closure_verdict: BTreeSet<String>,
}

impl WorkflowNames {
    fn parse(source: &str) -> Result<Self, String> {
        let doc = source
            .parse::<KdlDocument>()
            .map_err(|error| error.to_string())?;
        let mut names = Self {
            run_phase: BTreeSet::new(),
            run_health: BTreeSet::new(),
            run_outcome: BTreeSet::new(),
            lane_state: BTreeSet::new(),
            candidate_state: BTreeSet::new(),
            forward_verdict: BTreeSet::new(),
            closure_verdict: BTreeSet::new(),
        };
        for node in doc.nodes() {
            match node.name().value() {
                "machine" => match arg(node, 0)? {
                    "run" => names.run_phase = child_values(node, "state")?,
                    "lane" => names.lane_state = child_values(node, "state")?,
                    "candidate" => names.candidate_state = child_values(node, "state")?,
                    _ => {}
                },
                "axis" => match prop(node, "contract")? {
                    "run_health" => names.run_health = child_values(node, "value")?,
                    "run_outcome" => names.run_outcome = child_values(node, "value")?,
                    _ => {}
                },
                "verdict_set" => match prop(node, "contract")? {
                    "forward_verdict" => names.forward_verdict = child_values(node, "value")?,
                    "closure_verdict" => names.closure_verdict = child_values(node, "value")?,
                    _ => {}
                },
                _ => {}
            }
        }
        Ok(names)
    }
}

fn enum_values(source: &str) -> Result<BTreeMap<String, BTreeSet<String>>, String> {
    let doc = source
        .parse::<KdlDocument>()
        .map_err(|error| error.to_string())?;
    let mut out = BTreeMap::new();
    for node in doc
        .nodes()
        .iter()
        .filter(|node| node.name().value() == "enum")
    {
        out.insert(arg(node, 0)?.to_owned(), child_values(node, "value")?);
    }
    Ok(out)
}

fn compare(
    name: &str,
    workflow: BTreeSet<String>,
    contracts: &BTreeMap<String, BTreeSet<String>>,
    count: usize,
) -> Result<(), String> {
    let contract = contracts
        .get(name)
        .ok_or_else(|| format!("missing enum {name}"))?;
    if workflow != *contract || workflow.len() != count {
        return Err(format!(
            "{name} mismatch workflow={workflow:?} contracts={contract:?} expected_count={count}"
        ));
    }
    Ok(())
}

fn child_values(node: &KdlNode, child_name: &str) -> Result<BTreeSet<String>, String> {
    let children = node
        .children()
        .ok_or_else(|| format!("{} has no children", node.name().value()))?;
    let mut values = BTreeSet::new();
    for child in children
        .nodes()
        .iter()
        .filter(|child| child.name().value() == child_name)
    {
        values.insert(arg(child, 0)?.to_owned());
    }
    Ok(values)
}

fn arg(node: &KdlNode, index: usize) -> Result<&str, String> {
    node.entries()
        .iter()
        .filter(|entry| entry.name().is_none())
        .nth(index)
        .and_then(|entry| entry.value().as_string())
        .ok_or_else(|| format!("missing string arg {index} on {}", node.name().value()))
}

fn prop<'a>(node: &'a KdlNode, key: &str) -> Result<&'a str, String> {
    node.entry(key)
        .and_then(|entry| entry.value().as_string())
        .ok_or_else(|| format!("missing string prop {key} on {}", node.name().value()))
}

fn set(values: [&str; 3]) -> BTreeSet<String> {
    values.into_iter().map(str::to_owned).collect()
}

fn write_copy(source: String) -> PathBuf {
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("workflow-drift-{}-{id}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir created");
    let path = dir.join("workflow.kdl");
    std::fs::write(&path, source).expect("workflow written");
    path
}
