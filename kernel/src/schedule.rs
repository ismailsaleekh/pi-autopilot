use core::cmp::Ordering;

pub const DEFAULT_PARALLEL_CAP: usize = 8;

const GIB: u64 = 1024 * 1024 * 1024;
const STORAGE_FLOOR_BYTES: u64 = 5 * GIB;
const MEMORY_FLOOR_BYTES: u64 = 2 * GIB;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct WorkItemId(pub String);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapacityClass(pub String);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PressurePolicy {
    DelayWhenPressed,
    PermitWhenPressed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReadinessFacts {
    pub predecessor_gates_met: bool,
    pub blockers_clear: bool,
    pub unit_free: bool,
    pub base_ready: bool,
    pub route_ready: bool,
    pub preflight_passed: bool,
}

impl ReadinessFacts {
    pub fn all_met(&self) -> bool {
        self.predecessor_gates_met
            && self.blockers_clear
            && self.unit_free
            && self.base_ready
            && self.route_ready
            && self.preflight_passed
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResourceFacts {
    pub free_storage_bytes: u64,
    pub projected_storage_bytes: u64,
    pub available_memory_bytes: u64,
    pub physical_memory_bytes: u64,
}

impl ResourceFacts {
    pub fn pressed(&self) -> bool {
        self.free_storage_bytes < storage_floor(self.projected_storage_bytes)
            || self.available_memory_bytes < memory_floor(self.physical_memory_bytes)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkItem {
    pub id: WorkItemId,
    pub capacity_class: CapacityClass,
    pub launch_wave: u32,
    pub remaining_dependency_path: u32,
    pub unit_order: u32,
    pub readiness: ReadinessFacts,
    pub pressure_policy: PressurePolicy,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchedulePolicy {
    pub parallel_cap: usize,
    pub capped_class: CapacityClass,
}

impl SchedulePolicy {
    pub fn with_default_cap(capped_class: CapacityClass) -> Self {
        Self {
            parallel_cap: DEFAULT_PARALLEL_CAP,
            capped_class,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduleView {
    pub policy: SchedulePolicy,
    pub active_capped: usize,
    pub resources: ResourceFacts,
    pub items: Vec<WorkItem>,
}

pub fn dispatch_order(view: &ScheduleView) -> Vec<WorkItemId> {
    let mut ordered: Vec<&WorkItem> = view
        .items
        .iter()
        .filter(|item| item.readiness.all_met())
        .filter(|item| resources_allow(item.pressure_policy, &view.resources))
        .collect();

    ordered.sort_by(compare_items);

    let mut capped_open = view.policy.parallel_cap.saturating_sub(view.active_capped);
    let mut selected = Vec::new();

    for item in ordered {
        if item.capacity_class == view.policy.capped_class {
            if capped_open == 0 {
                continue;
            }
            capped_open -= 1;
        }
        selected.push(item.id.clone());
    }

    selected
}

fn compare_items(left: &&WorkItem, right: &&WorkItem) -> Ordering {
    left.launch_wave
        .cmp(&right.launch_wave)
        .then_with(|| {
            right
                .remaining_dependency_path
                .cmp(&left.remaining_dependency_path)
        })
        .then_with(|| left.unit_order.cmp(&right.unit_order))
        .then_with(|| left.id.cmp(&right.id))
}

fn resources_allow(policy: PressurePolicy, resources: &ResourceFacts) -> bool {
    match policy {
        PressurePolicy::DelayWhenPressed => !resources.pressed(),
        PressurePolicy::PermitWhenPressed => true,
    }
}

fn storage_floor(projected_storage_bytes: u64) -> u64 {
    STORAGE_FLOOR_BYTES.max(projected_storage_bytes.saturating_mul(2))
}

fn memory_floor(physical_memory_bytes: u64) -> u64 {
    MEMORY_FLOOR_BYTES.max(physical_memory_bytes / 10)
}
