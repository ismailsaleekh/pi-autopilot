use drivers::planning::planning_assignment_roles;
use drivers::roles::RoleRegistry;

#[test]
fn role_matrix_matches_d76_section_2_3_exactly() {
    let registry = RoleRegistry::package().expect("role registry loads");
    let actual: Vec<(String, String, String, String, String, String)> = registry
        .roles()
        .map(|role| {
            let modes = if role.id == "task-extractor" {
                format!("{} + seven lens parameters", role.modes.join(", "))
            } else {
                role.modes.join(", ")
            };
            (
                role.id.clone(),
                modes,
                role.model_slot.clone(),
                role.thinking.clone(),
                role.repository.clone(),
                role.terminal_path.clone(),
            )
        })
        .collect();
    let expected = vec![
        row(
            "bughunter",
            "final-bughunt",
            "review",
            "xhigh",
            "exact final candidate read-only",
            "autopilot_emit_status",
        ),
        row(
            "context-curator",
            "discovery-navigation, planning-context, execution-context",
            "reasoning",
            "xhigh",
            "bounded catalog/artifact read-only",
            "autopilot_submit_context",
        ),
        row(
            "context-synthesizer",
            "initial-dossier, dossier-delta",
            "reasoning",
            "xhigh",
            "complete Scout ledger read-only",
            "autopilot_submit_synthesis",
        ),
        row(
            "contradiction-resolver",
            "fact-resolution",
            "reasoning",
            "xhigh",
            "exact evidence scope, read-only",
            "autopilot_submit_resolution",
        ),
        row(
            "execution-allocator",
            "initial-allocation, delta-allocation",
            "reasoning",
            "xhigh",
            "Allocation Dossier only",
            "autopilot_submit_allocation",
        ),
        row(
            "fixer-integrator",
            "forward-critical, closure-repair, failed-test, conflict-resolution",
            "coding",
            "high",
            "assigned sparse repair/integration worktree",
            "autopilot_emit_status",
        ),
        row(
            "implementer",
            "lane-delivery",
            "coding",
            "high",
            "assigned sparse worktree read/write",
            "autopilot_emit_status",
        ),
        row(
            "onboard",
            "thin-intake",
            "reasoning",
            "xhigh",
            "bounded read-only",
            "autopilot_submit_onboard",
        ),
        row(
            "orchestrator",
            "planning-control, execution-control",
            "control",
            "high",
            "none",
            "Controller action acknowledgement",
        ),
        row(
            "plan-compiler",
            "initial-plan, unit-spec-patch, cluster-amendment",
            "reasoning",
            "xhigh",
            "planning artifacts read-only",
            "autopilot_submit_plan_cluster",
        ),
        row(
            "plan-reviewer",
            "full-review, delta-review",
            "review",
            "xhigh",
            "canonical planning artifacts read-only",
            "autopilot_submit_review",
        ),
        row(
            "plan-synthesizer",
            "initial-plan, affected-scope",
            "reasoning",
            "xhigh",
            "complete compiler/trace ledger read-only",
            "autopilot_submit_synthesis",
        ),
        row(
            "recovery-engineer",
            "planning-repair, forward-critical, closure-repair, failed-test, conflict-resolution",
            "reasoning",
            "xhigh",
            "phase-bound repair target within original authority",
            "autopilot_emit_status",
        ),
        row(
            "repository-scout",
            "initial-grounding, targeted-followup",
            "coding",
            "high",
            "repository read-only",
            "autopilot_submit_scout_report",
        ),
        row(
            "task-extractor",
            "inventory + seven lens parameters",
            "extraction",
            "high",
            "task-authority read-only",
            "autopilot_submit_atoms",
        ),
        row(
            "validator",
            "forward-release, deep-closure, delta-revalidation, conflict-review, final-review",
            "review",
            "xhigh",
            "exact citation-bound evidence read-only",
            "autopilot_emit_status",
        ),
    ];
    assert_eq!(actual, expected);
}

#[test]
fn validator_role_is_mechanically_read_only_and_context_modes_are_registered() {
    let registry = RoleRegistry::package().expect("role registry loads");
    let validator = registry.get("validator").expect("validator role");
    assert_eq!(
        validator.tools,
        vec![
            "read".to_owned(),
            "autopilot_request_test".to_owned(),
            "autopilot_emit_status".to_owned(),
        ]
    );
    assert!(
        !validator
            .tools
            .iter()
            .any(|tool| matches!(tool.as_str(), "bash" | "edit" | "write"))
    );
    let policy = include_str!("../data/context-policy.kdl");
    assert!(!policy.contains("forward-validation"));
    let registry = drivers::context::policy::ContextPolicyRegistry::package()
        .expect("context policy registry parses");
    for mode in [
        "forward-release",
        "deep-closure",
        "delta-revalidation",
        "conflict-review",
        "final-review",
    ] {
        let resolved = registry
            .policy(&validator.context_policy)
            .expect("validator context policy is registered");
        assert_eq!(resolved.role_id, "validator");
        assert!(
            resolved.modes.contains_key(mode),
            "missing validator context policy for {mode}"
        );
    }
}

#[test]
fn every_planning_terminal_has_one_generated_tool_boundary_binding() {
    let registry = RoleRegistry::package().expect("role registry loads");
    for assignment in planning_assignment_roles().expect("planning roles") {
        let role = registry.get(&assignment.role).expect("planning role");
        assert!(
            role.tools.iter().any(|tool| tool == &role.terminal_path),
            "{} terminal {} is not declared in role tools",
            role.id,
            role.terminal_path
        );
        let matches = kernel::generated::SUBMIT_TOOLS
            .iter()
            .filter(|(tool, boundary, _)| {
                *tool == role.terminal_path && *boundary == assignment.boundary_id
            })
            .count();
        assert_eq!(
            matches, 1,
            "{} terminal {} must have one generated binding to {}",
            role.id, role.terminal_path, assignment.boundary_id
        );
    }
}

#[test]
fn live_delivery_and_validation_profiles_are_exact_and_capability_backed() {
    for (role, profile_id, boundary, result, unavailable) in [
        (
            "implementer",
            "delivery-status.v2",
            "autopilot.delivery_submission.v2",
            "autopilot.delivery_result.v2",
            Vec::<String>::new(),
        ),
        (
            "validator",
            "validation-status.v3",
            "autopilot.validation_submission.v3",
            "autopilot.validation_result.v3",
            vec!["autopilot_request_test".to_owned()],
        ),
    ] {
        let matches = kernel::generated::TERMINAL_PROFILES
            .iter()
            .filter(|row| {
                row.0 == profile_id
                    && row.1 == "autopilot_emit_status"
                    && row.2 == boundary
                    && row.3 == result
            })
            .count();
        assert_eq!(matches, 1, "{role} terminal profile must be unique");
        let resolved = drivers::runner::resolve_role_tools(role, profile_id).expect("tools");
        assert!(
            resolved
                .active
                .iter()
                .any(|tool| tool == "autopilot_emit_status")
        );
        assert_eq!(resolved.unavailable, unavailable);
    }
}

#[test]
fn recovery_engineer_planning_profile_is_mechanically_read_only_but_delivery_can_repair() {
    let planning = drivers::runner::resolve_role_tools("recovery-engineer", "recovery-work-map.v1")
        .expect("planning recovery tools");
    assert_eq!(
        planning.active,
        ["read", "grep", "find", "ls", "autopilot_emit_status"]
    );
    let delivery = drivers::runner::resolve_role_tools("recovery-engineer", "delivery-status.v2")
        .expect("delivery recovery tools");
    for required in [
        "autopilot_run_approved_command",
        "edit",
        "write",
        "autopilot_emit_status",
    ] {
        assert!(delivery.active.iter().any(|tool| tool == required));
    }
    assert!(!delivery.active.iter().any(|tool| tool == "bash"));
    for role in ["implementer", "fixer-integrator"] {
        let tools = drivers::runner::resolve_role_tools(role, "delivery-status.v2")
            .expect("delivery tools");
        assert!(
            tools
                .active
                .iter()
                .any(|tool| tool == "autopilot_run_approved_command")
        );
        assert!(!tools.active.iter().any(|tool| tool == "bash"));
    }
}

#[test]
fn retained_undeliverable_tools_are_declared_as_known_incomplete() {
    let registry = RoleRegistry::package().expect("role registry loads");
    let record = include_str!("../data/known-incomplete-tools.kdl");
    let retained = [
        ("validator", "autopilot_request_test"),
        ("onboard", "autopilot_submit_onboard"),
        ("execution-allocator", "autopilot_submit_allocation"),
    ];

    assert_eq!(
        record
            .lines()
            .filter(|line| line.starts_with("tool \""))
            .count(),
        retained.len()
    );
    for (role_id, tool) in retained {
        let role = registry.get(role_id).expect("retained role");
        assert!(role.tools.iter().any(|declared| declared == tool));
        assert!(record.contains(&format!("tool \"{tool}\" role=\"{role_id}\"")));
    }
}

fn row(
    id: &str,
    modes: &str,
    slot: &str,
    thinking: &str,
    repo: &str,
    terminal: &str,
) -> (String, String, String, String, String, String) {
    (
        id.to_owned(),
        modes.to_owned(),
        slot.to_owned(),
        thinking.to_owned(),
        repo.to_owned(),
        terminal.to_owned(),
    )
}
