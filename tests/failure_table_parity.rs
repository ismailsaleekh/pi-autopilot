use std::collections::BTreeMap;
use std::path::PathBuf;

use kdl::{KdlDocument, KdlNode};

#[test]
fn failure_rows_are_exactly_mapped() {
    let rows = read_rows();
    let expected = BTreeMap::from([
        (
            "child-crash-timeout-background-kill".to_owned(),
            "Transient".to_owned(),
        ),
        (
            "closure-validator-findings".to_owned(),
            "Recoverable".to_owned(),
        ),
        ("context-85-percent".to_owned(), "NotFailure".to_owned()),
        ("controller-pi-restart".to_owned(), "Transient".to_owned()),
        ("failed-focused-tests".to_owned(), "Recoverable".to_owned()),
        (
            "forward-validator-blocker".to_owned(),
            "Recoverable".to_owned(),
        ),
        (
            "merge-conflict-semantic-overlap".to_owned(),
            "Recoverable".to_owned(),
        ),
        (
            "missing-invalid-terminal-output".to_owned(),
            "Recoverable".to_owned(),
        ),
        (
            "missing-malformed-planning-submission".to_owned(),
            "Recoverable".to_owned(),
        ),
        (
            "missing-pi-background-tasks".to_owned(),
            "Paused".to_owned(),
        ),
        ("provider-unavailable".to_owned(), "Transient".to_owned()),
        ("repair-budget-exhausted".to_owned(), "Paused".to_owned()),
        (
            "semantic-recovery-exhausted".to_owned(),
            "Paused".to_owned(),
        ),
        (
            "semantic-recovery-inadmissible".to_owned(),
            "Paused".to_owned(),
        ),
        (
            "semantic-recovery-infrastructure".to_owned(),
            "Paused".to_owned(),
        ),
        (
            "semantic-recovery-new-authority".to_owned(),
            "Paused".to_owned(),
        ),
        ("semantic-recovery-unsafe".to_owned(), "Unsafe".to_owned()),
        (
            "sparse-materialization-disk-io".to_owned(),
            "Transient".to_owned(),
        ),
        (
            "sparse-materialization-path-escape".to_owned(),
            "Unsafe".to_owned(),
        ),
        (
            "stale-superseded-result".to_owned(),
            "Recoverable".to_owned(),
        ),
        ("typed-model-rejection".to_owned(), "Recoverable".to_owned()),
    ]);

    assert_eq!(rows, expected);
    assert_eq!(rows.len(), 21);
    assert_eq!(
        rows.get("context-85-percent").map(String::as_str),
        Some("NotFailure")
    );
    assert!(
        rows.values()
            .all(|variant| variant != "Noop" && variant != "Ignore")
    );
}

fn read_rows() -> BTreeMap<String, String> {
    let source = std::fs::read_to_string(table_path()).expect("read failure table");
    let document = source
        .parse::<KdlDocument>()
        .expect("parse failure table as KDL");
    let mut rows = BTreeMap::new();

    for node in document.nodes() {
        if node.name().value() == "row" {
            let id = arg_string(node, 0).to_owned();
            let variant = prop_string(node, "variant").to_owned();
            assert!(
                matches!(
                    variant.as_str(),
                    "Transient" | "Recoverable" | "Paused" | "Unsafe" | "NotFailure"
                ),
                "unknown failure-table variant {variant} for row {id}"
            );
            assert!(
                rows.insert(id.clone(), variant).is_none(),
                "duplicate failure-table row {id}"
            );
        }
    }

    rows
}

fn table_path() -> PathBuf {
    if let Some(path) = std::env::var_os("FAILURE_TABLE_PATH") {
        PathBuf::from(path)
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data/failure-table.kdl")
    }
}

fn arg_string(node: &KdlNode, index: usize) -> &str {
    node.entries()
        .iter()
        .filter(|entry| entry.name().is_none())
        .nth(index)
        .and_then(|entry| entry.value().as_string())
        .expect("row id string")
}

fn prop_string<'a>(node: &'a KdlNode, key: &str) -> &'a str {
    node.entry(key)
        .and_then(|entry| entry.value().as_string())
        .expect("required string property")
}
