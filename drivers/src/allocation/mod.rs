use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

use kernel::boundary::Rejection;
use kernel::generated::{
    AllocationLaneProposal, Id, Path as ContractPath, PlanUnitCommand, PlanUnitKind,
};
use kernel_macros::acceptance_boundary;
use serde::{Deserialize, Serialize};

use crate::roles::kdl::boundary_runtime;

pub const BOUNDARY_ID: &str = "allocation.lane-proposal.v1";
const IMPLEMENTER_CAPACITY: &str = "implementer";

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
pub struct ApprovedUnit {
    pub id: Id,
    pub kind: PlanUnitKind,
    pub objective: String,
    pub operator_order: u32,
    pub decisions: Vec<Id>,
    pub criteria: Vec<Id>,
    pub criterion_text: Vec<ApprovedCriterion>,
    pub dependencies: Vec<Id>,
    pub predecessor_forward_criteria: Vec<Id>,
    pub downstream_release_edges: Vec<Id>,
    pub files: Vec<ContractPath>,
    pub commands: Vec<PlanUnitCommand>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
pub struct ApprovedCriterion {
    pub id: Id,
    pub text: String,
}

pub fn approved_path_is_safe(path: &kernel::generated::Path) -> bool {
    !path.0.trim().is_empty()
        && !path.0.contains('\\')
        && !Path::new(&path.0).is_absolute()
        && Path::new(&path.0)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct FutureUnit {
    pub unit_id: Id,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
pub struct AllocationSubmission {
    pub lanes: Vec<AllocationLaneProposal>,
    pub future_units: Vec<FutureUnit>,
    pub authority_echo: Vec<ApprovedUnit>,
    pub ownership_claims: Vec<String>,
    pub overlap_blocks: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct AllocationPolicy {
    pub parallel_cap: usize,
    pub active_implementers: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalLane {
    pub proposal: AllocationLaneProposal,
    pub remaining_dependency_path: u32,
    pub first_operator_order: u32,
    pub capacity_class: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalAllocation {
    pub lanes: Vec<CanonicalLane>,
    pub future_units: Vec<FutureUnit>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum AllocationError {
    WrongLaneCount { actual: usize },
    MissingUnit(Id),
    DuplicateUnit(Id),
    UnknownUnit(Id),
    FutureWithoutReason(Id),
    AuthorityChanged(Id),
    PredecessorGateChanged(Id),
    DownstreamEdgeChanged(Id),
    UnitOrderCreatesCycle(Id),
    LaneCycle(String),
    ParallelCapExceeded,
    ConcurrentUnit(Id),
    InventedOwnership(String),
}

#[acceptance_boundary(
    id = "allocation.lane-proposal.v1",
    producer = Producer::Model,
    visible = true,
    admits = "Return a lane proposal that groups only approved plan units. Preserve every unit id, dependency, predecessor forward criterion, downstream release edge, and verification obligation exactly as supplied. Do not invent file ownership or modify plan authority. Include ordered unit ids, one delivery boundary, context family id and estimate, focused tests, and launch wave.",
    mode = BoundaryMode::Enforce
)]
pub fn accept_lane_proposal(raw: &str) -> Result<AllocationLaneProposal, Rejection> {
    match serde_json::from_str::<AllocationLaneProposal>(raw) {
        Ok(proposal) => Ok(proposal),
        Err(error) => reject_parse_error(format!("json:{error}")),
    }
}

fn reject_parse_error(actual: String) -> Result<AllocationLaneProposal, Rejection> {
    let mut runtime = boundary_runtime(BOUNDARY_ID);
    runtime.flip_to_enforce();
    loop {
        runtime.reject(actual.clone())?;
        runtime.flip_to_enforce();
    }
}

pub fn validate_allocation(
    approved: &[ApprovedUnit],
    submission: &AllocationSubmission,
    policy: AllocationPolicy,
) -> Result<CanonicalAllocation, AllocationError> {
    reject_ownership(submission)?;
    if !(1..=6).contains(&submission.lanes.len()) {
        return Err(AllocationError::WrongLaneCount {
            actual: submission.lanes.len(),
        });
    }
    compare_authority(approved, &submission.authority_echo)?;
    let approved_by_id = by_id(approved);
    let lane_by_unit = assignment_map(&submission.lanes, &approved_by_id)?;
    validate_future_units(&approved_by_id, &lane_by_unit, &submission.future_units)?;
    validate_lane_content(&submission.lanes, &approved_by_id)?;
    validate_capacity(&submission.lanes, policy)?;
    validate_ordering(&submission.lanes, &approved_by_id, &lane_by_unit)?;
    let lanes = submission
        .lanes
        .iter()
        .map(|proposal| canonical_lane(proposal, &approved_by_id))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CanonicalAllocation {
        lanes,
        future_units: submission.future_units.clone(),
    })
}

fn reject_ownership(submission: &AllocationSubmission) -> Result<(), AllocationError> {
    if let Some(claim) = submission.ownership_claims.first() {
        return Err(AllocationError::InventedOwnership(claim.clone()));
    }
    if let Some(block) = submission.overlap_blocks.first() {
        return Err(AllocationError::InventedOwnership(block.clone()));
    }
    Ok(())
}

fn compare_authority(
    approved: &[ApprovedUnit],
    echo: &[ApprovedUnit],
) -> Result<(), AllocationError> {
    if approved.len() != echo.len() {
        return Err(AllocationError::AuthorityChanged(Id("unit-set".to_owned())));
    }
    let actual = by_id(echo);
    for unit in approved {
        match actual.get(&unit.id) {
            Some(echoed) if *echoed == unit => {}
            _ => return Err(AllocationError::AuthorityChanged(unit.id.clone())),
        }
    }
    Ok(())
}

fn assignment_map<'a>(
    lanes: &'a [AllocationLaneProposal],
    approved: &BTreeMap<Id, &'a ApprovedUnit>,
) -> Result<BTreeMap<Id, (String, usize)>, AllocationError> {
    let mut seen = BTreeMap::new();
    let mut active = BTreeSet::new();
    for lane in lanes {
        for (index, unit_id) in lane.ordered_unit_ids.iter().enumerate() {
            if !approved.contains_key(unit_id) {
                return Err(AllocationError::UnknownUnit(unit_id.clone()));
            }
            if seen
                .insert(unit_id.clone(), (lane.lane_id.0.clone(), index))
                .is_some()
            {
                return Err(AllocationError::DuplicateUnit(unit_id.clone()));
            }
            if !active.insert(unit_id.clone()) {
                return Err(AllocationError::ConcurrentUnit(unit_id.clone()));
            }
        }
    }
    Ok(seen)
}

fn validate_future_units(
    approved: &BTreeMap<Id, &ApprovedUnit>,
    assigned: &BTreeMap<Id, (String, usize)>,
    future: &[FutureUnit],
) -> Result<(), AllocationError> {
    let mut future_ids = BTreeSet::new();
    for item in future {
        if item.reason.trim().is_empty() {
            return Err(AllocationError::FutureWithoutReason(item.unit_id.clone()));
        }
        if !approved.contains_key(&item.unit_id) {
            return Err(AllocationError::UnknownUnit(item.unit_id.clone()));
        }
        if assigned.contains_key(&item.unit_id) || !future_ids.insert(item.unit_id.clone()) {
            return Err(AllocationError::DuplicateUnit(item.unit_id.clone()));
        }
    }
    for id in approved.keys() {
        if !assigned.contains_key(id) && !future_ids.contains(id) {
            return Err(AllocationError::MissingUnit(id.clone()));
        }
    }
    Ok(())
}

fn validate_lane_content(
    lanes: &[AllocationLaneProposal],
    approved: &BTreeMap<Id, &ApprovedUnit>,
) -> Result<(), AllocationError> {
    for lane in lanes {
        let mut expected_gates = BTreeSet::new();
        let mut expected_edges = BTreeSet::new();
        for id in &lane.ordered_unit_ids {
            let unit = unit(approved, id)?;
            expected_gates.extend(unit.predecessor_forward_criteria.iter().cloned());
            expected_edges.extend(unit.downstream_release_edges.iter().cloned());
        }
        if set(&lane.predecessor_forward_criteria) != expected_gates {
            return Err(AllocationError::PredecessorGateChanged(
                lane.lane_id.clone(),
            ));
        }
        if set(&lane.downstream_release_edges) != expected_edges {
            return Err(AllocationError::DownstreamEdgeChanged(lane.lane_id.clone()));
        }
    }
    Ok(())
}

fn validate_capacity(
    lanes: &[AllocationLaneProposal],
    policy: AllocationPolicy,
) -> Result<(), AllocationError> {
    let new_lanes = lanes
        .iter()
        .filter(|lane| lane.continue_existing_logical_lane != Some(true))
        .count();
    if policy.active_implementers.saturating_add(new_lanes) > policy.parallel_cap {
        Err(AllocationError::ParallelCapExceeded)
    } else {
        Ok(())
    }
}

fn validate_ordering(
    lanes: &[AllocationLaneProposal],
    approved: &BTreeMap<Id, &ApprovedUnit>,
    assigned: &BTreeMap<Id, (String, usize)>,
) -> Result<(), AllocationError> {
    let wave_by_lane = lanes
        .iter()
        .map(|lane| (lane.lane_id.0.clone(), lane.launch_wave))
        .collect::<BTreeMap<_, _>>();
    let mut graph: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (id, (lane_id, index)) in assigned {
        let current = unit(approved, id)?;
        for dep in &current.dependencies {
            if let Some((dep_lane, dep_index)) = assigned.get(dep) {
                if dep_lane == lane_id && dep_index >= index {
                    return Err(AllocationError::UnitOrderCreatesCycle(id.clone()));
                }
                if dep_lane != lane_id {
                    let dep_wave = required_wave(&wave_by_lane, dep_lane)?;
                    let lane_wave = required_wave(&wave_by_lane, lane_id)?;
                    if dep_wave > lane_wave {
                        return Err(AllocationError::LaneCycle(lane_id.clone()));
                    }
                    graph
                        .entry(dep_lane.clone())
                        .or_default()
                        .insert(lane_id.clone());
                }
            }
        }
    }
    reject_cycle(&graph)
}

fn reject_cycle(graph: &BTreeMap<String, BTreeSet<String>>) -> Result<(), AllocationError> {
    let mut visiting = BTreeSet::new();
    let mut done = BTreeSet::new();
    for node in graph.keys() {
        visit(node, graph, &mut visiting, &mut done)?;
    }
    Ok(())
}

fn visit(
    node: &str,
    graph: &BTreeMap<String, BTreeSet<String>>,
    visiting: &mut BTreeSet<String>,
    done: &mut BTreeSet<String>,
) -> Result<(), AllocationError> {
    if done.contains(node) {
        return Ok(());
    }
    if !visiting.insert(node.to_owned()) {
        return Err(AllocationError::LaneCycle(node.to_owned()));
    }
    if let Some(next) = graph.get(node) {
        for child in next {
            visit(child, graph, visiting, done)?;
        }
    }
    visiting.remove(node);
    done.insert(node.to_owned());
    Ok(())
}

fn canonical_lane(
    proposal: &AllocationLaneProposal,
    approved: &BTreeMap<Id, &ApprovedUnit>,
) -> Result<CanonicalLane, AllocationError> {
    let first_operator_order = proposal
        .ordered_unit_ids
        .iter()
        .map(|id| unit(approved, id).map(|unit| unit.operator_order))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .min()
        .ok_or_else(|| AllocationError::MissingUnit(proposal.lane_id.clone()))?;
    let remaining_dependency_path = proposal
        .ordered_unit_ids
        .iter()
        .map(|id| dependency_depth(id, approved))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .max();
    let remaining_dependency_path = match remaining_dependency_path {
        Some(value) => value,
        None => return Err(AllocationError::MissingUnit(proposal.lane_id.clone())),
    };
    Ok(CanonicalLane {
        proposal: proposal.clone(),
        remaining_dependency_path,
        first_operator_order,
        capacity_class: IMPLEMENTER_CAPACITY.to_owned(),
    })
}

fn dependency_depth(
    id: &Id,
    approved: &BTreeMap<Id, &ApprovedUnit>,
) -> Result<u32, AllocationError> {
    let unit = unit(approved, id)?;
    let mut best = 0u32;
    for dep in &unit.dependencies {
        best = best.max(dependency_depth(dep, approved)?.saturating_add(1));
    }
    Ok(best)
}

fn required_wave(waves: &BTreeMap<String, u32>, lane: &str) -> Result<u32, AllocationError> {
    match waves.get(lane) {
        Some(wave) => Ok(*wave),
        None => Err(AllocationError::LaneCycle(lane.to_owned())),
    }
}

fn unit<'a>(
    approved: &'a BTreeMap<Id, &ApprovedUnit>,
    id: &Id,
) -> Result<&'a ApprovedUnit, AllocationError> {
    approved
        .get(id)
        .copied()
        .ok_or_else(|| AllocationError::UnknownUnit(id.clone()))
}

fn by_id(units: &[ApprovedUnit]) -> BTreeMap<Id, &ApprovedUnit> {
    units.iter().map(|unit| (unit.id.clone(), unit)).collect()
}

fn set(ids: &[Id]) -> BTreeSet<Id> {
    ids.iter().cloned().collect()
}
