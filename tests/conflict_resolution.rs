use drivers::conflict::{
    CandidateState, CheckKind, ConflictBundle, ConflictClass, ConflictError, ConflictHunk,
    ConflictId, ConflictResolution, DroppedSide, FileContent, PreservedBehavior, Side,
    validate_resolution,
};

#[test]
fn symmetric_bundle_contains_both_sides_and_high_risk_gets_focused_review_not_full_suite() {
    let bundle = bundle(ConflictClass::SemanticHighRisk);
    assert!(
        bundle.symmetric(),
        "bundle contains current and incoming authority"
    );

    let plan = validate_resolution(&bundle, &clean_candidate(), &good_resolution())
        .expect("combined behavior resolution is accepted");
    assert!(plan.checks.contains(&CheckKind::FocusedTest));
    assert!(plan.checks.contains(&CheckKind::ConflictReview));
    assert!(
        !plan.checks.contains(&CheckKind::FullSuite),
        "conflict alone must not invoke the full suite"
    );
    assert_eq!(plan.commands, vec!["test-overlap".to_owned()]);
}

#[test]
fn markers_and_unmerged_index_entries_are_rejected() {
    let marker = CandidateState {
        files: vec![FileContent {
            path: "src/lib.rs".to_owned(),
            bytes: "<<<<<<< current\nleft\n=======\nright\n>>>>>>> incoming".to_owned(),
        }],
        unmerged_index_entries: vec![],
        dropped_sides: vec![],
    };
    assert!(matches!(
        validate_resolution(&bundle(ConflictClass::Textual), &marker, &good_resolution()),
        Err(ConflictError::ConflictMarkers(path)) if path == "src/lib.rs"
    ));

    let unmerged = CandidateState {
        files: vec![],
        unmerged_index_entries: vec!["UU src/lib.rs".to_owned()],
        dropped_sides: vec![],
    };
    assert!(matches!(
        validate_resolution(&bundle(ConflictClass::Textual), &unmerged, &good_resolution()),
        Err(ConflictError::UnmergedIndex(entries)) if entries == vec!["UU src/lib.rs".to_owned()]
    ));
}

#[test]
fn ours_theirs_and_dropped_side_are_rejected() {
    let dropped = CandidateState {
        files: vec![FileContent {
            path: "src/lib.rs".to_owned(),
            bytes: "left only".to_owned(),
        }],
        unmerged_index_entries: vec![],
        dropped_sides: vec![DroppedSide {
            conflict_id: ConflictId("h1".to_owned()),
            side: Side::Incoming,
        }],
    };
    assert!(matches!(
        validate_resolution(&bundle(ConflictClass::Textual), &dropped, &good_resolution()),
        Err(ConflictError::DroppedSide(id)) if id == ConflictId("h1".to_owned())
    ));

    let blind = ConflictResolution {
        commit: "resolution".to_owned(),
        behavior_map: vec![PreservedBehavior {
            conflict_id: ConflictId("h1".to_owned()),
            preserves_current: true,
            preserves_incoming: false,
            rationale: "used ours".to_owned(),
        }],
    };
    assert!(matches!(
        validate_resolution(&bundle(ConflictClass::Textual), &clean_candidate(), &blind),
        Err(ConflictError::BlindSideChoice(id)) if id == ConflictId("h1".to_owned())
    ));
}

fn bundle(class: ConflictClass) -> ConflictBundle {
    ConflictBundle {
        common_base: "base".to_owned(),
        current: side("current diff"),
        incoming: side("incoming diff"),
        hunks: vec![ConflictHunk {
            id: ConflictId("h1".to_owned()),
            path: "src/lib.rs".to_owned(),
            class,
        }],
        operator_atoms: vec!["preserve both user-visible behaviors".to_owned()],
        constraints_for_both: vec!["no silent downstream assumption change".to_owned()],
    }
}

fn side(diff: &str) -> drivers::conflict::SideFacts {
    drivers::conflict::SideFacts {
        commit: format!("commit-{diff}"),
        tree: format!("tree-{diff}"),
        diff: diff.to_owned(),
        criteria: vec!["criterion-overlap".to_owned()],
        open_findings: vec!["finding-open".to_owned()],
        changed_paths: vec!["src/lib.rs".to_owned()],
        focused_tests: vec!["test-overlap".to_owned()],
        downstream_contracts: vec!["contract-overlap".to_owned()],
    }
}

fn clean_candidate() -> CandidateState {
    CandidateState {
        files: vec![FileContent {
            path: "src/lib.rs".to_owned(),
            bytes: "combined behavior".to_owned(),
        }],
        unmerged_index_entries: vec![],
        dropped_sides: vec![],
    }
}

fn good_resolution() -> ConflictResolution {
    ConflictResolution {
        commit: "resolution".to_owned(),
        behavior_map: vec![PreservedBehavior {
            conflict_id: ConflictId("h1".to_owned()),
            preserves_current: true,
            preserves_incoming: true,
            rationale: "left validation and right normalization are both retained".to_owned(),
        }],
    }
}
