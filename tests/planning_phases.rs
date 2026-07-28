use std::{
    cell::Cell,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use drivers::planning::{
    AssignmentPlan, Atom, AtomKind, Backlink, Disposition, MaterialPlanElement,
    PlanningDeclarations, PlanningError, QuestionClass, QuestionNomination, RepositoryEvidence,
    TaskAuthority, TaskDocumentClass, TaskInputSet, accept_questions, accept_questions_payload,
    admit_question, boundary_runtime, inline_task_input, p1_inventory, p2_ground,
    question_class_from_d72, require_material_backlinks, require_total_dispositions,
};
use kernel::generated::{PlanningQuestion, PlanningQuestionClass, Questions};

struct TaskOnly {
    reads: Cell<u32>,
}

impl TaskAuthority for TaskOnly {
    fn input_set(&self) -> Result<drivers::planning::TaskInputSet, PlanningError> {
        self.reads.set(self.reads.get() + 1);
        inline_task_input("deliver the requested planning pipeline".to_owned())
    }
}

struct RepoOnly;

impl RepositoryEvidence for RepoOnly {
    fn facts_for_atoms(&self, atoms: &[Atom]) -> Result<Vec<String>, PlanningError> {
        Ok(atoms
            .iter()
            .map(|atom| format!("fact-for-{}", atom.id))
            .collect())
    }
}

#[test]
fn planning_data_declares_p1_to_p6_and_cap() {
    let declarations = match PlanningDeclarations::parse(include_str!("../data/planning.kdl")) {
        Ok(value) => value,
        Err(error) => panic!("planning declarations did not parse: {error:?}"),
    };
    if let Err(error) = declarations.validate_p1_to_p6() {
        panic!("planning declarations failed: {error:?}");
    }
    assert_eq!(AssignmentPlan::d72_default().total(), 24);
}

#[test]
fn p1_uses_only_task_authority_shape() {
    let source = TaskOnly {
        reads: Cell::new(0),
    };
    let inventory = match p1_inventory(&source) {
        Ok(value) => value,
        Err(error) => panic!("P1 failed: {error:?}"),
    };
    assert_eq!(source.reads.get(), 1);
    assert_eq!(inventory.atoms.len(), 1);

    let dossier = match p2_ground(&RepoOnly, &inventory) {
        Ok(value) => value,
        Err(error) => panic!("P2 failed: {error:?}"),
    };
    assert_eq!(dossier.verified_facts, vec!["fact-for-A1".to_owned()]);
}

#[test]
fn every_atom_requires_a_disposition() {
    let mut atoms = vec![Atom {
        id: "A1".to_owned(),
        kind: AtomKind::Work,
        statement: "deliver".to_owned(),
        disposition: None,
    }];
    assert_eq!(
        require_total_dispositions(&atoms),
        Err(PlanningError::MissingDisposition("A1".to_owned()))
    );
    atoms[0].disposition = Some(Disposition {
        kind: "implemented-by".to_owned(),
        backlink: Backlink::Atom("A1".to_owned()),
    });
    assert_eq!(require_total_dispositions(&atoms), Ok(()));
}

#[test]
fn material_elements_require_backlinks() {
    let missing = vec![MaterialPlanElement {
        id: "U1".to_owned(),
        backlinks: Vec::new(),
    }];
    assert_eq!(
        require_material_backlinks(&missing),
        Err(PlanningError::MissingBacklink("U1".to_owned()))
    );
    let linked = vec![MaterialPlanElement {
        id: "U1".to_owned(),
        backlinks: vec![Backlink::VerifiedFact("F1".to_owned())],
    }];
    assert_eq!(require_material_backlinks(&linked), Ok(()));
}

#[test]
fn question_gate_admits_only_d72_five_classes() {
    let admitted = [
        ("invalidated-decision", QuestionClass::InvalidatedDecision),
        (
            "missing-material-decision",
            QuestionClass::MissingMaterialDecision,
        ),
        (
            "material-underdetermination",
            QuestionClass::MaterialUnderdetermination,
        ),
        ("dod-hole", QuestionClass::DodHole),
        ("unsafe-irreversible", QuestionClass::UnsafeIrreversible),
    ];
    for (raw, class) in admitted {
        assert_eq!(question_class_from_d72(raw), Ok(class));
        let nomination = QuestionNomination {
            class,
            material_consequence: "changes scope".to_owned(),
        };
        assert_eq!(admit_question(nomination.clone()), Ok(nomination));
    }
    assert_eq!(
        question_class_from_d72("minor-wording"),
        Err(PlanningError::RejectedQuestionClass(
            "minor-wording".to_owned()
        ))
    );
}

#[test]
fn question_boundary_admits_recorded_empty_capture() {
    let raw = transcript("planning.questions.v1");
    assert_eq!(raw, "{\n  \"questions\": []\n}\n");
    let mut runtime = boundary_runtime("planning.questions.v1");
    runtime.flip_to_enforce();
    assert_eq!(accept_questions(&raw, &runtime), Ok(raw));
}

#[test]
fn question_boundary_admits_structured_empty_set() {
    let raw = transcript("planning.questions.v1");
    let mut runtime = boundary_runtime("planning.questions.v1");
    runtime.flip_to_enforce();
    assert_eq!(accept_questions(&raw, &runtime), Ok(raw));
}

#[test]
fn question_boundary_admits_valid_populated_nomination() {
    let payload = Questions {
        questions: vec![PlanningQuestion {
            class: PlanningQuestionClass::MaterialUnderdetermination,
            evidence: "task and repository leave two plausible paths".to_owned(),
            consequence: "choice changes verification scope".to_owned(),
        }],
    };
    assert_eq!(accept_questions_payload(payload.clone()), Ok(payload));
}

#[test]
fn question_boundary_rejects_invented_class() {
    let raw =
        "class: made-up-thing\nevidence: current repository evidence\nconsequence: changes scope\n";
    let mut runtime = boundary_runtime("planning.questions.v1");
    runtime.flip_to_enforce();
    let rejection = match accept_questions(raw, &runtime) {
        Ok(value) => panic!("invented class admitted: {value}"),
        Err(value) => value,
    };
    assert_eq!(rejection.boundary_id(), "planning.questions.v1");
}

#[test]
fn question_boundary_rejects_prose_mentioning_class() {
    let raw = "No class of question should pause the plan; continue.";
    let mut runtime = boundary_runtime("planning.questions.v1");
    runtime.flip_to_enforce();
    let rejection = match accept_questions(raw, &runtime) {
        Ok(value) => panic!("class prose admitted: {value}"),
        Err(value) => value,
    };
    assert_eq!(rejection.boundary_id(), "planning.questions.v1");
}

fn transcript(boundary_id: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/transcripts")
        .join(boundary_id)
        .join("transcripts.json");
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).expect("transcript file"))
            .expect("transcript json");
    value["records"][0]["raw_output"]
        .as_str()
        .expect("raw output")
        .to_owned()
}

#[test]
fn assignment_cap_holds() {
    assert_eq!(AssignmentPlan::d72_default().validate(25), Ok(()));
    let too_many = AssignmentPlan {
        reserved_resolution: 5,
        ..AssignmentPlan::d72_default()
    };
    assert_eq!(
        too_many.validate(25),
        Err(PlanningError::AssignmentCap { total: 26, cap: 25 })
    );
}

#[test]
fn planning_variadic_task_file_packs_accept_two_three_seven_and_marker_order() {
    let root = temp_repo("planning-variadic-accept");
    write_doc(
        &root,
        "C1.md",
        "[context/non-authority]",
        "set-a",
        "context one",
    );
    write_doc(
        &root,
        "C2.md",
        "[context/non-authority]",
        "set-a",
        "context two",
    );
    for index in 1..=6 {
        write_doc(
            &root,
            &format!("A{index}.md"),
            "[authority]",
            "set-a",
            &format!("authority {index}"),
        );
    }

    let two = classify(&root, ["C1.md", "A1.md"]);
    assert_pack(&two, 1, 1);
    assert_eq!(two.context_documents[0].path, "C1.md");
    assert_eq!(two.authority_documents[0].path, "A1.md");

    let three = classify(&root, ["A1.md", "C1.md", "C2.md"]);
    assert_pack(&three, 1, 2);

    let seven = classify(
        &root,
        [
            "A1.md", "A2.md", "A3.md", "A4.md", "A5.md", "A6.md", "C1.md",
        ],
    );
    assert_pack(&seven, 6, 1);

    let interleaved = classify(&root, ["C1.md", "A1.md", "C2.md", "A2.md"]);
    assert_pack(&interleaved, 2, 2);
    assert_eq!(
        interleaved
            .context_documents
            .iter()
            .map(|doc| doc.path.as_str())
            .collect::<Vec<_>>(),
        vec!["C1.md", "C2.md"]
    );
    assert_eq!(
        interleaved
            .authority_documents
            .iter()
            .map(|doc| doc.path.as_str())
            .collect::<Vec<_>>(),
        vec!["A1.md", "A2.md"]
    );
}

#[test]
fn planning_variadic_task_file_packs_reject_missing_classes_mismatch_forbidden_and_duplicate_precisely()
 {
    let root = temp_repo("planning-variadic-reject");
    write_doc(&root, "A1.md", "[authority]", "set-a", "authority one");
    write_doc(&root, "A2.md", "[authority]", "set-a", "authority two");
    write_doc(&root, "A3.md", "[authority]", "set-a", "authority three");
    write_doc(&root, "A4.md", "[authority]", "set-a", "authority four");
    write_doc(&root, "B.md", "[authority]", "set-b", "authority mismatch");
    write_doc(
        &root,
        "C1.md",
        "[context/non-authority]",
        "set-a",
        "context one",
    );
    write_doc(
        &root,
        "C2.md",
        "[context/non-authority]",
        "set-a",
        "context two",
    );
    write_doc(
        &root,
        "H.md",
        "[historical/non-authority]",
        "set-a",
        "history",
    );
    write_doc(&root, "I.md", "[index/non-authority]", "set-a", "index");

    assert_error_contains(
        &root,
        ["C1.md", "C2.md"],
        "no [authority] document supplied",
    );
    assert_error_contains(
        &root,
        ["A1.md", "A2.md", "A3.md", "A4.md"],
        "no [context/non-authority] document supplied",
    );
    assert_error_contains(
        &root,
        ["A1.md", "B.md", "C1.md"],
        "authority_set_id mismatch: A1.md=set-a B.md=set-b",
    );
    assert_error_contains(
        &root,
        ["A1.md", "H.md", "C1.md"],
        "forbidden [historical/non-authority] input: H.md",
    );
    assert_error_contains(
        &root,
        ["A1.md", "I.md", "C1.md"],
        "forbidden [index/non-authority] input: I.md",
    );
    assert_error_contains(&root, ["A1.md", "A1.md"], "DuplicateTaskPath");
}

#[test]
fn planning_task_header_marker_diagnostics_are_precise() {
    let root = temp_repo("planning-marker-diagnostics");
    write_doc(&root, "C.md", "[context/non-authority]", "set-a", "context");

    fs::write(root.join("NO-MARKER.md"), "authority_set_id: set-a\n\nbody")
        .expect("no marker fixture");
    assert_error_contains(
        &root,
        ["NO-MARKER.md", "C.md"],
        "unknown-marker:NO-MARKER.md:authority_set_id: set-a",
    );

    fs::write(
        root.join("MARKER-LINE-2.md"),
        "authority_set_id: set-a\n[authority]\n\nbody",
    )
    .expect("marker line 2 fixture");
    assert_error_contains(
        &root,
        ["MARKER-LINE-2.md", "C.md"],
        "unknown-marker:MARKER-LINE-2.md:authority_set_id: set-a",
    );

    fs::write(root.join("EMPTY.md"), "").expect("empty fixture");
    assert_error_contains(&root, ["EMPTY.md", "C.md"], "missing-marker:EMPTY.md");
}

#[test]
fn planning_variadic_task_file_security_rejections_are_preserved_without_count_masking() {
    let root = temp_repo("planning-variadic-security");
    write_doc(&root, "A.md", "[authority]", "set-a", "authority");
    write_doc(&root, "C.md", "[context/non-authority]", "set-a", "context");

    assert_error_contains_pathbuf(
        &root,
        vec![PathBuf::from("../outside.md"), PathBuf::from("C.md")],
        "TaskPath",
    );
    assert_error_contains_pathbuf(
        &root,
        vec![PathBuf::from("bad\\path.md"), PathBuf::from("C.md")],
        "TaskPath",
    );

    fs::write(
        root.join("BOM.md"),
        "\u{feff}[authority]\nauthority_set_id: set-a\n\nbody",
    )
    .expect("bom fixture");
    assert_error_contains(&root, ["BOM.md", "C.md"], "bom:BOM.md");

    fs::write(
        root.join("CRLF.md"),
        "[authority]\r\nauthority_set_id: set-a\r\n\r\nbody",
    )
    .expect("crlf fixture");
    assert_error_contains(&root, ["CRLF.md", "C.md"], "crlf:CRLF.md");

    fs::create_dir(root.join("DIR.md")).expect("dir fixture");
    assert_error_contains(&root, ["DIR.md", "C.md"], "not-regular-file:DIR.md");

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(root.join("A.md"), root.join("LINK.md")).expect("symlink fixture");
        assert_error_contains(&root, ["LINK.md", "C.md"], "symlink:LINK.md");
    }
}

fn assert_pack(input: &TaskInputSet, authority_count: usize, context_count: usize) {
    assert_eq!(input.authority_set_id, "set-a");
    assert_eq!(input.authority_documents.len(), authority_count);
    assert_eq!(input.context_documents.len(), context_count);
    assert!(
        input
            .authority_documents
            .iter()
            .all(|doc| doc.class == TaskDocumentClass::Authority)
    );
    assert!(
        input
            .context_documents
            .iter()
            .all(|doc| doc.class == TaskDocumentClass::ContextNonAuthority)
    );
}

fn classify<const N: usize>(root: &Path, names: [&str; N]) -> TaskInputSet {
    drivers::planning::classify_task_file_pack(root, &paths(names)).expect("classified")
}

fn assert_error_contains<const N: usize>(root: &Path, names: [&str; N], needle: &str) {
    assert_error_contains_pathbuf(root, paths(names), needle);
}

fn assert_error_contains_pathbuf(root: &Path, paths: Vec<PathBuf>, needle: &str) {
    let error = drivers::planning::classify_task_file_pack(root, &paths)
        .expect_err("classification rejected");
    let debug = format!("{error:?}");
    assert!(
        debug.contains(needle),
        "expected error {debug:?} to contain {needle:?}"
    );
}

fn paths<const N: usize>(names: [&str; N]) -> Vec<PathBuf> {
    names.into_iter().map(PathBuf::from).collect()
}

fn write_doc(root: &Path, name: &str, marker: &str, id: &str, body: &str) {
    fs::write(root.join(name), doc(marker, id, body)).expect("write doc");
}

fn doc(marker: &str, id: &str, body: &str) -> String {
    format!("{marker}\nauthority_set_id: {id}\n\n{body}")
}

fn temp_repo(name: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/test-tmp")
        .join(format!("pi-autopilot-{name}-{unique}"));
    fs::create_dir_all(&root).expect("temp repo");
    root
}
