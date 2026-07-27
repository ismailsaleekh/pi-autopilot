use std::path::{Path, PathBuf};

use kernel::failure::Failure;
use kernel::generated::Id;
use kernel::schedule::{
    CapacityClass, PressurePolicy, ReadinessFacts, ResourceFacts, SchedulePolicy, ScheduleView,
    WorkItem, WorkItemId, dispatch_order,
};

use crate::allocation::CanonicalLane;
use crate::vcs::GitVcs;

const IMPLEMENTER_CAPACITY: &str = "implementer";
// The kernel owns the tie-break and parallel_cap selection; dispatch supplies launch_wave facts.

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct LaneReadiness {
    pub lane_id: Id,
    pub predecessor_gates_met: bool,
    pub blockers_clear: bool,
    pub unit_free: bool,
    pub route_ready: bool,
    pub preflight_passed: bool,
    pub pressure_delay: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DispatchInput {
    pub lanes: Vec<CanonicalLane>,
    pub readiness: Vec<LaneReadiness>,
    pub active_implementers: usize,
    pub parallel_cap: usize,
    pub resources: ResourceFacts,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct LaneLaunch {
    pub lane_id: Id,
    pub base_commit: String,
    pub worktree: PathBuf,
}

pub fn select_ready_lanes(input: &DispatchInput) -> Vec<Id> {
    let readiness = input
        .readiness
        .iter()
        .map(|item| (item.lane_id.0.as_str(), item))
        .collect::<std::collections::BTreeMap<_, _>>();
    let items = input
        .lanes
        .iter()
        .filter_map(|lane| {
            readiness
                .get(lane.proposal.lane_id.0.as_str())
                .map(|facts| (lane, *facts))
        })
        .map(|(lane, facts)| WorkItem {
            id: WorkItemId(lane.proposal.lane_id.0.clone()),
            capacity_class: CapacityClass(lane.capacity_class.clone()),
            launch_wave: lane.proposal.launch_wave,
            remaining_dependency_path: lane.remaining_dependency_path,
            unit_order: lane.first_operator_order,
            readiness: ReadinessFacts {
                predecessor_gates_met: facts.predecessor_gates_met,
                blockers_clear: facts.blockers_clear,
                unit_free: facts.unit_free,
                base_ready: true,
                route_ready: facts.route_ready,
                preflight_passed: facts.preflight_passed,
            },
            pressure_policy: if facts.pressure_delay {
                PressurePolicy::DelayWhenPressed
            } else {
                PressurePolicy::PermitWhenPressed
            },
        })
        .collect();
    let view = ScheduleView {
        policy: SchedulePolicy {
            parallel_cap: input.parallel_cap,
            capped_class: CapacityClass(IMPLEMENTER_CAPACITY.to_owned()),
        },
        active_capped: input.active_implementers,
        resources: input.resources,
        items,
    };
    dispatch_order(&view)
        .into_iter()
        .map(|id| Id(id.0))
        .collect()
}

pub fn launch_lanes(
    vcs: &GitVcs,
    source: &Path,
    worktree_root: &Path,
    run_main_ref: &str,
    selected: &[Id],
    sparse_profile: &[&str],
) -> Result<Vec<LaneLaunch>, Failure> {
    let mut launches = Vec::new();
    for lane in selected {
        let base_commit = vcs.read_tip(source, run_main_ref)?;
        let worktree = worktree_root.join(&lane.0);
        vcs.prepare(&worktree, source, &base_commit, sparse_profile)?;
        launches.push(LaneLaunch {
            lane_id: lane.clone(),
            base_commit,
            worktree,
        });
    }
    Ok(launches)
}
