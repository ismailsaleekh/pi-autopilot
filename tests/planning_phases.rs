use std::{cell::Cell, fs};

use drivers::planning::{
    AssignmentPlan, Atom, AtomKind, Backlink, Disposition, MaterialPlanElement,
    PlanningDeclarations, PlanningError, QuestionClass, QuestionNomination, RepositoryEvidence,
    TaskAuthority, TaskDocument, accept_questions, admit_question, boundary_runtime, p1_inventory,
    p2_ground, question_class_from_d72, require_material_backlinks, require_total_dispositions,
};

struct TaskOnly {
    reads: Cell<u32>,
}

impl TaskAuthority for TaskOnly {
    fn documents(&self) -> Result<Vec<TaskDocument>, PlanningError> {
        self.reads.set(self.reads.get() + 1);
        Ok(vec![TaskDocument {
            id: "task".to_owned(),
            body: "deliver the requested planning pipeline".to_owned(),
        }])
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
    assert_eq!(AssignmentPlan::d72_default().total(), 25);
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
fn question_boundary_admits_live_empty_capture() {
    let raw = match fs::read_to_string("/tmp/w4-live/raw/planning.questions.v1.raw") {
        Ok(value) => value,
        Err(error) => panic!("live question transcript missing: {error}"),
    };
    assert_eq!(raw, "No qualifying questions.\n");
    let mut runtime = boundary_runtime("planning.questions.v1");
    runtime.flip_to_enforce();
    assert_eq!(accept_questions(&raw, &runtime), Ok(raw));
}

#[test]
fn question_boundary_admits_structured_empty_set() {
    let raw = "questions: []\n";
    let mut runtime = boundary_runtime("planning.questions.v1");
    runtime.flip_to_enforce();
    assert_eq!(accept_questions(raw, &runtime), Ok(raw.to_owned()));
}

#[test]
fn question_boundary_admits_valid_populated_nomination() {
    let raw = "class: material-underdetermination\nevidence: task and repository leave two plausible paths\nconsequence: choice changes verification scope\n";
    let mut runtime = boundary_runtime("planning.questions.v1");
    runtime.flip_to_enforce();
    assert_eq!(accept_questions(raw, &runtime), Ok(raw.to_owned()));
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

#[test]
fn assignment_cap_holds() {
    assert_eq!(AssignmentPlan::d72_default().validate(25), Ok(()));
    let too_many = AssignmentPlan {
        reserved_resolution: 4,
        ..AssignmentPlan::d72_default()
    };
    assert_eq!(
        too_many.validate(25),
        Err(PlanningError::AssignmentCap { total: 26, cap: 25 })
    );
}
