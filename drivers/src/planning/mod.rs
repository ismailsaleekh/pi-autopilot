use crate::roles::kdl::{attr as kdl_attr, boundary_runtime as runtime_by_id, table_values};
use kernel::boundary::{BoundaryRuntime, Rejection};
use kernel_macros::acceptance_boundary;

pub const MODEL_BOUNDARIES: [&str; 5] = ["planning.task-atoms.v1", "planning.scout-dossier.v1", "planning.questions.v1", "planning.work-map.v1", "planning.plan-review.v1"];
const DRIVER_TABLES_KDL: &str = include_str!("../../../data/driver-tables.kdl");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AtomKind {
    Work,
    Decision,
    Constraint,
    Acceptance,
    Premise,
    Question,
    Reference,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Atom {
    pub id: String,
    pub kind: AtomKind,
    pub statement: String,
    pub disposition: Option<Disposition>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Disposition {
    pub kind: String,
    pub backlink: Backlink,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Backlink {
    Atom(String),
    VerifiedFact(String),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialPlanElement {
    pub id: String,
    pub backlinks: Vec<Backlink>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QuestionClass {
    InvalidatedDecision,
    MissingMaterialDecision,
    MaterialUnderdetermination,
    DodHole,
    UnsafeIrreversible,
}
const D72_QUESTION_CLASS_VALUES: [QuestionClass; 5] = [QuestionClass::InvalidatedDecision, QuestionClass::MissingMaterialDecision, QuestionClass::MaterialUnderdetermination, QuestionClass::DodHole, QuestionClass::UnsafeIrreversible];
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuestionNomination {
    pub class: QuestionClass,
    pub material_consequence: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssignmentPlan {
    pub task_extractors: u8,
    pub scout_and_compiler_first_pass: u8,
    pub context_curator: u8,
    pub synthesizers: u8,
    pub reviewer: u8,
    pub reserved_resolution: u8,
}

impl AssignmentPlan {
    pub fn d72_default() -> Self {
        Self {
            task_extractors: 7,
            scout_and_compiler_first_pass: 11,
            context_curator: 1,
            synthesizers: 2,
            reviewer: 1,
            reserved_resolution: 3,
        }
    }
    pub fn total(&self) -> u8 { self.task_extractors + self.scout_and_compiler_first_pass + self.context_curator + self.synthesizers + self.reviewer + self.reserved_resolution }
    pub fn validate(&self, cap: u8) -> Result<(), PlanningError> {
        if self.total() > cap { Err(PlanningError::AssignmentCap { total: self.total(), cap }) } else { Ok(()) }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskDocument {
    pub id: String,
    pub body: String,
}
pub trait TaskAuthority {
    fn documents(&self) -> Result<Vec<TaskDocument>, PlanningError>;
}
pub trait RepositoryEvidence {
    fn facts_for_atoms(&self, atoms: &[Atom]) -> Result<Vec<String>, PlanningError>;
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Inventory {
    pub atoms: Vec<Atom>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dossier {
    pub verified_facts: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PhaseDeclaration {
    pub id: String,
    pub question: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningDeclarations {
    pub assignment_cap: u8,
    pub phases: Vec<PhaseDeclaration>,
}

impl PlanningDeclarations {
    pub fn parse(text: &str) -> Result<Self, PlanningError> {
        let mut cap = None;
        let mut phases = Vec::new();
        for line in text.lines() {
            let trimmed = line.trim();
            if let Some(after) = trimmed.strip_prefix("assignment_cap ") {
                cap = Some(parse_cap(after)?);
            }
            if let Some(after) = trimmed.strip_prefix("phase \"") {
                let Some((id, attrs)) = after.split_once('"') else {
                    return Err(PlanningError::BadDeclaration(trimmed.to_owned()));
                };
                phases.push(PhaseDeclaration {
                    id: id.to_owned(),
                    question: parse_attr(attrs, "question=")?,
                });
            }
        }
        let Some(assignment_cap) = cap else {
            return Err(PlanningError::BadDeclaration(
                "missing assignment_cap".to_owned(),
            ));
        };
        Ok(Self {
            assignment_cap,
            phases,
        })
    }
    pub fn validate_p1_to_p6(&self) -> Result<(), PlanningError> {
        let expected = ["P1", "P2", "P3", "P4", "P5", "P6"];
        if self.phases.len() != expected.len() {
            return Err(PlanningError::BadDeclaration(
                "wrong phase count".to_owned(),
            ));
        }
        for (phase, expected_id) in self.phases.iter().zip(expected) {
            if phase.id != expected_id {
                return Err(PlanningError::BadDeclaration(phase.id.clone()));
            }
        }
        AssignmentPlan::d72_default().validate(self.assignment_cap)
    }
}

pub fn p1_inventory(source: &impl TaskAuthority) -> Result<Inventory, PlanningError> {
    let documents = source.documents()?;
    if documents.is_empty() {
        return Err(PlanningError::NoTaskAuthority);
    }
    let mut atoms = Vec::new();
    for (index, document) in documents.iter().enumerate() {
        if document.body.trim().is_empty() {
            return Err(PlanningError::NoTaskAuthority);
        }
        atoms.push(Atom {
            id: format!("A{}", index + 1),
            kind: AtomKind::Work,
            statement: document.body.clone(),
            disposition: None,
        });
    }
    Ok(Inventory { atoms })
}

pub fn p2_ground(
    evidence: &impl RepositoryEvidence,
    inventory: &Inventory,
) -> Result<Dossier, PlanningError> {
    let verified_facts = evidence.facts_for_atoms(&inventory.atoms)?;
    if verified_facts.is_empty() {
        return Err(PlanningError::NoRepositoryEvidence);
    }
    Ok(Dossier { verified_facts })
}

pub fn admit_question(nomination: QuestionNomination) -> Result<QuestionNomination, PlanningError> {
    if nomination.material_consequence.trim().is_empty() {
        Err(PlanningError::ImmaterialQuestion)
    } else {
        Ok(nomination)
    }
}
pub fn question_class_from_d72(value: &str) -> Result<QuestionClass, PlanningError> {
    let classes = table_values(DRIVER_TABLES_KDL, "planning.d72-question-classes", "values")
        .map_err(PlanningError::BadDeclaration)?;
    if classes.len() != D72_QUESTION_CLASS_VALUES.len() {
        return Err(PlanningError::BadDeclaration(
            "planning.d72-question-classes".to_owned(),
        ));
    }
    for (raw, class) in classes.iter().zip(D72_QUESTION_CLASS_VALUES) {
        if raw == value {
            return Ok(class);
        }
    }
    Err(PlanningError::RejectedQuestionClass(value.to_owned()))
}
pub fn require_total_dispositions(atoms: &[Atom]) -> Result<(), PlanningError> {
    for atom in atoms {
        if atom.disposition.is_none() {
            return Err(PlanningError::MissingDisposition(atom.id.clone()));
        }
    }
    Ok(())
}
pub fn require_material_backlinks(elements: &[MaterialPlanElement]) -> Result<(), PlanningError> {
    for element in elements {
        if element.backlinks.is_empty() {
            return Err(PlanningError::MissingBacklink(element.id.clone()));
        }
    }
    Ok(())
}
pub fn boundary_runtime(id: &'static str) -> BoundaryRuntime {
    runtime_by_id(id)
}

#[acceptance_boundary(id = "planning.task-atoms.v1", producer = Producer::Model, visible = true, admits = "Task extractor output must name operator-task atoms with source anchors and no repository findings.", mode = BoundaryMode::Enforce)]
pub fn accept_task_atoms(raw: &str, runtime: &BoundaryRuntime) -> Result<String, Rejection> {
    accept_contains(raw, "atom", runtime)
}
#[acceptance_boundary(id = "planning.scout-dossier.v1", producer = Producer::Model, visible = true, admits = "Repository scout and dossier output must cite current evidence and avoid work planning.", mode = BoundaryMode::Enforce)]
pub fn accept_scout_dossier(raw: &str, runtime: &BoundaryRuntime) -> Result<String, Rejection> {
    accept_contains(raw, "evidence", runtime)
}
#[acceptance_boundary(id = "planning.questions.v1", producer = Producer::Model, visible = true, admits = "Question output must be either an explicit empty set (`questions: []`) or structured nominations. Each nomination must include class, evidence, and consequence fields. The class field is closed to: invalidated-decision, missing-material-decision, material-underdetermination, dod-hole, unsafe-irreversible.", mode = BoundaryMode::Enforce)]
pub fn accept_questions(raw: &str, runtime: &BoundaryRuntime) -> Result<String, Rejection> {
    if accepts_question_output(raw) {
        Ok(raw.to_owned())
    } else {
        runtime.reject(raw)?;
        Ok(raw.to_owned())
    }
}
#[acceptance_boundary(id = "planning.work-map.v1", producer = Producer::Model, visible = true, admits = "Plan compiler and synthesizer output must contain one or more unit sections. Each unit must have an objective, acceptance criteria, and a traceable link by exact task phrase, atom id, source anchor, backlink, or verified evidence/fact.", mode = BoundaryMode::Enforce)]
pub fn accept_work_map(raw: &str, runtime: &BoundaryRuntime) -> Result<String, Rejection> {
    if accepts_work_map(raw) { Ok(raw.to_owned()) } else { runtime.reject(raw)?; Ok(raw.to_owned()) }
}
#[acceptance_boundary(id = "planning.plan-review.v1", producer = Producer::Model, visible = true, admits = "Plan review output must assign a verdict to each finding, using pass, blocker, advisory, fail, blocked, or needs-fix. It must include at least one verdict and must not give an overall pass while a substantive finding is left unclassified.", mode = BoundaryMode::Enforce)]
pub fn accept_plan_review(raw: &str, runtime: &BoundaryRuntime) -> Result<String, Rejection> {
    if accepts_plan_review(raw) { Ok(raw.to_owned()) } else { runtime.reject(raw)?; Ok(raw.to_owned()) }
}

#[derive(Debug, Eq, PartialEq)]
pub enum PlanningError {
    NoTaskAuthority,
    NoRepositoryEvidence,
    ImmaterialQuestion,
    RejectedQuestionClass(String),
    MissingDisposition(String),
    MissingBacklink(String),
    AssignmentCap { total: u8, cap: u8 },
    BadDeclaration(String),
    ContextGap(String),
}

fn accept_contains(raw: &str, required: &str, runtime: &BoundaryRuntime) -> Result<String, Rejection> {
    if raw.contains(required) { Ok(raw.to_owned()) } else { runtime.reject(raw)?; Ok(raw.to_owned()) }
}
enum MarkdownLine<'a> { Heading(&'a str), Bullet(&'a str), Text(&'a str) }
fn classify_markdown_line(line: &str) -> MarkdownLine<'_> {
    let trimmed = line.trim();
    match trimmed.as_bytes().first() { Some(b'#') => MarkdownLine::Heading(trimmed.trim_start_matches('#').trim_start()), Some(b'-' | b'*') => MarkdownLine::Bullet(trimmed[1..].trim_start()), _ => MarkdownLine::Text(trimmed) }
}
fn accepts_work_map(raw: &str) -> bool {
    let (mut units, mut seen, mut objective, mut criteria, mut link) = (0_u8, false, false, false, false);
    for line in raw.lines().chain(std::iter::once("### unit")) {
        let trimmed = line.trim();
        if matches!(classify_markdown_line(trimmed), MarkdownLine::Heading(text) if text.eq_ignore_ascii_case("unit")) {
            if seen { if !(objective && criteria && link) { return false; } units = units.saturating_add(1); }
            seen = true; objective = false; criteria = false; link = false; continue;
        }
        if let Some((field, value)) = structured_field(trimmed) { objective |= field == "objective" && !value.is_empty(); criteria |= field == "acceptance-criteria"; link |= has_trace_field(&field) && !value.is_empty(); }
    }
    units > 0
}
fn has_trace_field(field: &str) -> bool {
    ["exact-task-phrase", "atom-id", "source-anchor", "source", "anchor", "backlink", "evidence", "verified-fact"].contains(&field) || field.contains("task-phrase") || field.contains("atom")
}
fn accepts_plan_review(raw: &str) -> bool {
    let (mut verdicts, mut overall_pass, mut unclassified) = (0_u8, false, false);
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Some(pass) = verdict_is_pass(line) { verdicts = verdicts.saturating_add(1); overall_pass |= pass; } else { unclassified |= substantive_finding(line); }
    }
    verdicts > 0 && !(overall_pass && unclassified)
}
fn verdict_is_pass(line: &str) -> Option<bool> {
    let lower = line.trim_start_matches(['-', '*', '>']).trim_start().to_ascii_lowercase();
    let rest = lower.strip_prefix("verdict ").or_else(|| lower.strip_prefix("verdict:"))?;
    let class = rest.split(|ch: char| !ch.is_ascii_alphabetic() && ch != '-').find(|part| !part.is_empty())?;
    matches!(class, "pass" | "blocker" | "advisory" | "fail" | "blocked" | "needs-fix").then_some(class == "pass")
}
fn substantive_finding(line: &str) -> bool {
    let text = match classify_markdown_line(line) { MarkdownLine::Bullet(text) => text, MarkdownLine::Text(text) if named_finding(text) => text, _ => return false }.to_ascii_lowercase();
    ["must", "missing", "omission", "blocker", "substantive", "fail", "unsafe", "incomplete", "not covered"].iter().any(|word| text.contains(word))
}
fn named_finding(text: &str) -> bool {
    text.split(|ch: char| ch.is_ascii_whitespace() || ch == ':').next().is_some_and(|word| ["finding", "issue"].iter().any(|name| word.eq_ignore_ascii_case(name)))
}
fn accepts_question_output(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    let (mut classes, mut evidence, mut consequence) = (0_u8, false, false);
    for (field, value) in trimmed.lines().filter_map(structured_field) {
        if field == "class" || field == "admissible-class" {
            classes = classes.saturating_add(1);
            if question_class_from_d72(&value).is_err() {
                return false;
            }
        }
        evidence |= field.contains("evidence") && !value.is_empty();
        consequence |= field.contains("consequence") && !value.is_empty();
    }
    if classes > 0 {
        evidence && consequence
    } else {
        accepts_empty_question_text(trimmed)
    }
}
fn accepts_empty_question_text(raw: &str) -> bool {
    let compact = raw
        .split_whitespace()
        .collect::<String>()
        .to_ascii_lowercase();
    if [
        "questions:[]",
        "question_nominations:[]",
        "question-nominations:[]",
        "nominations:[]",
    ]
    .contains(&compact.as_str())
    {
        return true;
    }
    let tokens: Vec<String> = raw
        .split(|character: char| !character.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase)
        .collect();
    let has = |words: &[&str]| tokens.iter().any(|token| words.contains(&token.as_str()));
    has(&["no", "none", "zero"])
        && has(&["question", "questions", "nomination", "nominations"])
        && has(&[
            "qualifying",
            "qualifies",
            "qualify",
            "admissible",
            "material",
        ])
}
fn structured_field(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim().trim_start_matches(['-', '*', '>']).trim_start();
    let (field, value) = trimmed.split_once(':')?;
    Some((
        field
            .trim()
            .trim_matches('*')
            .to_ascii_lowercase()
            .replace(' ', "-"),
        value.trim().trim_matches('`').to_ascii_lowercase(),
    ))
}
fn parse_cap(attrs: &str) -> Result<u8, PlanningError> {
    match parse_attr(attrs, "default=")?.parse::<u8>() {
        Ok(cap) => Ok(cap),
        Err(error) => Err(PlanningError::BadDeclaration(error.to_string())),
    }
}
fn parse_attr(attrs: &str, name: &str) -> Result<String, PlanningError> {
    kdl_attr(attrs, name).ok_or_else(|| PlanningError::BadDeclaration(name.to_owned()))
}
