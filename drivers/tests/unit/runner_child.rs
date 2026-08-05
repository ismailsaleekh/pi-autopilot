use super::*;

#[test]
fn subscription_startup_stagger_is_bounded_and_spreads_wave_ordinals() {
    let policy = SubscriptionStartupStaggerPolicy::parse().expect("package policy");
    let delays = (1..=7)
        .map(|ordinal| {
            policy.delay(
                "hello-health",
                &format!("planning-hello-health-task-extractor-{ordinal:02}"),
                None,
            )
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(delays.len(), 7, "one wave must occupy distinct buckets");
    assert!(
        delays
            .iter()
            .all(|delay| delay.as_millis() <= u128::from(policy.max_delay_ms))
    );
    let lane_delays = (1..=7)
        .map(|ordinal| {
            policy.delay(
                "hello-health",
                &format!("validation-assignment-hello-health-L{ordinal}-r1"),
                Some(&format!("L{ordinal}")),
            )
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        lane_delays.len(),
        7,
        "parallel lane children must occupy distinct buckets"
    );
}

#[test]
fn subscription_startup_stagger_applies_only_to_fresh_subscription_sessions() {
    let policy = SubscriptionStartupStaggerPolicy::parse().expect("package policy");
    let mut spec = agent_run_spec_with_tools(["bash", "read"]);
    assert!(subscription_startup_delay(policy, &spec).is_some());
    spec.session_continuity = SessionContinuity::Resume;
    assert_eq!(subscription_startup_delay(policy, &spec), None);
    spec.session_continuity = SessionContinuity::Fresh;
    spec.route = "api-key".to_owned();
    assert_eq!(subscription_startup_delay(policy, &spec), None);
}

#[test]
fn malformed_subscription_startup_stagger_fails_loud() {
    let error = SubscriptionStartupStaggerPolicy::parse_source(
        "subscription_startup_stagger scope=\"agent-run\" buckets=7 step_ms=200 max_delay_ms=100",
    )
    .expect_err("incoherent policy must fail");
    assert!(error.contains("bounds are incoherent"), "{error}");
    let error = SubscriptionStartupStaggerPolicy::parse_source(
        "subscription_startup_stagger scope=\"all-routes\" buckets=7 step_ms=750 max_delay_ms=4500",
    )
    .expect_err("unsupported scope must fail");
    assert!(error.contains("unsupported scope"), "{error}");
}

#[test]
fn offered_terminal_tool_new_rejects_unoffered_expected_tool() {
    let spec = agent_run_spec_with_tools(["bash", "read"]);

    let miss = OfferedTerminalTool::new(&spec).expect_err("missing terminal tool must fail");

    assert_eq!(
        miss,
        TerminalMiss::TerminalToolNotOffered {
            source: TerminalToolNotOfferedSource::OfferedTerminalToolGuard,
            expected_tool: "autopilot_submit_atoms".to_owned(),
            offered_tools: vec!["bash".to_owned(), "read".to_owned()],
        }
    );
}

fn agent_run_spec_with_tools(tools: impl IntoIterator<Item = &'static str>) -> AgentRunSpec {
    let allowed_tools = tools.into_iter().collect::<Vec<_>>();
    serde_json::from_value(serde_json::json!({
        "schema": "autopilot.agent_run_spec.v4",
        "assignment_kind": "planning-review",
        "action_id": "action-planning-main-task-extractor-01",
        "assignment_id": "planning-main-task-extractor-01",
        "run_id": "run-01",
        "run_revision": 1,
        "workstream": "main",
        "role_id": "task-extractor",
        "mode": "inventory",
        "provider": "openai-codex",
        "model": "gpt-5.5",
        "thinking": "high",
        "route": "subscription",
        "cwd": "/tmp/pi-autopilot-test",
        "allowed_tools": allowed_tools,
        "spec_path": "/tmp/pi-autopilot-test/spec.json",
        "prompt_path": "/tmp/pi-autopilot-test/prompt.md",
        "prompt_digest": "prompt-digest",
        "boundary_id": "planning.task-atoms.v1",
        "boundary_digest": "boundary-digest",
        "result_contract": "planning.task-atoms.v1",
        "result_contract_digest": "result-contract-digest",
        "carrier_path": "/tmp/pi-autopilot-test/carrier.json",
        "session_id": "session-01",
        "session_dir": "/tmp/pi-autopilot-test/session",
        "session_continuity": "fresh",
        "settings_digest": "settings-digest",
        "context_digest": "context-digest",
        "skills_digest": "skills-digest",
        "subscription_digest": "subscription-digest",
        "terminal_profile_id": "planning.task-atoms.v1:autopilot_submit_atoms",
        "unavailable_tools": []
    }))
    .expect("valid agent run spec")
}
