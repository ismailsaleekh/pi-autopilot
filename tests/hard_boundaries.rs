use std::collections::BTreeMap;
use std::path::PathBuf;

use kdl::{KdlDocument, KdlNode};
use kernel::failure::{
    EvidenceDisposition, Failure, HardBoundary, OperationDisposition, ProcessDisposition,
};

#[test]
fn all_eight_boundaries_are_declared_and_reachable() {
    let boundaries = read_boundaries();
    let expected = BTreeMap::from([
        (
            "agent-git-mutation".to_owned(),
            HardBoundary::AgentVersionMutation,
        ),
        (
            "corrupt-state-git-mutation-evidence-lost".to_owned(),
            HardBoundary::EvidenceThreateningMutation,
        ),
        (
            "fetch-push-remote-destructive-network-commands".to_owned(),
            HardBoundary::RemoteOrDestructiveNetwork,
        ),
        (
            "out-of-worktree-operator-checkout-writes".to_owned(),
            HardBoundary::OutOfScopeWrite,
        ),
        (
            "paid-metered-frontier-routing".to_owned(),
            HardBoundary::MeteredFrontierRoute,
        ),
        (
            "secret-private-key-access".to_owned(),
            HardBoundary::SecretMaterialAccess,
        ),
        ("unsafe-cleanup".to_owned(), HardBoundary::UnsafeCleanup),
        (
            "unissued-bg-run".to_owned(),
            HardBoundary::UnissuedBackgroundLaunch,
        ),
    ]);

    assert_eq!(boundaries, expected);
    assert_eq!(HardBoundary::ALL.len(), 8);

    for boundary in HardBoundary::ALL {
        assert!(boundaries.values().any(|declared| *declared == boundary));
        let supervision = Failure::from(boundary).supervision();
        assert_eq!(supervision.process, ProcessDisposition::Continue);
        assert_eq!(supervision.operation, OperationDisposition::Halt(boundary));
        assert_eq!(supervision.evidence, EvidenceDisposition::Preserve);
    }
}

fn read_boundaries() -> BTreeMap<String, HardBoundary> {
    let source = std::fs::read_to_string(table_path()).expect("read failure table");
    let document = source
        .parse::<KdlDocument>()
        .expect("parse failure table as KDL");
    let mut boundaries = BTreeMap::new();

    for node in document.nodes() {
        if node.name().value() == "boundary" {
            let id = arg_string(node, 0).to_owned();
            assert_eq!(prop_string(node, "variant"), "Unsafe");
            let boundary = boundary_from_kind(prop_string(node, "kind"));
            assert!(
                boundaries.insert(id.clone(), boundary).is_none(),
                "duplicate boundary {id}"
            );
        }
    }

    boundaries
}

fn boundary_from_kind(kind: &str) -> HardBoundary {
    match kind {
        "OutOfScopeWrite" => HardBoundary::OutOfScopeWrite,
        "AgentVersionMutation" => HardBoundary::AgentVersionMutation,
        "RemoteOrDestructiveNetwork" => HardBoundary::RemoteOrDestructiveNetwork,
        "SecretMaterialAccess" => HardBoundary::SecretMaterialAccess,
        "UnissuedBackgroundLaunch" => HardBoundary::UnissuedBackgroundLaunch,
        "MeteredFrontierRoute" => HardBoundary::MeteredFrontierRoute,
        "UnsafeCleanup" => HardBoundary::UnsafeCleanup,
        "EvidenceThreateningMutation" => HardBoundary::EvidenceThreateningMutation,
        other => panic!("unknown hard boundary kind {other}"),
    }
}

fn table_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data/failure-table.kdl")
}

fn arg_string(node: &KdlNode, index: usize) -> &str {
    node.entries()
        .iter()
        .filter(|entry| entry.name().is_none())
        .nth(index)
        .and_then(|entry| entry.value().as_string())
        .expect("boundary id string")
}

fn prop_string<'a>(node: &'a KdlNode, key: &str) -> &'a str {
    node.entry(key)
        .and_then(|entry| entry.value().as_string())
        .expect("required string property")
}
