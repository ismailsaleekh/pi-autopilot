use drivers::context::{
    BudgetRoute, estimate_tokens, mandatory_pack, manifest_shell, parse_anchor, route_budget,
};
use kernel::boundary::Producer;
use kernel::generated::{ContextAnchorForm, Id, Uuidv7};

#[test]
fn estimator_matches_d76_formula_on_utf8_bytes() {
    let bytes = "éééabc".as_bytes();
    assert_eq!(bytes.len(), 9);
    assert_eq!(estimate_tokens(bytes, 7), 12);
}

#[test]
fn routing_thresholds_are_quality_routes_not_truncation() {
    assert_eq!(
        route_budget(400, 1000, 400).route,
        BudgetRoute::NormalLaunch
    );
    assert_eq!(
        route_budget(401, 1000, 450).route,
        BudgetRoute::ReprioritizeOnce
    );
    let over = route_budget(600, 1000, 501);
    assert_eq!(over.route, BudgetRoute::SplitAssignment);

    let items = vec!["mandatory-a".to_owned(), "mandatory-b".to_owned()];
    assert_eq!(
        mandatory_pack(&items, BudgetRoute::NormalLaunch).unwrap(),
        items
    );
    assert_eq!(
        mandatory_pack(&items, BudgetRoute::ReprioritizeOnce).unwrap(),
        items
    );
    assert_eq!(
        mandatory_pack(&items, over.route),
        Err(BudgetRoute::SplitAssignment)
    );
    assert_eq!(items.len(), 2);
}

#[test]
fn manifest_uses_generated_contract_fields() {
    let budget = route_budget(12, 100, 12);
    let manifest = manifest_shell(
        Uuidv7("01890f47-6b9a-7cc2-9d7f-984d8ef0aa00".to_owned()),
        Uuidv7("01890f47-6b9a-7cc2-9d7f-984d8ef0aa01".to_owned()),
        Id("assignment-a".to_owned()),
        Id("implementer".to_owned()),
        budget,
    );
    assert_eq!(manifest.schema.0, "autopilot.context_manifest.v1");
    assert_eq!(manifest.revision, 1);
    assert!(manifest.mandatory_inline.is_empty());
    assert!(manifest.required_reads.is_empty());
    assert!(manifest.on_demand.is_empty());
    assert!(manifest.excluded.is_empty());
    assert!(manifest.gaps.is_empty());
    assert_eq!(
        manifest.curator_proposal_ref.0,
        None::<kernel::generated::Ref>
    );
}

#[test]
fn all_seven_anchor_forms_parse_and_bad_anchor_rejects() {
    let cases = [
        (
            "task://digest/path/to/task.md#heading=Scope",
            ContextAnchorForm::Task,
        ),
        ("plan://rev-1/units/unit-a", ContextAnchorForm::Plan),
        (
            "dossier://rev-1/findings/finding-a",
            ContextAnchorForm::Dossier,
        ),
        (
            "run://01890f47-6b9a-7cc2-9d7f-984d8ef0aa00/findings/finding-a",
            ContextAnchorForm::Run,
        ),
        (
            "git://abc123/src/lib.rs#L1-L7",
            ContextAnchorForm::VersionControlLines,
        ),
        (
            "git://abc123/src/lib.rs#whole-file",
            ContextAnchorForm::VersionControlWholeFile,
        ),
        (
            "json://digest/path/to/file.json#/a/0/b",
            ContextAnchorForm::Json,
        ),
    ];
    for (raw, form) in cases {
        let parsed = parse_anchor(raw).unwrap();
        assert_eq!(parsed.anchor_form, form);
        assert_eq!(parsed.uri.0, raw);
    }
    let rejection = parse_anchor("git://abc123/src/lib.rs#main").unwrap_err();
    assert_eq!(rejection.boundary_id(), "context.anchor.v1");
    let descriptor = match kernel::boundary::boundary_by_id("context.anchor.v1") {
        Some(value) => value,
        None => panic!("context boundary was not registered"),
    };
    assert_eq!(descriptor.producer(), Producer::Package);
}
