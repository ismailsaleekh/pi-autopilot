use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use crate::roles::kdl::{attr as kdl_attr, boundary_runtime as runtime_by_id, table_values};
use kernel::boundary::{BoundaryRuntime, Rejection};
use kernel::generated::{
    Id, PlanReview, PlanningAtomRegistry, PlanningAtomRegistryAtom, Questions, Ref, SchemaId,
    ScoutDossier, TaskAtoms, WorkMap,
};
use kernel_macros::acceptance_boundary;
use serde::{Deserialize, Serialize};
use sha2::{Digest as ShaDigest, Sha256};

pub const MODEL_BOUNDARIES: [&str; 5] = [
    "planning.task-atoms.v1",
    "planning.scout-dossier.v1",
    "planning.questions.v1",
    "planning.work-map.v1",
    "planning.plan-review.v1",
];
const DRIVER_TABLES_KDL: &str = include_str!("../../../data/driver-tables.kdl");
const PLANNING_KDL: &str = include_str!("../../../data/planning.kdl");

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
            scout_and_compiler_first_pass: 10,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningAssignmentRole {
    pub role: String,
    pub count: u8,
    pub mode: String,
    pub boundary_id: String,
    pub atom_namespace: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningWaveDeclaration {
    pub id: String,
    pub role: String,
    pub dependencies: Vec<String>,
    pub ordinals: Option<Vec<u8>>,
    pub activation_ref: Option<String>,
    pub canonical_output: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningPolicy {
    pub assignment_cap: u8,
    pub planning_wave_cap: usize,
    pub planning_max_attempts: u8,
    pub roles: Vec<PlanningAssignmentRole>,
    pub waves: Vec<PlanningWaveDeclaration>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningAgentAssignment {
    pub assignment_id: String,
    pub role: String,
    pub mode: String,
    pub boundary_id: Option<String>,
    pub ordinal: u8,
    pub atom_id_prefix: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningManifest {
    pub workstream: String,
    pub planning_wave_cap: usize,
    pub planning_max_attempts: u8,
    pub assignments: Vec<PlanningAgentAssignment>,
    pub waves: Vec<PlanningWaveDeclaration>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct PlanningIssuedRef {
    pub assignment_id: String,
    pub action_id: String,
    pub run_revision: u64,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct PlanningAcceptedRef {
    pub assignment_id: String,
    pub action_id: String,
    pub run_revision: u64,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct PlanningLaunchAckRef {
    pub assignment_id: String,
    pub action_id: String,
    pub run_revision: u64,
    pub task_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningActiveRef {
    pub assignment_id: String,
    pub action_id: String,
    pub run_revision: u64,
    pub launch_acknowledged: bool,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct PlanningTerminalFailureRef {
    pub assignment_id: String,
    pub action_id: String,
    pub run_revision: u64,
    pub status: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PlanningRefs {
    pub issued: Vec<PlanningIssuedRef>,
    pub launch_acks: BTreeSet<PlanningLaunchAckRef>,
    pub accepted: BTreeSet<PlanningAcceptedRef>,
    pub terminal_failures: BTreeSet<PlanningTerminalFailureRef>,
    pub activation_refs: BTreeSet<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningBarrierStatus {
    Complete,
    Running {
        active: Vec<PlanningActiveRef>,
        unissued: Vec<String>,
    },
    Blocked {
        failures: Vec<PlanningTerminalFailureRef>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningWaveBlocked {
    pub wave_id: String,
    pub failed_assignments: Vec<String>,
    pub attempts: BTreeMap<String, usize>,
    pub completed_assignments: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningWaveFailure {
    Blocked(PlanningWaveBlocked),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningWaveOutcome {
    Launch {
        wave_id: String,
        assignments: Vec<PlanningAgentAssignment>,
    },
    WaitingOnInFlight {
        wave_id: String,
        active: Vec<PlanningActiveRef>,
    },
    Complete,
    Blocked(PlanningWaveBlocked),
}

impl PlanningPolicy {
    pub fn parse(text: &str) -> Result<Self, PlanningError> {
        let declarations = PlanningDeclarations::parse(text)?;
        let roles = parse_planning_assignment_roles(text)?;
        let planning_wave_cap =
            parse_top_level_u8(text, "planning_wave_cap ", "default=")? as usize;
        if planning_wave_cap == 0 {
            return Err(PlanningError::BadDeclaration(
                "zero planning_wave_cap".to_owned(),
            ));
        }
        let planning_max_attempts = parse_top_level_u8(text, "planning_launch_attempts ", "max=")?;
        if planning_max_attempts == 0 {
            return Err(PlanningError::BadDeclaration(
                "zero planning_launch_attempts".to_owned(),
            ));
        }
        let waves = parse_planning_waves(text)?;
        validate_planning_waves(&roles, &waves)?;
        Ok(Self {
            assignment_cap: declarations.assignment_cap,
            planning_wave_cap,
            planning_max_attempts,
            roles,
            waves,
        })
    }

    pub fn assignments_for_workstream(
        &self,
        workstream: &str,
    ) -> Result<Vec<PlanningAgentAssignment>, PlanningError> {
        assignments_for_policy(workstream, self)
    }
}

impl PlanningManifest {
    pub fn from_policy(workstream: &str, policy: &PlanningPolicy) -> Result<Self, PlanningError> {
        Ok(Self {
            workstream: workstream.to_owned(),
            planning_wave_cap: policy.planning_wave_cap,
            planning_max_attempts: policy.planning_max_attempts,
            assignments: policy.assignments_for_workstream(workstream)?,
            waves: policy.waves.clone(),
        })
    }
}

pub fn planning_policy() -> Result<PlanningPolicy, PlanningError> {
    PlanningPolicy::parse(PLANNING_KDL)
}

pub fn planning_assignment_roles() -> Result<Vec<PlanningAssignmentRole>, PlanningError> {
    Ok(planning_policy()?.roles)
}

pub fn planning_assignments_for_workstream(
    workstream: &str,
) -> Result<Vec<PlanningAgentAssignment>, PlanningError> {
    planning_policy()?.assignments_for_workstream(workstream)
}

fn parse_planning_assignment_roles(
    text: &str,
) -> Result<Vec<PlanningAssignmentRole>, PlanningError> {
    let mut roles = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("assignment_role ") {
            continue;
        }
        let after = trimmed
            .strip_prefix("assignment_role \"")
            .ok_or_else(|| PlanningError::BadDeclaration(trimmed.to_owned()))?;
        let Some((role, attrs)) = after.split_once('"') else {
            return Err(PlanningError::BadDeclaration(trimmed.to_owned()));
        };
        let count = parse_attr(attrs, "count=")?
            .parse::<u8>()
            .map_err(|error| PlanningError::BadDeclaration(error.to_string()))?;
        if count == 0 {
            return Err(PlanningError::BadDeclaration(format!(
                "zero count for {role}"
            )));
        }
        roles.push(PlanningAssignmentRole {
            role: role.to_owned(),
            count,
            mode: parse_attr(attrs, "mode=")?,
            boundary_id: parse_attr(attrs, "boundary=")?,
            atom_namespace: kdl_attr(attrs, "atom_namespace="),
        });
    }
    if roles.is_empty() {
        return Err(PlanningError::BadDeclaration(
            "missing assignment_role rows".to_owned(),
        ));
    }
    Ok(roles)
}

fn parse_planning_waves(text: &str) -> Result<Vec<PlanningWaveDeclaration>, PlanningError> {
    let mut waves = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("planning_wave ") {
            continue;
        }
        let after = trimmed
            .strip_prefix("planning_wave \"")
            .ok_or_else(|| PlanningError::BadDeclaration(trimmed.to_owned()))?;
        let Some((id, attrs)) = after.split_once('"') else {
            return Err(PlanningError::BadDeclaration(trimmed.to_owned()));
        };
        let dependencies = kdl_attr(attrs, "depends=")
            .map(|value| split_csv(&value))
            .unwrap_or_default();
        let ordinals = kdl_attr(attrs, "ordinals=")
            .map(|value| parse_ordinals(&value))
            .transpose()?;
        let canonical_output = match kdl_attr(attrs, "canonical_output=").as_deref() {
            Some("#true") | Some("true") => true,
            Some("#false") | Some("false") | None => false,
            Some(value) => {
                return Err(PlanningError::BadDeclaration(format!(
                    "bad canonical_output for {id}: {value}"
                )));
            }
        };
        waves.push(PlanningWaveDeclaration {
            id: id.to_owned(),
            role: parse_attr(attrs, "role=")?,
            dependencies,
            ordinals,
            activation_ref: kdl_attr(attrs, "activation_ref="),
            canonical_output,
        });
    }
    if waves.is_empty() {
        return Err(PlanningError::BadDeclaration(
            "missing planning_wave rows".to_owned(),
        ));
    }
    Ok(waves)
}

fn validate_planning_waves(
    roles: &[PlanningAssignmentRole],
    waves: &[PlanningWaveDeclaration],
) -> Result<(), PlanningError> {
    let role_names = roles
        .iter()
        .map(|role| role.role.clone())
        .collect::<BTreeSet<_>>();
    let mut wave_names = BTreeSet::new();
    for wave in waves {
        if !role_names.contains(&wave.role) {
            return Err(PlanningError::BadDeclaration(format!(
                "wave {} references unknown role {}",
                wave.id, wave.role
            )));
        }
        if !wave_names.insert(wave.id.clone()) {
            return Err(PlanningError::BadDeclaration(format!(
                "duplicate planning_wave {}",
                wave.id
            )));
        }
    }
    for wave in waves {
        for dependency in &wave.dependencies {
            if dependency == &wave.id {
                return Err(PlanningError::BadDeclaration(format!(
                    "wave {} depends on itself",
                    wave.id
                )));
            }
            if !wave_names.contains(dependency) {
                return Err(PlanningError::BadDeclaration(format!(
                    "wave {} references unknown dependency {dependency}",
                    wave.id
                )));
            }
        }
    }
    validate_planning_wave_acyclic(waves)
}

fn validate_planning_wave_acyclic(waves: &[PlanningWaveDeclaration]) -> Result<(), PlanningError> {
    let dependencies_by_wave = waves
        .iter()
        .map(|wave| (wave.id.as_str(), wave.dependencies.as_slice()))
        .collect::<BTreeMap<_, _>>();
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let mut stack = Vec::new();
    for wave in waves {
        visit_planning_wave_dependency(
            wave.id.as_str(),
            &dependencies_by_wave,
            &mut visiting,
            &mut visited,
            &mut stack,
        )?;
    }
    Ok(())
}

fn visit_planning_wave_dependency<'a>(
    wave_id: &'a str,
    dependencies_by_wave: &BTreeMap<&'a str, &'a [String]>,
    visiting: &mut BTreeSet<&'a str>,
    visited: &mut BTreeSet<&'a str>,
    stack: &mut Vec<&'a str>,
) -> Result<(), PlanningError> {
    if visited.contains(wave_id) {
        return Ok(());
    }
    if visiting.contains(wave_id) {
        let cycle_start = stack
            .iter()
            .position(|stacked| *stacked == wave_id)
            .unwrap_or(0);
        let mut cycle = stack[cycle_start..].to_vec();
        cycle.push(wave_id);
        return Err(PlanningError::BadDeclaration(format!(
            "planning_wave dependency cycle: {}",
            cycle.join(" -> ")
        )));
    }
    visiting.insert(wave_id);
    stack.push(wave_id);
    let dependencies = dependencies_by_wave
        .get(wave_id)
        .expect("wave dependency map is built from validated wave ids");
    for dependency in *dependencies {
        visit_planning_wave_dependency(
            dependency.as_str(),
            dependencies_by_wave,
            visiting,
            visited,
            stack,
        )?;
    }
    stack.pop();
    visiting.remove(wave_id);
    visited.insert(wave_id);
    Ok(())
}

fn assignments_for_policy(
    workstream: &str,
    policy: &PlanningPolicy,
) -> Result<Vec<PlanningAgentAssignment>, PlanningError> {
    let mut by_role = BTreeMap::<String, Vec<PlanningAgentAssignment>>::new();
    for row in &policy.roles {
        let assignments = (1..=row.count)
            .map(|index| PlanningAgentAssignment {
                assignment_id: format!("planning-{workstream}-{}-{index:02}", row.role),
                role: row.role.clone(),
                mode: row.mode.clone(),
                boundary_id: Some(row.boundary_id.clone()),
                ordinal: index,
                atom_id_prefix: row
                    .atom_namespace
                    .as_ref()
                    .map(|namespace| format!("{namespace}{index:02}-")),
            })
            .collect::<Vec<_>>();
        by_role.insert(row.role.clone(), assignments);
    }
    let mut out = Vec::new();
    let mut emitted = BTreeSet::new();
    for wave in &policy.waves {
        let role_assignments = by_role
            .get(&wave.role)
            .ok_or_else(|| PlanningError::BadDeclaration(format!("missing role {}", wave.role)))?;
        for assignment in role_assignments
            .iter()
            .filter(|assignment| wave_includes_ordinal(wave, assignment.ordinal))
        {
            if !emitted.insert(assignment.assignment_id.clone()) {
                return Err(PlanningError::BadDeclaration(format!(
                    "assignment {} appears in multiple waves",
                    assignment.assignment_id
                )));
            }
            out.push(assignment.clone());
        }
    }
    let declared_total = policy
        .roles
        .iter()
        .map(|role| role.count as usize)
        .sum::<usize>();
    if out.len() != declared_total {
        return Err(PlanningError::BadDeclaration(format!(
            "planning waves cover {} assignments, roles declare {declared_total}",
            out.len()
        )));
    }
    if out.len() > policy.assignment_cap as usize {
        return Err(PlanningError::AssignmentCap {
            total: u8::try_from(out.len()).unwrap_or(u8::MAX),
            cap: policy.assignment_cap,
        });
    }
    Ok(out)
}

pub fn barrier_status(
    manifest: &PlanningManifest,
    wave: &PlanningWaveDeclaration,
    refs: &PlanningRefs,
) -> PlanningBarrierStatus {
    if wave_is_inactive(wave, refs) {
        return PlanningBarrierStatus::Complete;
    }
    let assignments = manifest
        .assignments
        .iter()
        .filter(|assignment| {
            assignment.role == wave.role && wave_includes_ordinal(wave, assignment.ordinal)
        })
        .collect::<Vec<_>>();
    let completed = assignments
        .iter()
        .filter(|assignment| assignment_is_accepted(&assignment.assignment_id, refs))
        .count();
    if completed == assignments.len() {
        return PlanningBarrierStatus::Complete;
    }
    let failures = assignments
        .iter()
        .flat_map(|assignment| assignment_failures(&assignment.assignment_id, refs))
        .collect::<Vec<_>>();
    if !failures.is_empty() {
        return PlanningBarrierStatus::Blocked { failures };
    }
    let active = assignments
        .iter()
        .flat_map(|assignment| active_refs_for_assignment(&assignment.assignment_id, refs))
        .collect::<Vec<_>>();
    let unissued = assignments
        .iter()
        .filter(|assignment| {
            !assignment_is_accepted(&assignment.assignment_id, refs)
                && !assignment_is_active(&assignment.assignment_id, refs)
                && assignment_failures(&assignment.assignment_id, refs).is_empty()
        })
        .map(|assignment| assignment.assignment_id.clone())
        .collect::<Vec<_>>();
    PlanningBarrierStatus::Running { active, unissued }
}

pub fn next_planning_wave(
    manifest: &PlanningManifest,
    refs: &PlanningRefs,
    cap: usize,
) -> PlanningWaveOutcome {
    let effective_cap = cap.min(manifest.planning_wave_cap);
    for wave in &manifest.waves {
        if !planning_wave_dependencies_complete(manifest, wave, refs) {
            continue;
        }
        let status = barrier_status(manifest, wave, refs);
        match status {
            PlanningBarrierStatus::Complete => continue,
            PlanningBarrierStatus::Blocked { failures } => {
                return PlanningWaveOutcome::Blocked(blocked_wave(manifest, wave, refs, failures));
            }
            PlanningBarrierStatus::Running { active, unissued } => {
                let open_slots = effective_cap.saturating_sub(active.len());
                let selected_ids = unissued
                    .into_iter()
                    .take(open_slots)
                    .collect::<BTreeSet<_>>();
                let selected = manifest
                    .assignments
                    .iter()
                    .filter(|assignment| selected_ids.contains(&assignment.assignment_id))
                    .cloned()
                    .collect::<Vec<_>>();
                if selected.is_empty() {
                    return PlanningWaveOutcome::WaitingOnInFlight {
                        wave_id: wave.id.clone(),
                        active,
                    };
                }
                return PlanningWaveOutcome::Launch {
                    wave_id: wave.id.clone(),
                    assignments: selected,
                };
            }
        }
    }
    PlanningWaveOutcome::Complete
}

fn planning_wave_dependencies_complete(
    manifest: &PlanningManifest,
    wave: &PlanningWaveDeclaration,
    refs: &PlanningRefs,
) -> bool {
    wave.dependencies.iter().all(|dependency| {
        manifest
            .waves
            .iter()
            .find(|candidate| candidate.id == *dependency)
            .is_some_and(|dependency_wave| {
                barrier_status(manifest, dependency_wave, refs) == PlanningBarrierStatus::Complete
            })
    })
}

fn blocked_wave(
    manifest: &PlanningManifest,
    wave: &PlanningWaveDeclaration,
    refs: &PlanningRefs,
    failures: Vec<PlanningTerminalFailureRef>,
) -> PlanningWaveBlocked {
    let failed_assignments = failures
        .iter()
        .map(|failure| failure.assignment_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let attempts = failed_assignments
        .iter()
        .map(|assignment_id| {
            (
                assignment_id.clone(),
                refs.issued
                    .iter()
                    .filter(|issued| issued.assignment_id == *assignment_id)
                    .count(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let completed_assignments = manifest
        .assignments
        .iter()
        .filter(|assignment| {
            assignment.role == wave.role && wave_includes_ordinal(wave, assignment.ordinal)
        })
        .filter(|assignment| assignment_is_accepted(&assignment.assignment_id, refs))
        .map(|assignment| assignment.assignment_id.clone())
        .collect::<Vec<_>>();
    PlanningWaveBlocked {
        wave_id: wave.id.clone(),
        failed_assignments,
        attempts,
        completed_assignments,
    }
}

fn assignment_is_accepted(assignment_id: &str, refs: &PlanningRefs) -> bool {
    refs.accepted.iter().any(|accepted| {
        accepted.assignment_id == assignment_id
            && refs.issued.iter().any(|issued| {
                issued.assignment_id == accepted.assignment_id
                    && issued.action_id == accepted.action_id
                    && issued.run_revision == accepted.run_revision
            })
    })
}

fn assignment_is_active(assignment_id: &str, refs: &PlanningRefs) -> bool {
    !active_refs_for_assignment(assignment_id, refs).is_empty()
}

fn active_refs_for_assignment(assignment_id: &str, refs: &PlanningRefs) -> Vec<PlanningActiveRef> {
    refs.issued
        .iter()
        .filter(|issued| {
            issued.assignment_id == assignment_id
                && !accepted_exact(issued, refs)
                && !terminal_failure_exact(issued, refs)
        })
        .map(|issued| PlanningActiveRef {
            assignment_id: issued.assignment_id.clone(),
            action_id: issued.action_id.clone(),
            run_revision: issued.run_revision,
            launch_acknowledged: launch_ack_task_id(issued, refs).is_some(),
        })
        .collect()
}

fn launch_ack_task_id(issued: &PlanningIssuedRef, refs: &PlanningRefs) -> Option<String> {
    refs.launch_acks
        .iter()
        .find(|ack| {
            ack.assignment_id == issued.assignment_id
                && ack.action_id == issued.action_id
                && ack.run_revision == issued.run_revision
        })
        .map(|ack| ack.task_id.clone())
}

fn assignment_failures(
    assignment_id: &str,
    refs: &PlanningRefs,
) -> Vec<PlanningTerminalFailureRef> {
    refs.terminal_failures
        .iter()
        .filter(|failure| failure.assignment_id == assignment_id)
        .filter(|failure| {
            refs.issued.iter().any(|issued| {
                issued.assignment_id == failure.assignment_id
                    && issued.action_id == failure.action_id
                    && issued.run_revision == failure.run_revision
            })
        })
        .filter(|failure| {
            !refs.accepted.iter().any(|accepted| {
                accepted.assignment_id == failure.assignment_id
                    && accepted.action_id == failure.action_id
                    && accepted.run_revision == failure.run_revision
            })
        })
        .cloned()
        .collect()
}

fn accepted_exact(issued: &PlanningIssuedRef, refs: &PlanningRefs) -> bool {
    refs.accepted.contains(&PlanningAcceptedRef {
        assignment_id: issued.assignment_id.clone(),
        action_id: issued.action_id.clone(),
        run_revision: issued.run_revision,
    })
}

fn terminal_failure_exact(issued: &PlanningIssuedRef, refs: &PlanningRefs) -> bool {
    refs.terminal_failures.iter().any(|failure| {
        failure.assignment_id == issued.assignment_id
            && failure.action_id == issued.action_id
            && failure.run_revision == issued.run_revision
    })
}

fn wave_is_inactive(wave: &PlanningWaveDeclaration, refs: &PlanningRefs) -> bool {
    wave.activation_ref
        .as_ref()
        .is_some_and(|activation_ref| !refs.activation_refs.contains(activation_ref))
}

fn wave_includes_ordinal(wave: &PlanningWaveDeclaration, ordinal: u8) -> bool {
    wave.ordinals
        .as_ref()
        .is_none_or(|ordinals| ordinals.contains(&ordinal))
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

#[acceptance_boundary(id = "planning.task-atoms.v1", producer = Producer::Model, visible = true, admits = "Task extractor output must use the exact runner-issued atom id prefix for every atoms[].id, name operator-task atoms with source anchors, and include no repository findings. Call autopilot_submit_atoms as the final action with atoms containing id, kind, text, and sources.", mode = BoundaryMode::Enforce)]
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
        let documents = input_set
            .authority_documents
            .iter()
            .chain(input_set.context_documents.iter())
            .collect::<Vec<_>>();
        let basename_counts = task_document_basename_counts(&documents);
        let mut anchors = BTreeSet::new();
        for document in documents {
            let section_anchors = task_document_section_anchors(&document.body);
            let mut selectors = BTreeSet::from([
                format!("{}/{}", document.digest, document.path),
                document.path.clone(),
            ]);
            if let Some(basename) = task_document_basename(&document.path)
                && basename_counts.get(&basename) == Some(&1)
            {
                selectors.insert(basename);
            }
            for selector in selectors {
                insert_task_document_anchor_forms(
                    &mut anchors,
                    &format!("task://{selector}"),
                    &section_anchors,
                );
                insert_task_document_anchor_forms(&mut anchors, &selector, &section_anchors);
            }
        }
        Self { anchors }
    }

    pub fn has(&self, source: &Ref) -> bool {
        self.anchors.contains(&source.0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TaskSectionAnchor {
    anchor: String,
    section_number: Option<String>,
}

fn task_document_basename_counts(documents: &[&TaskDocument]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for document in documents {
        if let Some(basename) = task_document_basename(&document.path) {
            *counts.entry(basename).or_insert(0) += 1;
        }
    }
    counts
}

fn task_document_basename(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

fn insert_task_document_anchor_forms(
    anchors: &mut BTreeSet<String>,
    base: &str,
    section_anchors: &[TaskSectionAnchor],
) {
    anchors.insert(base.to_owned());
    anchors.insert(format!("{base}#whole-file"));
    for section in section_anchors {
        anchors.insert(format!("{base}#{}", section.anchor));
        if let Some(number) = &section.section_number {
            anchors.insert(format!("{base} §{number}"));
            anchors.insert(format!("{base}#{} §{number}", section.anchor));
        }
    }
}

fn task_document_section_anchors(body: &str) -> Vec<TaskSectionAnchor> {
    let mut anchors = Vec::new();
    let mut heading_counts = BTreeMap::new();
    let mut active_explicit_anchors = BTreeSet::new();
    for line in body.lines() {
        if let Some(marker) = explicit_html_section_anchor(line) {
            match marker {
                ExplicitSectionAnchor::Start(anchor) => {
                    anchors.push(TaskSectionAnchor {
                        anchor: anchor.clone(),
                        section_number: None,
                    });
                    active_explicit_anchors.insert(anchor);
                }
                ExplicitSectionAnchor::End(anchor) => {
                    active_explicit_anchors.remove(&anchor);
                }
                ExplicitSectionAnchor::Point(anchor) => {
                    anchors.push(TaskSectionAnchor {
                        anchor,
                        section_number: None,
                    });
                }
            }
        }
        if let Some(title) = markdown_heading_title(line) {
            let section_number = heading_section_number(title);
            let slug = markdown_heading_slug(title);
            if !slug.is_empty() {
                let anchor = unique_heading_anchor(slug, &mut heading_counts);
                anchors.push(TaskSectionAnchor {
                    anchor,
                    section_number: section_number.clone(),
                });
            }
            if let Some(number) = section_number {
                for anchor in &active_explicit_anchors {
                    anchors.push(TaskSectionAnchor {
                        anchor: anchor.clone(),
                        section_number: Some(number.clone()),
                    });
                }
            }
        }
    }
    anchors
}

fn markdown_heading_title(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let marker_count = trimmed.chars().take_while(|ch| *ch == '#').count();
    if !(1..=6).contains(&marker_count) {
        return None;
    }
    let after_markers = &trimmed[marker_count..];
    if !after_markers.starts_with(char::is_whitespace) {
        return None;
    }
    Some(after_markers.trim().trim_end_matches('#').trim_end())
}

fn markdown_heading_slug(title: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for ch in title.chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(ch);
            pending_dash = false;
        } else if ch.is_whitespace() || ch == '-' {
            pending_dash = true;
        }
    }
    slug
}

fn unique_heading_anchor(slug: String, heading_counts: &mut BTreeMap<String, usize>) -> String {
    let count = heading_counts.entry(slug.clone()).or_insert(0);
    let anchor = if *count == 0 {
        slug.clone()
    } else {
        format!("{slug}-{count}")
    };
    *count += 1;
    anchor
}

fn heading_section_number(title: &str) -> Option<String> {
    let chars = title.trim_start().chars().collect::<Vec<_>>();
    if !chars.first().is_some_and(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let mut index = 0;
    let mut number = String::new();
    while index < chars.len() && chars[index].is_ascii_digit() {
        number.push(chars[index]);
        index += 1;
    }
    while index + 1 < chars.len() && chars[index] == '.' && chars[index + 1].is_ascii_digit() {
        number.push('.');
        index += 1;
        while index < chars.len() && chars[index].is_ascii_digit() {
            number.push(chars[index]);
            index += 1;
        }
    }
    if index < chars.len() && chars[index] == '.' {
        index += 1;
    }
    if index == chars.len()
        || chars[index].is_whitespace()
        || matches!(chars[index], '-' | ':' | ')')
    {
        Some(number)
    } else {
        None
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ExplicitSectionAnchor {
    Start(String),
    End(String),
    Point(String),
}

fn explicit_html_section_anchor(line: &str) -> Option<ExplicitSectionAnchor> {
    let trimmed = line.trim();
    let inner = trimmed.strip_prefix("<!--")?.strip_suffix("-->")?.trim();
    let (token, marker) = inner
        .split_once(':')
        .map_or((inner, None), |(before, after)| {
            (before.trim(), Some(after.trim()))
        });
    if token.is_empty()
        || !token
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return None;
    }
    match marker {
        Some("start") => Some(ExplicitSectionAnchor::Start(token.to_owned())),
        Some("end") => Some(ExplicitSectionAnchor::End(token.to_owned())),
        None => Some(ExplicitSectionAnchor::Point(token.to_owned())),
        Some(_) => None,
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

pub fn accept_task_atoms_for_assignment(
    raw: &str,
    runtime: &BoundaryRuntime,
    prefix: &str,
    anchors: &TaskAnchorRegistry,
) -> Result<String, Rejection> {
    let atoms = parse_model_payload::<TaskAtoms>(raw, runtime, "planning.task-atoms.v1")?;
    validate_task_atoms_shape(&atoms, runtime)?;
    validate_task_atom_assignment(&atoms, runtime, prefix, anchors)?;
    Ok(raw.to_owned())
}

pub fn validate_task_atoms_for_assignment(
    atoms: &TaskAtoms,
    prefix: &str,
    anchors: &TaskAnchorRegistry,
) -> Result<(), Rejection> {
    let runtime = boundary_runtime("planning.task-atoms.v1");
    validate_task_atoms_shape(atoms, &runtime)?;
    validate_task_atom_assignment(atoms, &runtime, prefix, anchors)
}

fn validate_task_atom_assignment(
    atoms: &TaskAtoms,
    runtime: &BoundaryRuntime,
    prefix: &str,
    anchors: &TaskAnchorRegistry,
) -> Result<(), Rejection> {
    if prefix.is_empty() {
        return reject_value(
            runtime,
            "planning.task-atoms.v1",
            "atoms.id",
            "non-empty runner-issued atom id prefix",
            "missing",
            "The runner must bind the assignment prefix before asking for atoms.",
        );
    }
    let mut seen = BTreeSet::new();
    let mut bad_prefix = Vec::new();
    let mut duplicates = Vec::new();
    for atom in &atoms.atoms {
        match atom.id.0.strip_prefix(prefix) {
            Some(local) if !local.is_empty() => {}
            _ => bad_prefix.push(atom.id.0.clone()),
        }
        if !seen.insert(atom.id.0.clone()) {
            duplicates.push(atom.id.0.clone());
        }
        for source in &atom.sources {
            if !anchors.has(source) {
                return reject_value(
                    runtime,
                    "planning.task-atoms.v1",
                    "atoms.sources",
                    "a real task-document anchor supplied by package authority",
                    &source.0,
                    "Use only task:// anchors from the task authority manifest.",
                );
            }
        }
    }
    if !bad_prefix.is_empty() {
        return reject_value(
            runtime,
            "planning.task-atoms.v1",
            "atoms.id",
            &format!("exact prefix {prefix} plus a non-empty local id"),
            &format!("offending ids {:?}", bad_prefix),
            "Keep the local suffix you intend, but emit it under the runner-issued prefix.",
        );
    }
    if !duplicates.is_empty() {
        return reject_value(
            runtime,
            "planning.task-atoms.v1",
            "atoms.id",
            &format!("unique full ids under expected prefix {prefix}"),
            &format!("duplicate ids {:?}", duplicates),
            "Emit each task atom id at most once in this submission.",
        );
    }
    Ok(())
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
    raw: &str,
    runtime: &BoundaryRuntime,
    atom_ids: &BTreeSet<Id>,
    registry_digest: &str,
) -> Result<String, Rejection> {
    let work_map = parse_model_payload::<WorkMap>(raw, runtime, "planning.work-map.v1")?;
    validate_work_map_shape(&work_map, runtime)?;
    validate_work_map_links(&work_map, runtime, atom_ids, registry_digest)?;
    Ok(raw.to_owned())
}

fn validate_work_map_links(
    work_map: &WorkMap,
    runtime: &BoundaryRuntime,
    atom_ids: &BTreeSet<Id>,
    registry_digest: &str,
) -> Result<(), Rejection> {
    let mut unknown = BTreeSet::new();
    for unit in &work_map.units {
        for link in &unit.links {
            if atom_ids.get(link).is_none() {
                unknown.insert(link.0.clone());
            }
        }
    }
    if !unknown.is_empty() {
        let allowed = atom_ids
            .iter()
            .map(|id| id.0.as_str())
            .collect::<Vec<_>>()
            .join(",");
        return reject_value(
            runtime,
            "planning.work-map.v1",
            "units.links",
            &format!("exact ids from atom registry {registry_digest}; allowed=[{allowed}]"),
            &format!("unknown ids {:?}", unknown),
            "Replace placeholders with ids from the bound atom registry.",
        );
    }
    Ok(())
}

pub fn atom_registry_bytes(
    workstream: &str,
    authority_set_id: &str,
    producer_assignment_ids: Vec<Id>,
    atoms: Vec<PlanningAtomRegistryAtom>,
) -> Result<Vec<u8>, PlanningError> {
    let registry = PlanningAtomRegistry {
        schema: SchemaId("autopilot.planning_atom_registry.v1".to_owned()),
        workstream: Id(workstream.to_owned()),
        authority_set_id: authority_set_id.to_owned(),
        producer_assignment_ids,
        atoms,
    };
    serde_json::to_vec_pretty(&registry)
        .map_err(|error| PlanningError::ContextGap(format!("atom registry json:{error}")))
}

pub fn load_atom_registry_ids(
    path: &Path,
    expected_digest: &str,
) -> Result<BTreeSet<Id>, PlanningError> {
    reject_link_components_for_absolute(path)
        .map_err(|error| PlanningError::ContextGap(format!("atom-registry-path:{error}")))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| PlanningError::ContextGap(format!("atom-registry-metadata:{error}")))?;
    if !metadata.file_type().is_file() {
        return Err(PlanningError::ContextGap(
            "atom-registry-not-regular-file".to_owned(),
        ));
    }
    let mut file = fs::File::open(path)
        .map_err(|error| PlanningError::ContextGap(format!("atom-registry-open:{error}")))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| PlanningError::ContextGap(format!("atom-registry-read:{error}")))?;
    let actual = sha256_hex(&bytes);
    if actual != expected_digest {
        return Err(PlanningError::ContextGap(format!(
            "atom-registry-digest:expected={expected_digest}:got={actual}"
        )));
    }
    let registry: PlanningAtomRegistry = serde_json::from_slice(&bytes)
        .map_err(|error| PlanningError::ContextGap(format!("atom-registry-json:{error}")))?;
    let mut ids = BTreeSet::new();
    for atom in registry.atoms {
        if !ids.insert(atom.id.clone()) {
            return Err(PlanningError::ContextGap(format!(
                "atom-registry-duplicate:{}",
                atom.id.0
            )));
        }
    }
    Ok(ids)
}

pub fn sorted_registry_atoms(
    records: Vec<(usize, usize, Id, TaskAtoms)>,
) -> Result<Vec<PlanningAtomRegistryAtom>, PlanningError> {
    let mut keyed = Vec::new();
    let mut global = BTreeMap::new();
    for (assignment_order, carrier_order, producer_assignment_id, atoms) in records {
        for (atom_order, atom) in atoms.atoms.into_iter().enumerate() {
            if let Some(previous) =
                global.insert(atom.id.0.clone(), producer_assignment_id.0.clone())
            {
                return Err(PlanningError::ContextGap(format!(
                    "atom-registry-duplicate:{}:{}:{}",
                    atom.id.0, previous, producer_assignment_id.0
                )));
            }
            keyed.push((
                assignment_order,
                carrier_order,
                atom_order,
                PlanningAtomRegistryAtom {
                    id: atom.id,
                    producer_assignment_id: producer_assignment_id.clone(),
                    kind: atom.kind,
                    text: atom.text,
                    sources: atom.sources,
                },
            ));
        }
    }
    keyed.sort_by(|left, right| {
        (left.0, left.1, left.2, &left.3.id.0).cmp(&(right.0, right.1, right.2, &right.3.id.0))
    });
    Ok(keyed.into_iter().map(|(_, _, _, atom)| atom).collect())
}

fn reject_link_components_for_absolute(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("path is not absolute: {}", path.display()));
    }
    let mut probe = PathBuf::new();
    for component in path.components() {
        probe.push(component.as_os_str());
        match fs::symlink_metadata(&probe) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!("symlink component: {}", probe.display()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("inspect {}: {error}", probe.display())),
        }
    }
    Ok(())
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
fn parse_top_level_u8(text: &str, prefix: &str, attr_name: &str) -> Result<u8, PlanningError> {
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(attrs) = trimmed.strip_prefix(prefix) {
            return parse_attr(attrs, attr_name)?
                .parse::<u8>()
                .map_err(|error| PlanningError::BadDeclaration(error.to_string()));
        }
    }
    Err(PlanningError::BadDeclaration(format!(
        "missing {}",
        prefix.trim()
    )))
}
fn parse_ordinals(raw: &str) -> Result<Vec<u8>, PlanningError> {
    let ordinals = split_csv(raw)
        .into_iter()
        .map(|value| {
            value
                .parse::<u8>()
                .map_err(|error| PlanningError::BadDeclaration(error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if ordinals.is_empty() {
        return Err(PlanningError::BadDeclaration("empty ordinals".to_owned()));
    }
    Ok(ordinals)
}
fn split_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}
fn parse_attr(attrs: &str, name: &str) -> Result<String, PlanningError> {
    kdl_attr(attrs, name).ok_or_else(|| PlanningError::BadDeclaration(name.to_owned()))
}
