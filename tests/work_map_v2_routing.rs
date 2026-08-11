use drivers::planning;

#[test]
fn fresh_work_map_roles_declare_v2_boundaries() {
    let assignments = planning::planning_assignments_for_workstream("routing-red").unwrap();
    for role in ["plan-compiler", "plan-synthesizer", "recovery-engineer"] {
        let boundaries = assignments
            .iter()
            .filter(|assignment| assignment.role == role)
            .map(|assignment| assignment.boundary_id.as_deref())
            .collect::<Vec<_>>();
        assert!(
            boundaries
                .iter()
                .all(|boundary| *boundary == Some("planning.work-map.v2")),
            "{role} must be issued only on planning.work-map.v2; got {boundaries:?}"
        );
        let runtime = drivers::runner::role_runtime(role).expect("declared role runtime");
        assert_eq!(runtime.provider, "openai-codex");
        assert_eq!(runtime.model, "gpt-5.6-sol");
        for assignment in assignments
            .iter()
            .filter(|assignment| assignment.role == role)
        {
            let route = assignment
                .terminal_route
                .as_ref()
                .expect("fresh route tuple");
            let expected = match role {
                "plan-compiler" => (
                    "initial-plan",
                    "planning.work-map.v2:autopilot_submit_plan_cluster",
                    "autopilot_submit_plan_cluster",
                    "4f341cc4aade90ac13c4584898f29b42d054d4ea4b5c126117841550e680ae75",
                ),
                "plan-synthesizer" => (
                    "initial-plan",
                    "planning.work-map.v2:autopilot_submit_synthesis",
                    "autopilot_submit_synthesis",
                    "4f341cc4aade90ac13c4584898f29b42d054d4ea4b5c126117841550e680ae75",
                ),
                "recovery-engineer" => (
                    "planning-repair",
                    "recovery-work-map.v2",
                    "autopilot_emit_status",
                    "4b254caa4e21953efdc3102cb86c35c3238dfadc57b83fb083f5cbb49065857c",
                ),
                _ => unreachable!(),
            };
            assert_eq!(assignment.mode, expected.0);
            assert_eq!(route.version, "v2");
            assert_eq!(route.profile_id, expected.1);
            assert_eq!(route.tool_name.0, expected.2);
            assert_eq!(route.boundary_id.0, "planning.work-map.v2");
            assert_eq!(route.result_contract.0, "planning.work-map.v2");
            assert_eq!(route.schema_digest.0, expected.3);
        }
    }
}

#[test]
fn planning_recovery_profiles_are_exactly_read_only_without_changing_other_routes() {
    let read_only = ["read", "grep", "find", "ls", "autopilot_emit_status"];
    for profile in ["recovery-work-map.v1", "recovery-work-map.v2"] {
        let resolved = drivers::runner::resolve_role_tools("recovery-engineer", profile)
            .expect("planning recovery tools");
        assert_eq!(resolved.active, read_only, "{profile} active tools");
        for forbidden in [
            "autopilot_run_approved_command",
            "autopilot_set_executable",
            "edit",
            "write",
            "bash",
        ] {
            assert!(
                !resolved.active.iter().any(|tool| tool == forbidden),
                "{profile} must not activate {forbidden}"
            );
        }
    }

    let delivery = drivers::runner::resolve_role_tools("recovery-engineer", "delivery-status.v2")
        .expect("delivery recovery tools");
    assert_eq!(
        delivery.active,
        [
            "read",
            "grep",
            "find",
            "ls",
            "autopilot_run_approved_command",
            "edit",
            "write",
            "autopilot_set_executable",
            "autopilot_emit_status",
        ]
    );

    let compiler = drivers::runner::resolve_role_tools(
        "plan-compiler",
        "planning.work-map.v2:autopilot_submit_plan_cluster",
    )
    .expect("V2 compiler tools");
    assert_eq!(
        compiler.active,
        [
            "read",
            "grep",
            "find",
            "ls",
            "autopilot_submit_plan_cluster"
        ]
    );
    let synthesizer = drivers::runner::resolve_role_tools(
        "plan-synthesizer",
        "planning.work-map.v2:autopilot_submit_synthesis",
    )
    .expect("V2 synthesizer tools");
    assert_eq!(
        synthesizer.active,
        ["read", "grep", "find", "ls", "autopilot_submit_synthesis"]
    );
}

#[test]
fn v2_profile_selection_rejects_unknown_and_mixed_role_tuples() {
    let exact = [
        (
            "plan-compiler",
            "planning.work-map.v2:autopilot_submit_plan_cluster",
            "autopilot_submit_plan_cluster",
        ),
        (
            "plan-synthesizer",
            "planning.work-map.v2:autopilot_submit_synthesis",
            "autopilot_submit_synthesis",
        ),
        (
            "recovery-engineer",
            "recovery-work-map.v2",
            "autopilot_emit_status",
        ),
    ];
    for (role, profile, terminal) in exact {
        let tools = drivers::runner::resolve_role_tools(role, profile)
            .expect("exact V2 role/profile tuple must select one active terminal");
        assert!(tools.active.iter().any(|tool| tool == terminal));
    }
    assert!(drivers::runner::resolve_role_tools("plan-compiler", "unknown-profile").is_err());
    assert!(
        drivers::runner::resolve_role_tools(
            "plan-compiler",
            "planning.work-map.v2:autopilot_submit_synthesis"
        )
        .is_err()
    );
    assert!(
        drivers::runner::resolve_role_tools(
            "recovery-engineer",
            "planning.work-map.v2:autopilot_submit_plan_cluster"
        )
        .is_err()
    );
}
