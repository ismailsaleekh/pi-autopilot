use std::collections::BTreeSet;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictId(pub String);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictHunk {
    pub id: ConflictId,
    pub path: String,
    pub class: ConflictClass,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConflictClass {
    Textual,
    DeleteModify,
    ProtectedSurface,
    SemanticHighRisk,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SideFacts {
    pub commit: String,
    pub tree: String,
    pub diff: String,
    pub criteria: Vec<String>,
    pub open_findings: Vec<String>,
    pub changed_paths: Vec<String>,
    pub focused_tests: Vec<String>,
    pub downstream_contracts: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictBundle {
    pub common_base: String,
    pub current: SideFacts,
    pub incoming: SideFacts,
    pub hunks: Vec<ConflictHunk>,
    pub operator_atoms: Vec<String>,
    pub constraints_for_both: Vec<String>,
}

impl ConflictBundle {
    pub fn symmetric(&self) -> bool {
        !self.current.diff.is_empty()
            && !self.incoming.diff.is_empty()
            && !self.current.criteria.is_empty()
            && !self.incoming.criteria.is_empty()
            && !self.constraints_for_both.is_empty()
    }

    pub fn overlap_tests(&self) -> Vec<String> {
        let mut out = BTreeSet::new();
        for test in self
            .current
            .focused_tests
            .iter()
            .chain(&self.incoming.focused_tests)
        {
            out.insert(test.clone());
        }
        out.into_iter().collect()
    }

    pub fn high_risk(&self) -> bool {
        self.hunks
            .iter()
            .any(|hunk| hunk.class == ConflictClass::SemanticHighRisk)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateState {
    pub files: Vec<FileContent>,
    pub unmerged_index_entries: Vec<String>,
    pub dropped_sides: Vec<DroppedSide>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileContent {
    pub path: String,
    pub bytes: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DroppedSide {
    pub conflict_id: ConflictId,
    pub side: Side,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Side {
    Current,
    Incoming,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictResolution {
    pub commit: String,
    pub behavior_map: Vec<PreservedBehavior>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreservedBehavior {
    pub conflict_id: ConflictId,
    pub preserves_current: bool,
    pub preserves_incoming: bool,
    pub rationale: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum CheckKind {
    AffectedBuild,
    FocusedTest,
    ConflictReview,
    FullSuite,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConflictCheckPlan {
    pub commands: Vec<String>,
    pub checks: Vec<CheckKind>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConflictError {
    AsymmetricBundle,
    ConflictMarkers(String),
    UnmergedIndex(Vec<String>),
    DroppedSide(ConflictId),
    MissingBehaviorMap(ConflictId),
    BlindSideChoice(ConflictId),
}

pub fn check_plan(bundle: &ConflictBundle) -> ConflictCheckPlan {
    let mut checks = BTreeSet::new();
    checks.insert(CheckKind::AffectedBuild);
    checks.insert(CheckKind::FocusedTest);
    if bundle.high_risk() {
        checks.insert(CheckKind::ConflictReview);
    }
    ConflictCheckPlan {
        commands: bundle.overlap_tests(),
        checks: checks.into_iter().collect(),
    }
}

pub fn validate_resolution(
    bundle: &ConflictBundle,
    candidate: &CandidateState,
    resolution: &ConflictResolution,
) -> Result<ConflictCheckPlan, ConflictError> {
    if !bundle.symmetric() {
        return Err(ConflictError::AsymmetricBundle);
    }
    if !candidate.unmerged_index_entries.is_empty() {
        return Err(ConflictError::UnmergedIndex(
            candidate.unmerged_index_entries.clone(),
        ));
    }
    for file in &candidate.files {
        if has_conflict_marker(&file.bytes) {
            return Err(ConflictError::ConflictMarkers(file.path.clone()));
        }
    }
    if let Some(dropped) = candidate.dropped_sides.first() {
        return Err(ConflictError::DroppedSide(dropped.conflict_id.clone()));
    }
    for hunk in &bundle.hunks {
        let Some(mapping) = resolution
            .behavior_map
            .iter()
            .find(|entry| entry.conflict_id == hunk.id)
        else {
            return Err(ConflictError::MissingBehaviorMap(hunk.id.clone()));
        };
        if !(mapping.preserves_current && mapping.preserves_incoming)
            || blind_choice(&mapping.rationale)
        {
            return Err(ConflictError::BlindSideChoice(hunk.id.clone()));
        }
    }
    Ok(check_plan(bundle))
}

fn has_conflict_marker(text: &str) -> bool {
    text.contains("<<<<<<<") || text.contains("=======") || text.contains(">>>>>>>")
}

fn blind_choice(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    ["ours", "theirs", "deleted the markers"]
        .iter()
        .any(|word| lowered.contains(word))
}
