use std::collections::BTreeSet;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidationRecord {
    pub evidence_id: String,
    pub role_id: String,
    pub assignment_id: String,
    pub commit: String,
    pub tree: String,
    pub covered: Vec<CriterionCoverage>,
    pub command_evidence: CommandEvidence,
    pub forward_edges: Vec<String>,
    pub closure_edges: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CriterionCoverage {
    pub criterion_id: String,
    pub witness_id: String,
    pub paths: Vec<String>,
    pub surfaces: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandEvidence {
    pub command: String,
    pub exit_code: i32,
    pub output_ref: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MergeChange {
    pub changed_paths: Vec<String>,
    pub changed_surfaces: Vec<String>,
    pub affected_forward_edges: Vec<String>,
    pub closed_forward_edges: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StalenessReport {
    pub current_evidence: Vec<String>,
    pub stale: Vec<StaleEvidence>,
    pub successor_edges: Vec<SuccessorEdgeAction>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StaleEvidence {
    pub evidence_id: String,
    pub criteria: Vec<String>,
    pub surfaces: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SuccessorEdgeAction {
    Refresh { edge_id: String },
    Close { edge_id: String },
}

pub fn compute_staleness(records: &[ValidationRecord], change: &MergeChange) -> StalenessReport {
    let mut current_evidence = Vec::new();
    let mut stale = Vec::new();
    for record in records {
        let affected = stale_coverage(record, change);
        if affected.is_empty() {
            current_evidence.push(record.evidence_id.clone());
        } else {
            stale.push(StaleEvidence {
                evidence_id: record.evidence_id.clone(),
                criteria: affected.criteria,
                surfaces: affected.surfaces,
            });
        }
    }
    let mut successor_edges = Vec::new();
    for edge_id in &change.affected_forward_edges {
        if change
            .closed_forward_edges
            .iter()
            .any(|closed| closed == edge_id)
        {
            successor_edges.push(SuccessorEdgeAction::Close {
                edge_id: edge_id.clone(),
            });
        } else {
            successor_edges.push(SuccessorEdgeAction::Refresh {
                edge_id: edge_id.clone(),
            });
        }
    }
    StalenessReport {
        current_evidence,
        stale,
        successor_edges,
    }
}

struct AffectedCoverage {
    criteria: Vec<String>,
    surfaces: Vec<String>,
}

impl AffectedCoverage {
    fn is_empty(&self) -> bool {
        self.criteria.is_empty() && self.surfaces.is_empty()
    }
}

fn stale_coverage(record: &ValidationRecord, change: &MergeChange) -> AffectedCoverage {
    let mut criteria = BTreeSet::new();
    let mut surfaces = BTreeSet::new();
    for coverage in &record.covered {
        let path_hit = overlap(&coverage.paths, &change.changed_paths);
        let surface_hits = intersection(&coverage.surfaces, &change.changed_surfaces);
        if path_hit || !surface_hits.is_empty() {
            criteria.insert(coverage.criterion_id.clone());
        }
        for surface in surface_hits {
            surfaces.insert(surface);
        }
    }
    AffectedCoverage {
        criteria: criteria.into_iter().collect(),
        surfaces: surfaces.into_iter().collect(),
    }
}

fn overlap(left: &[String], right: &[String]) -> bool {
    left.iter()
        .any(|item| right.iter().any(|other| item == other))
}

fn intersection(left: &[String], right: &[String]) -> Vec<String> {
    left.iter()
        .filter(|item| right.iter().any(|other| *item == other))
        .cloned()
        .collect()
}
