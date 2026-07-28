use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use crate::roles::kdl::{attr as kdl_attr, boundary_runtime as runtime_by_id, table_values};
use kernel::boundary::{BoundaryRuntime, Rejection};
use kernel::generated::{Id, PlanReview, Questions, Ref, ScoutDossier, TaskAtoms, WorkMap};
use kernel_macros::acceptance_boundary;
use sha2::{Digest as ShaDigest, Sha256};

pub const MODEL_BOUNDARIES: [&str; 5] = [
    "planning.task-atoms.v1",
    "planning.scout-dossier.v1",
    "planning.questions.v1",
    "planning.work-map.v1",
    "planning.plan-review.v1",
];
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
const D72_QUESTION_CLASS_VALUES: [QuestionClass; 5] = [
    QuestionClass::InvalidatedDecision,
    QuestionClass::MissingMaterialDecision,
    QuestionClass::MaterialUnderdetermination,
    QuestionClass::DodHole,
    QuestionClass::UnsafeIrreversible,
];
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
    pub fn total(&self) -> u8 {
        self.task_extractors
            + self.scout_and_compiler_first_pass
            + self.context_curator
            + self.synthesizers
            + self.reviewer
            + self.reserved_resolution
    }
    pub fn validate(&self, cap: u8) -> Result<(), PlanningError> {
        if self.total() > cap {
            Err(PlanningError::AssignmentCap {
                total: self.total(),
                cap,
            })
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskDocumentClass {
    Authority,
    ContextNonAuthority,
    HistoricalNonAuthority,
    IndexNonAuthority,
    InlineTask,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskDocument {
    pub id: String,
    pub path: String,
    pub class: TaskDocumentClass,
    pub authority_set_id: String,
    pub body: String,
    pub digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskInputSet {
    pub authority_set_id: String,
    pub authority_documents: Vec<TaskDocument>,
    pub context_documents: Vec<TaskDocument>,
}

pub trait TaskAuthority {
    fn input_set(&self) -> Result<TaskInputSet, PlanningError>;
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
        for line in text.split('\n') {
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
    let input_set = source.input_set()?;
    p1_inventory_from_input_set(&input_set)
}

pub fn p1_inventory_from_input_set(input_set: &TaskInputSet) -> Result<Inventory, PlanningError> {
    if input_set.authority_documents.is_empty() {
        return Err(PlanningError::NoTaskAuthority);
    }
    let mut atoms = Vec::new();
    for (index, document) in input_set.authority_documents.iter().enumerate() {
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

pub fn classify_task_file_pack(
    repo_root: &Path,
    raw_paths: &[PathBuf],
) -> Result<TaskInputSet, PlanningError> {
    admit_task_file_pack_shape(raw_paths)
        .map_err(|error| PlanningError::TaskInputOrder(error.actual().to_owned()))?;
    reject_link_ancestors(repo_root, Path::new("repo-root"))?;
    let canonical_root = fs::canonicalize(repo_root)
        .map_err(|error| PlanningError::TaskPath(format!("repo-root:{error}")))?;
    let mut seen = BTreeSet::new();
    let mut documents = Vec::new();
    for raw_path in raw_paths {
        let rel = validate_repo_relative_path(raw_path)?;
        if !seen.insert(rel.clone()) {
            return Err(PlanningError::DuplicateTaskPath(rel));
        }
        let full = canonical_root.join(&rel);
        reject_link_components(&canonical_root, &rel)?;
        let canonical_full = fs::canonicalize(&full)
            .map_err(|error| PlanningError::TaskPath(format!("{}:{error}", rel.display())))?;
        canonical_full
            .strip_prefix(&canonical_root)
            .map_err(|_| PlanningError::TaskPath(format!("escape:{}", rel.display())))?;
        require_regular_file(&canonical_full, &rel)?;
        let bytes = fs::read(&canonical_full)
            .map_err(|error| PlanningError::TaskPath(format!("read:{}:{error}", rel.display())))?;
        documents.push(classify_task_document(&rel, &bytes)?);
    }
    validate_task_input_set(documents)
}

fn reject_link_components(root: &Path, rel: &Path) -> Result<(), PlanningError> {
    let mut probe = root.to_path_buf();
    for component in rel.components() {
        probe.push(component.as_os_str());
        reject_link_path(&probe, rel)?;
    }
    Ok(())
}

fn reject_link_ancestors(path: &Path, label: &Path) -> Result<(), PlanningError> {
    let mut probe = PathBuf::new();
    for component in path.components() {
        probe.push(component.as_os_str());
        reject_link_path(&probe, label)?;
    }
    Ok(())
}

fn reject_link_path(path: &Path, rel: &Path) -> Result<(), PlanningError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(PlanningError::TaskPath(format!(
            "symlink:{}",
            rel.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(PlanningError::TaskPath(format!(
            "inspect:{}:{error}",
            rel.display()
        ))),
    }
}

fn require_regular_file(path: &Path, rel: &Path) -> Result<(), PlanningError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| PlanningError::TaskPath(format!("metadata:{}:{error}", rel.display())))?;
    if !metadata.file_type().is_file() {
        return Err(PlanningError::TaskPath(format!(
            "not-regular-file:{}",
            rel.display()
        )));
    }
    Ok(())
}

pub fn inline_task_input(body: String) -> Result<TaskInputSet, PlanningError> {
    if body.trim().is_empty() {
        return Err(PlanningError::NoTaskAuthority);
    }
    let digest = sha256_hex(body.as_bytes());
    Ok(TaskInputSet {
        authority_set_id: "inline-task".to_owned(),
        authority_documents: vec![TaskDocument {
            id: "operator-request".to_owned(),
            path: "operator-request".to_owned(),
            class: TaskDocumentClass::InlineTask,
            authority_set_id: "inline-task".to_owned(),
            body,
            digest,
        }],
        context_documents: Vec::new(),
    })
}

#[acceptance_boundary(
    id = "planning.task-document-header.v1",
    producer = Producer::Operator,
    visible = true,
    admits = "Task files must begin byte-exactly with one recognized marker line, line 2 authority_set_id: <non-empty-id>, and an empty line 3; BOM, CRLF, unknown markers, and empty bodies are rejected.",
    mode = BoundaryMode::Enforce
)]
pub fn admit_task_document_header(document: &TaskDocument) -> Result<&TaskDocument, Rejection> {
    if document.authority_set_id.trim().is_empty() || document.body.trim().is_empty() {
        boundary_runtime("planning.task-document-header.v1")
            .reject("empty authority_set_id or body".to_owned())?;
    }
    Ok(document)
}

#[acceptance_boundary(
    id = "planning.task-file-pack.v1",
    producer = Producer::Operator,
    visible = true,
    admits = "File-backed /autopilot-plan admits distinct repository-relative regular files supplied as task paths; byte-exact first-line markers must include at least one [authority] document and at least one [context/non-authority] document with one shared authority_set_id; order is not significant, and historical/index markers are recognized but forbidden inputs.",
    mode = BoundaryMode::Enforce
)]
pub fn admit_task_file_pack_shape(raw_paths: &[PathBuf]) -> Result<&[PathBuf], Rejection> {
    Ok(raw_paths)
}

fn validate_repo_relative_path(raw_path: &Path) -> Result<PathBuf, PlanningError> {
    if raw_path.is_absolute() {
        return Err(PlanningError::TaskPath(format!(
            "absolute:{}",
            raw_path.display()
        )));
    }
    let raw = raw_path
        .to_str()
        .ok_or_else(|| PlanningError::TaskPath("non-utf8-path".to_owned()))?;
    if raw.find('\\').is_some() {
        return Err(PlanningError::TaskPath(format!("backslash:{raw}")));
    }
    let mut out = PathBuf::new();
    for component in raw_path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(PlanningError::TaskPath(format!("unsafe-component:{raw}")));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err(PlanningError::TaskPath("empty-path".to_owned()));
    }
    Ok(out)
}

fn classify_task_document(rel: &Path, bytes: &[u8]) -> Result<TaskDocument, PlanningError> {
    if bytes.get(0..3) == Some(&[0xEF, 0xBB, 0xBF][..]) {
        return Err(PlanningError::TaskHeader(format!("bom:{}", rel.display())));
    }
    if bytes.iter().position(|byte| *byte == b'\r').is_some() {
        return Err(PlanningError::TaskHeader(format!("crlf:{}", rel.display())));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| PlanningError::TaskHeader(format!("non-utf8:{}", rel.display())))?;
    if text.is_empty() {
        return Err(PlanningError::TaskHeader(format!(
            "missing-marker:{}",
            rel.display()
        )));
    }
    let mut lines = text.split('\n');
    let marker = lines
        .next()
        .ok_or_else(|| PlanningError::TaskHeader(format!("missing-marker:{}", rel.display())))?;
    let class = match marker {
        "[authority]" => TaskDocumentClass::Authority,
        "[context/non-authority]" => TaskDocumentClass::ContextNonAuthority,
        "[historical/non-authority]" => TaskDocumentClass::HistoricalNonAuthority,
        "[index/non-authority]" => TaskDocumentClass::IndexNonAuthority,
        other => {
            return Err(PlanningError::TaskHeader(format!(
                "unknown-marker:{}:{other}",
                rel.display()
            )));
        }
    };
    let authority_line = lines.next().ok_or_else(|| {
        PlanningError::TaskHeader(format!("missing-authority-set:{}", rel.display()))
    })?;
    let Some(authority_set_id) = authority_line.strip_prefix("authority_set_id: ") else {
        return Err(PlanningError::TaskHeader(format!(
            "bad-authority-line:{}",
            rel.display()
        )));
    };
    if authority_set_id.is_empty() || authority_set_id.trim() != authority_set_id {
        return Err(PlanningError::TaskHeader(format!(
            "bad-authority-id:{}",
            rel.display()
        )));
    }
    let empty = lines.next().ok_or_else(|| {
        PlanningError::TaskHeader(format!("missing-empty-line:{}", rel.display()))
    })?;
    if !empty.is_empty() {
        return Err(PlanningError::TaskHeader(format!(
            "line3-not-empty:{}",
            rel.display()
        )));
    }
    let body = lines.collect::<Vec<_>>().join("\n");
    if body.trim().is_empty() {
        return Err(PlanningError::TaskHeader(format!(
            "empty-body:{}",
            rel.display()
        )));
    }
    let document = TaskDocument {
        id: rel.display().to_string(),
        path: rel.display().to_string(),
        class,
        authority_set_id: authority_set_id.to_owned(),
        body,
        digest: sha256_hex(bytes),
    };
    admit_task_document_header(&document)
        .map_err(|error| PlanningError::TaskHeader(error.actual().to_owned()))?;
    Ok(document)
}

fn validate_task_input_set(documents: Vec<TaskDocument>) -> Result<TaskInputSet, PlanningError> {
    for document in &documents {
        match document.class {
            TaskDocumentClass::HistoricalNonAuthority => {
                return Err(PlanningError::HistoricalTaskInput(format!(
                    "forbidden [historical/non-authority] input: {}",
                    document.path
                )));
            }
            TaskDocumentClass::IndexNonAuthority => {
                return Err(PlanningError::IndexTaskInput(format!(
                    "forbidden [index/non-authority] input: {}",
                    document.path
                )));
            }
            TaskDocumentClass::Authority
            | TaskDocumentClass::ContextNonAuthority
            | TaskDocumentClass::InlineTask => {}
        }
    }

    if let Some(first) = documents.first() {
        for document in documents.iter().skip(1) {
            if document.authority_set_id != first.authority_set_id {
                return Err(PlanningError::TaskAuthoritySetMismatch(format!(
                    "authority_set_id mismatch: {}={} {}={}",
                    first.path, first.authority_set_id, document.path, document.authority_set_id
                )));
            }
        }
    }

    let mut authority_documents = Vec::new();
    let mut context_documents = Vec::new();
    for document in documents {
        match document.class {
            TaskDocumentClass::Authority => authority_documents.push(document),
            TaskDocumentClass::ContextNonAuthority => context_documents.push(document),
            TaskDocumentClass::InlineTask => authority_documents.push(document),
            TaskDocumentClass::HistoricalNonAuthority | TaskDocumentClass::IndexNonAuthority => {
                unreachable!("forbidden classes were rejected before partition")
            }
        }
    }
    if authority_documents.is_empty() {
        return Err(PlanningError::TaskInputInvariant(
            "no [authority] document supplied".to_owned(),
        ));
    }
    if context_documents.is_empty() {
        return Err(PlanningError::TaskInputInvariant(
            "no [context/non-authority] document supplied".to_owned(),
        ));
    }
    let authority_set_id = authority_documents[0].authority_set_id.clone();
    Ok(TaskInputSet {
        authority_set_id,
        authority_documents,
        context_documents,
    })
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
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

#[acceptance_boundary(id = "planning.task-atoms.v1", producer = Producer::Model, visible = true, admits = "Task extractor output must name operator-task atoms with source anchors and no repository findings. Call autopilot_submit_atoms as the final action with atoms containing id, kind, text, and sources.", mode = BoundaryMode::Enforce)]
pub fn accept_task_atoms(raw: &str, runtime: &BoundaryRuntime) -> Result<String, Rejection> {
    let atoms = parse_model_payload::<TaskAtoms>(raw, runtime, "planning.task-atoms.v1")?;
    validate_task_atoms_shape(&atoms, runtime)?;
    Ok(raw.to_owned())
}
#[acceptance_boundary(id = "planning.scout-dossier.v1", producer = Producer::Model, visible = true, admits = "Repository scout and dossier output must cite current evidence and avoid work planning. Call autopilot_submit_scout_report as the final action with findings containing path, observation, and evidence_ref.", mode = BoundaryMode::Enforce)]
pub fn accept_scout_dossier(raw: &str, runtime: &BoundaryRuntime) -> Result<String, Rejection> {
    let dossier = parse_model_payload::<ScoutDossier>(raw, runtime, "planning.scout-dossier.v1")?;
    validate_scout_dossier_shape(&dossier, runtime)?;
    Ok(raw.to_owned())
}
#[acceptance_boundary(id = "planning.questions.v1", producer = Producer::Model, visible = true, admits = "Question output must be an explicit questions array, which may be empty, or structured nominations. Each nomination must include class, evidence, and consequence. The class field is closed to: invalidated-decision, missing-material-decision, material-underdetermination, dod-hole, unsafe-irreversible.", mode = BoundaryMode::Enforce)]
pub fn accept_questions(raw: &str, runtime: &BoundaryRuntime) -> Result<String, Rejection> {
    let questions = parse_model_payload::<Questions>(raw, runtime, "planning.questions.v1")?;
    validate_questions_shape(&questions, runtime)?;
    Ok(raw.to_owned())
}
#[acceptance_boundary(id = "planning.work-map.v1", producer = Producer::Model, visible = true, admits = "Plan compiler and synthesizer output must contain one or more units. Each unit must have an objective, acceptance criteria, and traceable links by real atom id. Call autopilot_submit_plan_cluster or autopilot_submit_synthesis as the final action.", mode = BoundaryMode::Enforce)]
pub fn accept_work_map(raw: &str, runtime: &BoundaryRuntime) -> Result<String, Rejection> {
    let work_map = parse_model_payload::<WorkMap>(raw, runtime, "planning.work-map.v1")?;
    validate_work_map_shape(&work_map, runtime)?;
    Ok(raw.to_owned())
}
#[acceptance_boundary(id = "planning.plan-review.v1", producer = Producer::Model, visible = true, admits = "Plan review output must assign a verdict to each criterion using pass, blocker, advisory, fail, blocked, or needs-fix. It must include at least one verdict. Call autopilot_submit_review as the final action.", mode = BoundaryMode::Enforce)]
pub fn accept_plan_review(raw: &str, runtime: &BoundaryRuntime) -> Result<String, Rejection> {
    let review = parse_model_payload::<PlanReview>(raw, runtime, "planning.plan-review.v1")?;
    validate_plan_review_shape(&review, runtime)?;
    Ok(raw.to_owned())
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
    TaskPath(String),
    TaskHeader(String),
    TaskInputCount { expected: usize, actual: usize },
    TaskInputOrder(String),
    TaskInputInvariant(String),
    DuplicateTaskPath(PathBuf),
    TaskAuthoritySetMismatch(String),
    HistoricalTaskInput(String),
    IndexTaskInput(String),
}

pub fn accept_task_atoms_payload(atoms: TaskAtoms) -> Result<TaskAtoms, Rejection> {
    let runtime = boundary_runtime("planning.task-atoms.v1");
    validate_task_atoms_shape(&atoms, &runtime)?;
    Ok(atoms)
}

pub fn accept_scout_dossier_payload(dossier: ScoutDossier) -> Result<ScoutDossier, Rejection> {
    let runtime = boundary_runtime("planning.scout-dossier.v1");
    validate_scout_dossier_shape(&dossier, &runtime)?;
    Ok(dossier)
}

pub fn accept_questions_payload(questions: Questions) -> Result<Questions, Rejection> {
    let runtime = boundary_runtime("planning.questions.v1");
    validate_questions_shape(&questions, &runtime)?;
    Ok(questions)
}

pub fn accept_work_map_payload(work_map: WorkMap) -> Result<WorkMap, Rejection> {
    let runtime = boundary_runtime("planning.work-map.v1");
    validate_work_map_shape(&work_map, &runtime)?;
    Ok(work_map)
}

pub fn accept_plan_review_payload(review: PlanReview) -> Result<PlanReview, Rejection> {
    let runtime = boundary_runtime("planning.plan-review.v1");
    validate_plan_review_shape(&review, &runtime)?;
    Ok(review)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskAnchorRegistry {
    anchors: BTreeSet<String>,
}

impl TaskAnchorRegistry {
    pub fn from_input_set(input_set: &TaskInputSet) -> Self {
        let anchors = input_set
            .authority_documents
            .iter()
            .chain(input_set.context_documents.iter())
            .flat_map(|document| {
                let base = format!("task://{}/{}", document.digest, document.path);
                [base.clone(), format!("{base}#whole-file")]
            })
            .collect();
        Self { anchors }
    }

    pub fn has(&self, source: &Ref) -> bool {
        self.anchors.iter().any(|anchor| anchor == &source.0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoRelPath(PathBuf);

impl RepoRelPath {
    pub fn parse(raw: &str) -> Result<Self, PlanningError> {
        validate_repo_relative_path(Path::new(raw)).map(Self)
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PinnedRepo {
    pub repo_root: PathBuf,
    pub base_commit: String,
}

pub fn accept_task_atoms_with_anchors(
    atoms: TaskAtoms,
    anchors: &TaskAnchorRegistry,
) -> Result<TaskAtoms, Rejection> {
    let runtime = boundary_runtime("planning.task-atoms.v1");
    validate_task_atoms_shape(&atoms, &runtime)?;
    for atom in &atoms.atoms {
        for source in &atom.sources {
            if !anchors.has(source) {
                return reject_value(
                    &runtime,
                    "planning.task-atoms.v1",
                    "atoms.sources",
                    "a real task-document anchor supplied by package authority",
                    &source.0,
                    "Use only task:// anchors from the task authority manifest.",
                );
            }
        }
    }
    Ok(atoms)
}

pub fn accept_scout_dossier_at_base(
    dossier: ScoutDossier,
    repo: &PinnedRepo,
) -> Result<ScoutDossier, Rejection> {
    let runtime = boundary_runtime("planning.scout-dossier.v1");
    validate_scout_dossier_shape(&dossier, &runtime)?;
    for finding in &dossier.findings {
        let rel = match RepoRelPath::parse(&finding.path.0) {
            Ok(rel) => rel,
            Err(error) => {
                return reject_value(
                    &runtime,
                    "planning.scout-dossier.v1",
                    "findings.path",
                    "repository-relative UTF-8 path with no absolute root, parent component, or backslash",
                    &format!("{:?}", error),
                    "Cite a path relative to the pinned repository root.",
                );
            }
        };
        if !repo_path_exists_at_commit(repo, rel.as_path()) {
            return reject_value(
                &runtime,
                "planning.scout-dossier.v1",
                "findings.path",
                "path exists in the repository at the pinned base commit",
                &finding.path.0,
                "Re-read the pinned checkout and cite an existing file or directory.",
            );
        }
    }
    Ok(dossier)
}

pub fn accept_work_map_for_atoms(
    work_map: WorkMap,
    atom_ids: &BTreeSet<Id>,
) -> Result<WorkMap, Rejection> {
    let runtime = boundary_runtime("planning.work-map.v1");
    validate_work_map_shape(&work_map, &runtime)?;
    for unit in &work_map.units {
        for link in &unit.links {
            if atom_ids.get(link).is_none() {
                return reject_value(
                    &runtime,
                    "planning.work-map.v1",
                    "units.links",
                    "an atom id accepted by planning.task-atoms.v1",
                    &link.0,
                    "Link each plan unit to a real accepted atom id.",
                );
            }
        }
    }
    Ok(work_map)
}

fn parse_model_payload<T: serde::de::DeserializeOwned>(
    raw: &str,
    runtime: &BoundaryRuntime,
    boundary_id: &'static str,
) -> Result<T, Rejection> {
    serde_json::from_str::<T>(raw).map_err(|error| {
        force_rejection(
            runtime,
            boundary_id,
            "payload",
            "JSON matching the generated terminating-tool schema",
            &format!("json:{error}"),
            "Call the declared autopilot_submit_* tool; do not return prose as the carrier.",
        )
    })
}

fn validate_task_atoms_shape(
    atoms: &TaskAtoms,
    runtime: &BoundaryRuntime,
) -> Result<(), Rejection> {
    for atom in &atoms.atoms {
        if is_blank(&atom.id.0) {
            reject_value(
                runtime,
                "planning.task-atoms.v1",
                "atoms.id",
                "non-empty atom id",
                &atom.id.0,
                "Use the stable atom id supplied or derived for this task atom.",
            )?;
        }
        if is_blank(&atom.text) {
            reject_value(
                runtime,
                "planning.task-atoms.v1",
                "atoms.text",
                "non-empty task-authority text",
                &atom.text,
                "Summarize the operator-task statement instead of leaving the atom blank.",
            )?;
        }
        if atom.sources.is_empty() {
            reject_value(
                runtime,
                "planning.task-atoms.v1",
                "atoms.sources",
                "at least one task-document anchor",
                "[]",
                "Attach the source anchor that supports the atom.",
            )?;
        }
    }
    Ok(())
}

fn validate_scout_dossier_shape(
    dossier: &ScoutDossier,
    runtime: &BoundaryRuntime,
) -> Result<(), Rejection> {
    for finding in &dossier.findings {
        if is_blank(&finding.path.0) {
            reject_value(
                runtime,
                "planning.scout-dossier.v1",
                "findings.path",
                "non-empty repository-relative path",
                &finding.path.0,
                "Cite the repository path that supports this finding.",
            )?;
        }
        if is_blank(&finding.observation) {
            reject_value(
                runtime,
                "planning.scout-dossier.v1",
                "findings.observation",
                "non-empty repository observation",
                &finding.observation,
                "State the fact observed in the repository.",
            )?;
        }
        if is_blank(&finding.evidence_ref.0) {
            reject_value(
                runtime,
                "planning.scout-dossier.v1",
                "findings.evidence_ref",
                "non-empty evidence ref",
                &finding.evidence_ref.0,
                "Attach the evidence reference produced by the scout read.",
            )?;
        }
    }
    Ok(())
}

fn validate_questions_shape(
    questions: &Questions,
    runtime: &BoundaryRuntime,
) -> Result<(), Rejection> {
    for question in &questions.questions {
        if is_blank(&question.evidence) {
            reject_value(
                runtime,
                "planning.questions.v1",
                "questions.evidence",
                "non-empty evidence summary",
                &question.evidence,
                "Name the evidence gap or contradiction that makes the question material.",
            )?;
        }
        if is_blank(&question.consequence) {
            reject_value(
                runtime,
                "planning.questions.v1",
                "questions.consequence",
                "non-empty material consequence",
                &question.consequence,
                "Explain what cannot safely be planned without the answer.",
            )?;
        }
    }
    Ok(())
}

fn validate_work_map_shape(work_map: &WorkMap, runtime: &BoundaryRuntime) -> Result<(), Rejection> {
    if work_map.units.is_empty() {
        reject_value(
            runtime,
            "planning.work-map.v1",
            "units",
            "one or more plan units",
            "[]",
            "Submit at least one executable plan unit.",
        )?;
    }
    for unit in &work_map.units {
        if is_blank(&unit.id.0) {
            reject_value(
                runtime,
                "planning.work-map.v1",
                "units.id",
                "non-empty unit id",
                &unit.id.0,
                "Use a stable id for each plan unit.",
            )?;
        }
        if is_blank(&unit.objective) {
            reject_value(
                runtime,
                "planning.work-map.v1",
                "units.objective",
                "non-empty unit objective",
                &unit.objective,
                "State the unit objective.",
            )?;
        }
        if unit.criteria.is_empty() {
            reject_value(
                runtime,
                "planning.work-map.v1",
                "units.criteria",
                "one or more acceptance criteria",
                "[]",
                "Attach criteria that make the unit verifiable.",
            )?;
        }
        if unit.links.is_empty() {
            reject_value(
                runtime,
                "planning.work-map.v1",
                "units.links",
                "one or more atom links",
                "[]",
                "Link the unit to accepted atom ids.",
            )?;
        }
    }
    Ok(())
}

fn validate_plan_review_shape(
    review: &PlanReview,
    runtime: &BoundaryRuntime,
) -> Result<(), Rejection> {
    if review.verdicts.is_empty() {
        reject_value(
            runtime,
            "planning.plan-review.v1",
            "verdicts",
            "at least one criterion verdict",
            "[]",
            "Verdict each supplied review criterion.",
        )?;
    }
    for verdict in &review.verdicts {
        if is_blank(&verdict.criterion_id.0) {
            reject_value(
                runtime,
                "planning.plan-review.v1",
                "verdicts.criterion_id",
                "non-empty criterion id",
                &verdict.criterion_id.0,
                "Name the criterion being reviewed.",
            )?;
        }
    }
    Ok(())
}

fn repo_path_exists_at_commit(repo: &PinnedRepo, rel: &Path) -> bool {
    let object = format!("{}:{}", repo.base_commit, rel.display());
    Command::new("git")
        .current_dir(&repo.repo_root)
        .args(["cat-file", "-e", &object])
        .status()
        .is_ok_and(|status| status.success())
}

fn reject_value<T>(
    runtime: &BoundaryRuntime,
    boundary_id: &'static str,
    field: &str,
    expected: &str,
    got: &str,
    hint: &str,
) -> Result<T, Rejection> {
    Err(force_rejection(
        runtime,
        boundary_id,
        field,
        expected,
        got,
        hint,
    ))
}

fn force_rejection(
    runtime: &BoundaryRuntime,
    boundary_id: &'static str,
    field: &str,
    expected: &str,
    got: &str,
    hint: &str,
) -> Rejection {
    let detail = format!(
        "boundary_id={boundary_id}; field={field}; expected={expected}; got={got}; hint={hint}"
    );
    match runtime.reject(detail) {
        Err(rejection) => rejection,
        Ok(()) => panic!("model boundary {boundary_id} unexpectedly ran outside enforce mode"),
    }
}

fn is_blank(value: &str) -> bool {
    value.chars().all(char::is_whitespace)
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
