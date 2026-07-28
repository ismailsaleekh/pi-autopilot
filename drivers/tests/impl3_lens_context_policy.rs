use drivers::{
    context::policy::{ContextPolicyError, ContextPolicyRegistry},
    prompt::{PromptInput, Renderer},
    roles::{ModeParameterAllocationError, RoleRegistry, allocate_mode_parameters},
};

#[test]
fn policy_registry_rejects_unknown_or_misnamed_role_policy() {
    let roles = RoleRegistry::package().expect("package roles parse");
    let text = drivers::context::policy::CONTEXT_POLICY_KDL.replace(
        "policy id=\"fixer-integrator.v1\" role=\"fixer-integrator\"",
        "policy id=\"fixer-integrator.v1\" role=\"fixer\"",
    );
    let registry = ContextPolicyRegistry::parse(&text).expect("policy registry parses");
    let err = registry
        .validate_roles(&roles)
        .expect_err("misnamed fixer role must fail closed");
    assert!(
        matches!(err, ContextPolicyError::RoleMismatch { ref policy_id, ref expected_role, ref actual_role }
            if policy_id == "fixer-integrator.v1" && expected_role == "fixer-integrator" && actual_role == "fixer"),
        "unexpected error: {err:?}"
    );
}

#[test]
fn every_role_context_policy_reference_resolves() {
    let roles = RoleRegistry::package().expect("package roles and policies validate");
    let registry = ContextPolicyRegistry::package().expect("package context policies validate");
    for role in roles.roles() {
        let policy = registry
            .policy(&role.context_policy)
            .expect("role context_policy resolves");
        assert_eq!(policy.role_id, role.id);
    }

    let broken = remove_policy_block(
        drivers::context::policy::CONTEXT_POLICY_KDL,
        "  policy id=\"task-extractor.v1\"",
        "  policy id=\"repository-scout.v1\"",
    );
    let broken_registry = ContextPolicyRegistry::parse(&broken).expect("broken registry parses");
    let err = broken_registry
        .validate_roles(&roles)
        .expect_err("renamed referenced policy must fail loudly");
    assert!(
        matches!(err, ContextPolicyError::MissingPolicy(ref id) if id == "task-extractor.v1"),
        "unexpected error: {err:?}"
    );
}

#[test]
fn mode_parameter_cardinality_law() {
    let roles = RoleRegistry::package().expect("package roles parse");
    let scout = roles.get("repository-scout").expect("scout role exists");
    let scout_alloc = allocate_mode_parameters(scout, 5).expect("0 params may fan out");
    assert_eq!(scout_alloc, vec![None, None, None, None, None]);

    let extractor = roles.get("task-extractor").expect("extractor role exists");
    let extractor_alloc =
        allocate_mode_parameters(extractor, 7).expect("7 params zip to 7 assignments");
    let numbered: Vec<String> = extractor_alloc
        .iter()
        .enumerate()
        .map(|(idx, value)| format!("{:02} {}", idx + 1, value.as_ref().expect("lens bound")))
        .collect();
    assert_eq!(
        numbered,
        vec![
            "01 WORK",
            "02 DECISION",
            "03 CONSTRAINT",
            "04 ACCEPTANCE",
            "05 PREMISE",
            "06 QUESTION",
            "07 REFERENCE",
        ]
    );

    let err =
        allocate_mode_parameters(extractor, 6).expect_err("7 params cannot bind 6 assignments");
    assert!(
        matches!(err, ModeParameterAllocationError::ModeParameterCardinality { ref role_id, parameter_count: 7, assignment_count: 6 }
            if role_id == "task-extractor"),
        "unexpected error: {err:?}"
    );
}

#[test]
fn renderer_substitutes_bound_lens_and_rejects_token_misuse() {
    let renderer = Renderer::package().expect("renderer loads package registry");
    let rendered = renderer
        .render(&prompt_input("task-extractor", "inventory", Some("WORK")))
        .expect("bound task extractor renders");
    assert!(
        rendered
            .text
            .contains("Apply exactly one lens parameter: `WORK`."),
        "rendered prompt did not contain bound lens"
    );
    assert!(
        !rendered.text.contains("{{MODE_PARAMETER}}"),
        "renderer leaked unsubstituted token"
    );

    let missing = renderer
        .render(&prompt_input("task-extractor", "inventory", None))
        .expect_err("parameterized role requires a bound lens");
    assert!(format!("{missing:?}").contains("ModeParameter"));

    let unexpected = renderer
        .render(&prompt_input("validator", "forward-release", Some("WORK")))
        .expect_err("parameterless role rejects a bound lens with no token");
    assert!(format!("{unexpected:?}").contains("ModeParameter"));
}

#[test]
fn lens_allocation_is_resume_stable() {
    let roles = RoleRegistry::package().expect("package roles parse");
    let extractor = roles.get("task-extractor").expect("extractor role exists");
    let first = allocate_mode_parameters(extractor, 7).expect("first allocation succeeds");
    let second = allocate_mode_parameters(extractor, 7).expect("second allocation succeeds");
    assert_eq!(first, second);
}

fn remove_policy_block(text: &str, start_marker: &str, next_marker: &str) -> String {
    let start = text.find(start_marker).expect("start marker exists");
    let next = text[start..]
        .find(next_marker)
        .map(|offset| start + offset)
        .expect("next marker exists");
    let mut out = String::new();
    out.push_str(&text[..start]);
    out.push_str(&text[next..]);
    out
}

fn prompt_input(role_id: &str, mode_id: &str, mode_parameter: Option<&str>) -> PromptInput {
    PromptInput {
        role_id: role_id.to_owned(),
        mode_id: mode_id.to_owned(),
        mode_parameter: mode_parameter.map(str::to_owned),
        assignment_revision: "assignment-r1".to_owned(),
        plan_revision: "plan-r1".to_owned(),
        runtime_revision: 7,
        context_manifest_id: "manifest-1".to_owned(),
        git_identity: "base=abc123 candidate=def456 worktree=wt1".to_owned(),
        assignment: "objective: exercise renderer".to_owned(),
        context_manifest: "manifest_id: manifest-1\nmandatory_inline: []".to_owned(),
        contract: "Submit the required terminal payload.".to_owned(),
        runtime_overlay: None,
    }
}
