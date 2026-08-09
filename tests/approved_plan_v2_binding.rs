use drivers::seam::ApprovedPlanV2BindingV1;

fn binding_json(recovery_subject: &str) -> String {
    format!(
        r#"{{
      "schema":"autopilot.approved_plan_v2_binding.v1","workstream":"w",
      "approved_plan_path":"/tmp/image","approved_plan_sha256":"{}",
      "source_carrier_path":"/tmp/carrier","source_carrier_sha256":"{}",
      "source_raw_work_map_sha256":"{}","source_spec_path":"/tmp/spec",
      "source_role_id":"plan-synthesizer","source_mode":"initial-plan",
      "source_terminal_route":{{"version":"v2","profile_id":"planning.work-map.v2:autopilot_submit_synthesis","tool_name":"autopilot_submit_synthesis","boundary_id":"planning.work-map.v2","result_contract":"planning.work-map.v2","schema_digest":"{}"}},
      "source_carrier_binding":"test-binding","source_spec_digest":"{}","source_pi_version":"pi test",
      "source_boundary":"planning.work-map.v2","result_contract":"planning.work-map.v2",
      "atom_registry_path":"/tmp/atoms","atom_registry_digest":"{}",
      "recovery_subject":{recovery_subject}
    }}"#,
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "f".repeat(64),
        "0".repeat(64),
        "e".repeat(64),
    )
}

#[test]
fn binding_required_nullable_accepts_explicit_null() {
    assert!(serde_json::from_str::<ApprovedPlanV2BindingV1>(&binding_json("null")).is_ok());
}

#[test]
fn binding_required_nullable_rejects_missing_field() {
    let raw = binding_json("null").replace("      \"recovery_subject\":null\n", "");
    assert!(serde_json::from_str::<ApprovedPlanV2BindingV1>(&raw).is_err());
}

#[test]
fn binding_required_nullable_accepts_complete_object_without_repository_authority() {
    let subject = format!(
        r#"{{"schema":"autopilot.approved_plan_v2_recovery_subject.v1","source_carrier_path":"/tmp/subject","source_carrier_sha256":"{}","source_raw_work_map_sha256":"{}","source_spec_path":"/tmp/subject-spec","source_role_id":"plan-synthesizer","source_mode":"initial-plan","source_terminal_route":{{"version":"v2","profile_id":"planning.work-map.v2:autopilot_submit_synthesis","tool_name":"autopilot_submit_synthesis","boundary_id":"planning.work-map.v2","result_contract":"planning.work-map.v2","schema_digest":"{}"}},"source_carrier_binding":"test-binding","source_spec_digest":"{}","source_pi_version":"pi test","atom_registry_path":"/tmp/atoms","atom_registry_digest":"{}"}}"#,
        "a".repeat(64),
        "b".repeat(64),
        "e".repeat(64),
        "f".repeat(64),
        "c".repeat(64),
    );
    assert!(serde_json::from_str::<ApprovedPlanV2BindingV1>(&binding_json(&subject)).is_ok());
}

#[test]
fn binding_is_closed_and_has_no_removed_repository_metadata() {
    let raw = binding_json("null");
    let forbidden = ",\"binding_sha256\":\"forbidden\"";
    let changed = raw.replace("\n    }", &format!("{forbidden}\n    }}"));
    assert!(
        serde_json::from_str::<ApprovedPlanV2BindingV1>(&changed).is_err(),
        "accepted forbidden field {forbidden}"
    );
}
