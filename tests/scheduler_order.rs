use kernel::schedule::{
    CapacityClass, PressurePolicy, ReadinessFacts, ResourceFacts, SchedulePolicy, ScheduleView,
    WorkItem, WorkItemId, dispatch_order,
};

const GIB: u64 = 1024 * 1024 * 1024;

fn ready() -> ReadinessFacts {
    ReadinessFacts {
        predecessor_gates_met: true,
        blockers_clear: true,
        unit_free: true,
        base_ready: true,
        route_ready: true,
        preflight_passed: true,
    }
}

fn resources() -> ResourceFacts {
    ResourceFacts {
        free_storage_bytes: 100 * GIB,
        projected_storage_bytes: GIB,
        available_memory_bytes: 100 * GIB,
        physical_memory_bytes: 100 * GIB,
    }
}

fn class(name: &str) -> CapacityClass {
    CapacityClass(name.to_owned())
}

fn item(id: &str, launch_wave: u32, remaining_dependency_path: u32, unit_order: u32) -> WorkItem {
    WorkItem {
        id: WorkItemId(id.to_owned()),
        capacity_class: class("general"),
        launch_wave,
        remaining_dependency_path,
        unit_order,
        readiness: ready(),
        pressure_policy: PressurePolicy::DelayWhenPressed,
    }
}

fn view(items: Vec<WorkItem>) -> ScheduleView {
    ScheduleView {
        policy: SchedulePolicy {
            parallel_cap: 16,
            capped_class: class("general"),
        },
        active_capped: 0,
        resources: resources(),
        items,
    }
}

fn ids(ids: &[&str]) -> Vec<WorkItemId> {
    ids.iter().map(|id| WorkItemId((*id).to_owned())).collect()
}

#[test]
fn applies_all_four_tie_break_rules_in_order() {
    let input = view(vec![
        item("wave-late", 1, 99, 0),
        item("id-b", 0, 9, 2),
        item("unit-early", 0, 9, 1),
        item("path-long", 0, 10, 5),
        item("id-a", 0, 9, 2),
    ]);

    assert_eq!(
        dispatch_order(&input),
        ids(&["path-long", "unit-early", "id-a", "id-b", "wave-late"]),
    );
}

#[test]
fn rule_four_makes_total_order_reproducible() {
    let input = view(vec![
        item("same-b", 0, 7, 3),
        item("same-c", 0, 7, 3),
        item("same-a", 0, 7, 3),
    ]);
    let expected = ids(&["same-a", "same-b", "same-c"]);

    for _ in 0..32 {
        assert_eq!(dispatch_order(&input), expected);
    }
}
