use std::collections::{BTreeMap, BTreeSet};

use kernel::boundary::Rejection;
use kernel::generated::{
    CriterionResult, CriterionVerdict, Finding, FindingEffect, ForwardVerdict, Id,
    Path as CoveredPath, Ref, ValidationVerdict,
};
use kernel_macros::acceptance_boundary;

pub const BOUNDARY_ID: &str = "validation.verdict.v1";
pub const VALIDATION_TABLE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../data/validation.kdl"
));

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum ForwardRound {
    One,
    Two,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RequiredCriterion {
    pub id: Id,
    pub covered_paths: Vec<CoveredPath>,
    pub semantic_surface_ids: Vec<Id>,
    pub forward_edge_ids: Vec<Id>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum ForwardDecision {
    Release,
    ConsolidatedRecoveryEngineer { blocker_ids: Vec<Id> },
    Tier23 { blocker_ids: Vec<Id> },
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum ValidationError {
    WrongScope(String),
    MissingForwardVerdict,
    UnexpectedClosureVerdict,
    DuplicateCriterion(Id),
    MissingCriterion(Id),
    UnknownCriterion(Id),
    MissingEvidence(Id),
    MissingCoverage(Id),
    CoverageMismatch(Id),
    OverallReadyWithBlockers(Vec<Id>),
    OverallBlockedWithoutBlocker,
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct CommandSpec {
    pub command: String,
    pub cwd: String,
    pub env_profile: String,
    pub commit: String,
}

#[acceptance_boundary(
    id = "validation.verdict.v1",
    producer = Producer::Model,
    visible = true,
    admits = "Verdict every required criterion independently as PASS, FAIL, or BLOCKED, and attach evidence refs, finding refs, covered paths, semantic surfaces, and forward-edge ids. Do not issue an overall PASS while any required criterion is unverdicted, stale, failed, or blocked. Use FORWARD_READY, FORWARD_BLOCKED, or BLOCKED only for forward validation, and PASS, NEEDS_FIX, or BLOCKED only for closure/final validation.",
    mode = BoundaryMode::Enforce
)]
pub fn submit_validation_verdict(
    verdict: ValidationVerdict,
) -> Result<ValidationVerdict, Rejection> {
    Ok(verdict)
}

pub fn select_forward_commands(
    linked_commands: &[CommandSpec],
    package_checks: &[CommandSpec],
) -> Result<Vec<CommandSpec>, ValidationError> {
    if !VALIDATION_TABLE.contains("mode \"forward\"") || !VALIDATION_TABLE.contains("verdict_route")
    {
        return Err(ValidationError::WrongScope("validation-table".to_owned()));
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for command in linked_commands.iter().chain(package_checks) {
        if seen.insert(command.clone()) {
            out.push(command.clone());
        }
    }
    Ok(out)
}

pub fn decide_forward_round(
    round: ForwardRound,
    required: &[RequiredCriterion],
    verdict: &ValidationVerdict,
    findings: &[Finding],
) -> Result<ForwardDecision, ValidationError> {
    if verdict.validation_scope.0 != "forward" {
        return Err(ValidationError::WrongScope(
            verdict.validation_scope.0.clone(),
        ));
    }
    if verdict.closure_verdict.is_some() {
        return Err(ValidationError::UnexpectedClosureVerdict);
    }
    let overall = verdict
        .forward_verdict
        .as_ref()
        .ok_or(ValidationError::MissingForwardVerdict)?;
    let required_by_id = required
        .iter()
        .map(|criterion| (criterion.id.clone(), criterion))
        .collect::<BTreeMap<_, _>>();
    let results = index_results(&verdict.criterion_results, &required_by_id)?;
    let mut blockers = criterion_blockers(required, &results)?;
    blockers.extend(forward_finding_blockers(findings));
    blockers.sort();
    blockers.dedup();

    match (overall, blockers.is_empty()) {
        (ForwardVerdict::FORWARDREADY, true) => Ok(ForwardDecision::Release),
        (ForwardVerdict::FORWARDREADY, false) => {
            Err(ValidationError::OverallReadyWithBlockers(blockers))
        }
        (ForwardVerdict::FORWARDBLOCKED | ForwardVerdict::BLOCKED, true) => {
            Err(ValidationError::OverallBlockedWithoutBlocker)
        }
        (ForwardVerdict::FORWARDBLOCKED | ForwardVerdict::BLOCKED, false) => match round {
            ForwardRound::One => Ok(ForwardDecision::ConsolidatedRecoveryEngineer {
                blocker_ids: blockers,
            }),
            ForwardRound::Two => Ok(ForwardDecision::Tier23 {
                blocker_ids: blockers,
            }),
        },
    }
}

fn index_results<'a>(
    results: &'a [CriterionResult],
    required: &BTreeMap<Id, &RequiredCriterion>,
) -> Result<BTreeMap<Id, &'a CriterionResult>, ValidationError> {
    let mut indexed = BTreeMap::new();
    for result in results {
        if !required.contains_key(&result.criterion_id) {
            return Err(ValidationError::UnknownCriterion(
                result.criterion_id.clone(),
            ));
        }
        if indexed
            .insert(result.criterion_id.clone(), result)
            .is_some()
        {
            return Err(ValidationError::DuplicateCriterion(
                result.criterion_id.clone(),
            ));
        }
    }
    for id in required.keys() {
        if !indexed.contains_key(id) {
            return Err(ValidationError::MissingCriterion(id.clone()));
        }
    }
    Ok(indexed)
}

fn criterion_blockers(
    required: &[RequiredCriterion],
    results: &BTreeMap<Id, &CriterionResult>,
) -> Result<Vec<Id>, ValidationError> {
    let mut blockers = Vec::new();
    for criterion in required {
        let result = results
            .get(&criterion.id)
            .ok_or_else(|| ValidationError::MissingCriterion(criterion.id.clone()))?;
        require_result_evidence(result)?;
        require_coverage(criterion, result)?;
        if result.verdict != CriterionVerdict::PASS {
            blockers.push(criterion.id.clone());
        }
    }
    Ok(blockers)
}

fn require_result_evidence(result: &CriterionResult) -> Result<(), ValidationError> {
    if result.evidence_refs.is_empty() {
        return Err(ValidationError::MissingEvidence(
            result.criterion_id.clone(),
        ));
    }
    Ok(())
}

fn require_coverage(
    criterion: &RequiredCriterion,
    result: &CriterionResult,
) -> Result<(), ValidationError> {
    if result.covered_paths.is_empty() || result.semantic_surface_ids.is_empty() {
        return Err(ValidationError::MissingCoverage(
            result.criterion_id.clone(),
        ));
    }
    if !covers_paths(&result.covered_paths, &criterion.covered_paths)
        || !covers_ids(
            &result.semantic_surface_ids,
            &criterion.semantic_surface_ids,
        )
        || !covers_ids(&result.forward_edge_ids, &criterion.forward_edge_ids)
    {
        return Err(ValidationError::CoverageMismatch(
            result.criterion_id.clone(),
        ));
    }
    Ok(())
}

fn covers_paths(actual: &[CoveredPath], required: &[CoveredPath]) -> bool {
    required
        .iter()
        .all(|item| actual.iter().any(|seen| seen == item))
}

fn covers_ids(actual: &[Id], required: &[Id]) -> bool {
    required
        .iter()
        .all(|item| actual.iter().any(|seen| seen == item))
}

fn forward_finding_blockers(findings: &[Finding]) -> Vec<Id> {
    findings
        .iter()
        .filter(|finding| finding.effect == FindingEffect::ForwardBlocking)
        .flat_map(|finding| finding.criterion_ids.clone())
        .collect()
}

pub fn result(
    criterion_id: &str,
    verdict: CriterionVerdict,
    evidence: &str,
    path: &str,
    surface: &str,
    edge: &str,
) -> CriterionResult {
    CriterionResult {
        criterion_id: Id(criterion_id.to_owned()),
        verdict,
        evidence_refs: vec![Ref(evidence.to_owned())],
        finding_refs: Vec::new(),
        covered_paths: vec![CoveredPath(path.to_owned())],
        semantic_surface_ids: vec![Id(surface.to_owned())],
        forward_edge_ids: vec![Id(edge.to_owned())],
    }
}
