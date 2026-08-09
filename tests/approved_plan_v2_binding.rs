use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use drivers::allocation::{ApprovedCriterion, ApprovedUnit};
use drivers::seam::{
    APPROVED_PLAN_V1_BOUNDARY, ApprovedPlanArtifactV1, ApprovedPlanV2BindingV1,
    ApprovedRepositoryAuthority, read_approved_plan_v1_legacy, read_approved_plan_v2,
    write_approved_plan_v1_legacy,
};
use kernel::generated::{Id, Path as ContractPath, PlanUnitCommand, PlanUnitKind, Sha};
use sha2::{Digest, Sha256};

static NEXT_LEGACY_PATH: AtomicU64 = AtomicU64::new(0);

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn legacy_path(label: &str) -> PathBuf {
    fs::canonicalize(std::env::temp_dir())
        .expect("canonical temporary root")
        .join(format!(
            "pi-autopilot-v1-evidence-{label}-{}-{}",
            std::process::id(),
            NEXT_LEGACY_PATH.fetch_add(1, Ordering::Relaxed)
        ))
}

fn legacy_unit() -> ApprovedUnit {
    let criterion = Id("AC-one-1".to_owned());
    let command: PlanUnitCommand = serde_json::from_value(serde_json::json!({
        "command":"true","expected":"passes","effect":"no-effect",
        "generated_paths":[],"handling":"none","scope_preservation":"clean"
    }))
    .unwrap();
    ApprovedUnit {
        id: Id("one".to_owned()),
        kind: PlanUnitKind::Implementation,
        objective: "legacy objective".to_owned(),
        operator_order: 1,
        decisions: vec![Id("atom".to_owned())],
        criteria: vec![criterion.clone()],
        criterion_text: vec![ApprovedCriterion {
            id: criterion,
            text: "legacy criterion".to_owned(),
        }],
        dependencies: vec![],
        predecessor_forward_criteria: vec![],
        downstream_release_edges: vec![],
        files: vec![ContractPath("src/legacy.rs".to_owned())],
        commands: vec![command],
        package_checks: vec![],
    }
}

fn legacy_artifact(
    repository_authority: Option<ApprovedRepositoryAuthority>,
) -> ApprovedPlanArtifactV1 {
    ApprovedPlanArtifactV1 {
        repository_authority,
        units: vec![legacy_unit()],
    }
}

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
      "repository_manifest_path":"/tmp/manifest","repository_manifest_digest":"{}",
      "repository_head_commit":"1111111111111111111111111111111111111111","repository_head_tree":"2222222222222222222222222222222222222222",
      "atom_registry_path":"/tmp/atoms","atom_registry_digest":"{}",
      "recovery_subject":{recovery_subject}
    }}"#,
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "f".repeat(64),
        "0".repeat(64),
        "d".repeat(64),
        "e".repeat(64),
    )
}

#[test]
fn v1_legacy_pretty_bytes_unknown_artifact_field_and_v2_isolation() {
    let authority = ApprovedRepositoryAuthority {
        manifest_path: "/repo/.pi/autopilot/w/planning/repository-authority.v1.json".to_owned(),
        manifest_digest: "a".repeat(64),
        head_commit: Sha("b".repeat(40)),
        head_tree: Sha("c".repeat(40)),
    };
    for (label, artifact) in [
        ("some", legacy_artifact(Some(authority))),
        ("none", legacy_artifact(None)),
    ] {
        let path = legacy_path(label);
        let _ = fs::remove_file(&path);
        write_approved_plan_v1_legacy(&path, &artifact).unwrap();
        let bytes = fs::read(&path).unwrap();
        let expected: &[u8] = match label {
            "some" => {
                br#"{
  "repository_authority": {
    "manifest_path": "/repo/.pi/autopilot/w/planning/repository-authority.v1.json",
    "manifest_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "head_commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "head_tree": "cccccccccccccccccccccccccccccccccccccccc"
  },
  "units": [
    {
      "id": "one",
      "kind": "implementation",
      "objective": "legacy objective",
      "operator_order": 1,
      "decisions": [
        "atom"
      ],
      "criteria": [
        "AC-one-1"
      ],
      "criterion_text": [
        {
          "id": "AC-one-1",
          "text": "legacy criterion"
        }
      ],
      "dependencies": [],
      "predecessor_forward_criteria": [],
      "downstream_release_edges": [],
      "files": [
        "src/legacy.rs"
      ],
      "commands": [
        {
          "command": "true",
          "expected": "passes",
          "effect": "no-effect",
          "generated_paths": [],
          "handling": "none",
          "scope_preservation": "clean"
        }
      ],
      "package_checks": []
    }
  ]
}"#
            }
            "none" => {
                br#"{
  "units": [
    {
      "id": "one",
      "kind": "implementation",
      "objective": "legacy objective",
      "operator_order": 1,
      "decisions": [
        "atom"
      ],
      "criteria": [
        "AC-one-1"
      ],
      "criterion_text": [
        {
          "id": "AC-one-1",
          "text": "legacy criterion"
        }
      ],
      "dependencies": [],
      "predecessor_forward_criteria": [],
      "downstream_release_edges": [],
      "files": [
        "src/legacy.rs"
      ],
      "commands": [
        {
          "command": "true",
          "expected": "passes",
          "effect": "no-effect",
          "generated_paths": [],
          "handling": "none",
          "scope_preservation": "clean"
        }
      ],
      "package_checks": []
    }
  ]
}"#
            }
            _ => unreachable!(),
        };
        assert_eq!(bytes, expected, "legacy {label} pretty JSON bytes");
        assert_eq!(
            read_approved_plan_v1_legacy(
                &path,
                APPROVED_PLAN_V1_BOUNDARY,
                APPROVED_PLAN_V1_BOUNDARY
            )
            .unwrap()
            .units,
            artifact.units
        );
        let v2_error = read_approved_plan_v2(&path, &sha(&bytes)).unwrap_err();
        assert!(
            v2_error.contains("approved-plan-v2 binding JSON"),
            "{v2_error}"
        );
        fs::remove_file(path).unwrap();
    }

    let path = legacy_path("unknown-artifact");
    let _ = fs::remove_file(&path);
    let artifact = legacy_artifact(None);
    let mut value = serde_json::to_value(&artifact).unwrap();
    value["historical_artifact_field"] = serde_json::json!(true);
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(
        read_approved_plan_v1_legacy(&path, APPROVED_PLAN_V1_BOUNDARY, APPROVED_PLAN_V1_BOUNDARY)
            .unwrap()
            .units,
        artifact.units
    );
    fs::remove_file(path).unwrap();
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
fn binding_required_nullable_accepts_complete_object() {
    let subject = format!(
        r#"{{"schema":"autopilot.approved_plan_v2_recovery_subject.v1","source_carrier_path":"/tmp/subject","source_carrier_sha256":"{}","source_raw_work_map_sha256":"{}","source_spec_path":"/tmp/subject-spec","source_role_id":"plan-synthesizer","source_mode":"initial-plan","source_terminal_route":{{"version":"v2","profile_id":"planning.work-map.v2:autopilot_submit_synthesis","tool_name":"autopilot_submit_synthesis","boundary_id":"planning.work-map.v2","result_contract":"planning.work-map.v2","schema_digest":"{}"}},"source_carrier_binding":"test-binding","source_spec_digest":"{}","source_pi_version":"pi test","atom_registry_path":"/tmp/atoms","atom_registry_digest":"{}","repository_manifest_path":"/tmp/manifest","repository_manifest_digest":"{}","repository_head_commit":"1111111111111111111111111111111111111111","repository_head_tree":"2222222222222222222222222222222222222222"}}"#,
        "a".repeat(64),
        "b".repeat(64),
        "e".repeat(64),
        "f".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
    );
    assert!(serde_json::from_str::<ApprovedPlanV2BindingV1>(&binding_json(&subject)).is_ok());
}

#[test]
fn binding_is_closed_and_has_no_self_digest_or_legacy_source_kind_field() {
    let raw = binding_json("null");
    for forbidden in [
        ",\"binding_sha256\":\"forbidden\"",
        ",\"source_carrier_kind\":\"legacy-fixture\"",
    ] {
        let changed = raw.replace("\n    }", &format!("{forbidden}\n    }}"));
        assert!(
            serde_json::from_str::<ApprovedPlanV2BindingV1>(&changed).is_err(),
            "accepted forbidden field {forbidden}"
        );
    }
}
