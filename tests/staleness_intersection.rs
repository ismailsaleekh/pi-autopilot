use drivers::staleness::{
    CommandEvidence, CriterionCoverage, MergeChange, SuccessorEdgeAction, ValidationRecord,
    compute_staleness,
};

#[test]
fn overlap_stales_only_intersecting_criteria_and_surfaces() {
    let report = compute_staleness(
        &[record(
            "ev-mixed",
            &[
                coverage("crit-api", &["src/api.rs"], &["api"]),
                coverage("crit-ui", &["src/ui.rs"], &["ui"]),
            ],
            &["edge-api"],
        )],
        &MergeChange {
            changed_paths: vec!["src/api.rs".to_owned()],
            changed_surfaces: vec!["api".to_owned()],
            affected_forward_edges: vec!["edge-api".to_owned()],
            closed_forward_edges: vec![],
        },
    );

    assert!(report.current_evidence.is_empty());
    assert_eq!(report.stale.len(), 1);
    assert_eq!(report.stale[0].criteria, vec!["crit-api".to_owned()]);
    assert_eq!(report.stale[0].surfaces, vec!["api".to_owned()]);
    assert_eq!(
        report.successor_edges,
        vec![SuccessorEdgeAction::Refresh {
            edge_id: "edge-api".to_owned()
        }]
    );
}

#[test]
fn disjoint_evidence_remains_current_and_successor_edges_refresh_or_close() {
    let report = compute_staleness(
        &[
            record(
                "ev-api",
                &[coverage("crit-api", &["src/api.rs"], &["api"])],
                &["edge-api"],
            ),
            record(
                "ev-ui",
                &[coverage("crit-ui", &["src/ui.rs"], &["ui"])],
                &["edge-ui"],
            ),
        ],
        &MergeChange {
            changed_paths: vec!["src/api.rs".to_owned()],
            changed_surfaces: vec!["api".to_owned()],
            affected_forward_edges: vec!["edge-api".to_owned(), "edge-obsolete".to_owned()],
            closed_forward_edges: vec!["edge-obsolete".to_owned()],
        },
    );

    assert_eq!(
        report.current_evidence,
        vec!["ev-ui".to_owned()],
        "disjoint evidence remains current; staleness did not rerun everything"
    );
    assert_eq!(report.stale[0].evidence_id, "ev-api");
    assert_eq!(
        report.successor_edges,
        vec![
            SuccessorEdgeAction::Refresh {
                edge_id: "edge-api".to_owned()
            },
            SuccessorEdgeAction::Close {
                edge_id: "edge-obsolete".to_owned()
            },
        ]
    );
}

fn record(id: &str, covered: &[CriterionCoverage], edges: &[&str]) -> ValidationRecord {
    ValidationRecord {
        evidence_id: id.to_owned(),
        role_id: "validator".to_owned(),
        assignment_id: format!("assignment-{id}"),
        commit: "commit".to_owned(),
        tree: "tree".to_owned(),
        covered: covered.to_vec(),
        command_evidence: CommandEvidence {
            command: "cargo test --focused".to_owned(),
            exit_code: 0,
            output_ref: format!("output-{id}"),
        },
        forward_edges: edges.iter().map(|edge| (*edge).to_owned()).collect(),
        closure_edges: vec!["closure-edge".to_owned()],
    }
}

fn coverage(id: &str, paths: &[&str], surfaces: &[&str]) -> CriterionCoverage {
    CriterionCoverage {
        criterion_id: id.to_owned(),
        witness_id: format!("witness-{id}"),
        paths: paths.iter().map(|path| (*path).to_owned()).collect(),
        surfaces: surfaces.iter().map(|surface| (*surface).to_owned()).collect(),
    }
}
