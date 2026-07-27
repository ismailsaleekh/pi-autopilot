use std::collections::{BTreeMap, BTreeSet};

use kernel::failure::{Failure, OperatorDecision, RecoveryRoute};

pub const CLOSURE_KDL: &str = include_str!("../../../data/closure.kdl");

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Criterion {
    pub id: String,
    pub paths: Vec<String>,
    pub surfaces: Vec<String>,
    pub witness_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CriterionObservation {
    pub criterion_id: String,
    pub verdict: Verdict,
    pub findings: Vec<MaterialFinding>,
    pub evidence_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Verdict {
    Pass,
    Fail,
    Blocked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FindingEffect {
    ForwardBlocking,
    ClosureBlocking,
    Advisory,
}

impl FindingEffect {
    pub const fn material(self) -> bool {
        matches!(self, Self::ForwardBlocking | Self::ClosureBlocking)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialFinding {
    pub normalized: String,
    pub effect: FindingEffect,
    pub evidence_marker: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FindingLedgerEntry {
    pub criterion_id: String,
    pub finding: MaterialFinding,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeepValidationBundle {
    pub snapshot_commit: String,
    pub criteria: Vec<CriterionObservation>,
    pub ledger: Vec<FindingLedgerEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClosureError {
    MissingCriterion(String),
    DuplicateCriterion(String),
    BadPolicy(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RepairPolicy {
    pub max_attempts: u8,
    pub tier2_after_survivals: u8,
}

impl RepairPolicy {
    pub fn package() -> Result<Self, ClosureError> {
        for line in CLOSURE_KDL.lines().map(str::trim) {
            if let Some(rest) = line.strip_prefix("repair_budget ") {
                if !rest.contains("\"post-release-closure\"") {
                    continue;
                }
                return Ok(Self {
                    max_attempts: attr_u8(rest, "max_attempts=")?,
                    tier2_after_survivals: attr_u8(rest, "tier2_after_survivals=")?,
                });
            }
        }
        Err(ClosureError::BadPolicy("missing repair budget".to_owned()))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepairLedger {
    policy: RepairPolicy,
    rounds: u8,
    survivors: BTreeMap<String, Survival>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Survival {
    count: u8,
    marker: String,
}

impl RepairLedger {
    pub fn new(policy: RepairPolicy) -> Self {
        Self {
            policy,
            rounds: 0,
            survivors: BTreeMap::new(),
        }
    }

    pub fn record_fix_attempt(&mut self, bundle: &DeepValidationBundle) -> RepairRouting {
        let material = bundle.material_findings();
        if material.is_empty() {
            return RepairRouting::Closed;
        }
        if self.rounds >= self.policy.max_attempts {
            return RepairRouting::Failure(Failure::Paused {
                needs: OperatorDecision::ChooseAfterExhaustion,
            });
        }
        self.rounds += 1;
        for finding in material {
            let key = finding.normalized.clone();
            let next_count = match self.survivors.get(&key) {
                Some(prior) if prior.marker == finding.evidence_marker => prior.count + 1,
                Some(prior) => prior.count + 1,
                None => 1,
            };
            self.survivors.insert(
                key.clone(),
                Survival {
                    count: next_count,
                    marker: finding.evidence_marker.clone(),
                },
            );
            if next_count >= self.policy.tier2_after_survivals {
                return RepairRouting::Failure(Failure::Recoverable {
                    route: RecoveryRoute::Tier2,
                });
            }
        }
        RepairRouting::Continue
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RepairRouting {
    Continue,
    Closed,
    Failure(Failure),
}

impl DeepValidationBundle {
    pub fn build(
        snapshot_commit: impl Into<String>,
        criteria: &[Criterion],
        observations: Vec<CriterionObservation>,
    ) -> Result<Self, ClosureError> {
        let mut expected = BTreeSet::new();
        for criterion in criteria {
            if !expected.insert(criterion.id.clone()) {
                return Err(ClosureError::DuplicateCriterion(criterion.id.clone()));
            }
        }
        let mut seen = BTreeSet::new();
        let mut ledger = Vec::new();
        for observation in &observations {
            if !expected.contains(&observation.criterion_id) {
                return Err(ClosureError::MissingCriterion(observation.criterion_id.clone()));
            }
            seen.insert(observation.criterion_id.clone());
            for finding in &observation.findings {
                ledger.push(FindingLedgerEntry {
                    criterion_id: observation.criterion_id.clone(),
                    finding: finding.clone(),
                });
            }
        }
        if let Some(criterion_id) = expected.difference(&seen).next() {
            return Err(ClosureError::MissingCriterion(criterion_id.clone()));
        }
        Ok(Self {
            snapshot_commit: snapshot_commit.into(),
            criteria: observations,
            ledger,
        })
    }

    pub fn material_findings(&self) -> Vec<&MaterialFinding> {
        self.ledger
            .iter()
            .filter_map(|entry| entry.finding.effect.material().then_some(&entry.finding))
            .collect()
    }
}

pub fn criteria_for_delta(
    criteria: &[Criterion],
    changed_paths: &[String],
    changed_surfaces: &[String],
    stale_ids: &[String],
) -> Vec<String> {
    let stale: BTreeSet<&str> = stale_ids.iter().map(String::as_str).collect();
    criteria
        .iter()
        .filter(|criterion| {
            stale.contains(criterion.id.as_str())
                || intersects(&criterion.paths, changed_paths)
                || intersects(&criterion.surfaces, changed_surfaces)
        })
        .map(|criterion| criterion.id.clone())
        .collect()
}

fn intersects(left: &[String], right: &[String]) -> bool {
    left.iter().any(|item| right.iter().any(|other| item == other))
}

fn attr_u8(text: &str, key: &str) -> Result<u8, ClosureError> {
    let Some(raw) = text
        .split_whitespace()
        .find_map(|part| part.strip_prefix(key))
    else {
        return Err(ClosureError::BadPolicy(key.to_owned()));
    };
    raw.parse::<u8>()
        .map_err(|_error| ClosureError::BadPolicy(key.to_owned()))
}
