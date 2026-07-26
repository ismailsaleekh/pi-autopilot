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

fn item(id: &str, capacity_class: CapacityClass) -> WorkItem {
    WorkItem {
        id: WorkItemId(id.to_owned()),
        capacity_class,
        launch_wave: 0,
        remaining_dependency_path: 1,
        unit_order: 0,
        readiness: ready(),
        pressure_policy: PressurePolicy::DelayWhenPressed,
    }
}

#[test]
fn saturated_cap_does_not_bound_other_capacity_classes() {
    let bounded = class("bounded");
    let outside = class("validator-equivalent");
    let input = ScheduleView {
        policy: SchedulePolicy {
            parallel_cap: 1,
            capped_class: bounded.clone(),
        },
        active_capped: 1,
        resources: resources(),
        items: vec![
            item("new-implementer-equivalent", bounded),
            item("validator-equivalent", outside),
        ],
    };

    assert_eq!(
        dispatch_order(&input),
        vec![WorkItemId("validator-equivalent".to_owned())],
    );
}
