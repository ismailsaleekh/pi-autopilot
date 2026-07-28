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
            "max",
            "bounded catalog/artifact read-only",
            "autopilot_submit_context",
        ),
        row(
            "context-synthesizer",
            "initial-dossier, dossier-delta",
            "reasoning",
            "max",
            "complete Scout ledger read-only",
            "autopilot_submit_synthesis",
        ),
        row(
            "contradiction-resolver",
            "fact-resolution",
            "reasoning",
            "max",
            "exact evidence scope, read-only",
            "autopilot_submit_resolution",
        ),
        row(
            "execution-allocator",
            "initial-allocation, delta-allocation",
            "reasoning",
            "max",
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
            "max",
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
            "max",
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
            "max",
            "complete compiler/trace ledger read-only",
            "autopilot_submit_synthesis",
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
            "exact candidate/evidence read-only",
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
            "grep".to_owned(),
            "find".to_owned(),
            "ls".to_owned(),
            "context_budget".to_owned(),
            "autopilot_request_test".to_owned(),
            "autopilot_emit_status".to_owned(),
        ]
    );
    assert!(!validator.tools.iter().any(|tool| matches!(tool.as_str(), "bash" | "edit" | "write")));
    let policy = include_str!("../data/context-policy.kdl");
    assert!(!policy.contains("forward-validation"));
    for mode in ["forward-release", "deep-closure", "delta-revalidation", "conflict-review", "final-review"] {
        assert!(policy.contains(&format!("role id=\"validator\" mode=\"{mode}\"")), "missing validator context policy for {mode}");
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
