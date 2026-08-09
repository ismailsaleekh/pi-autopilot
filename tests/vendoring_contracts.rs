use kernel::generated::{PackageCheckKind, PackageProofKindV2, WorkMap, WorkMapV2};
use serde_json::{Value, json};

fn v2(raw: &str) -> Result<WorkMapV2, serde_json::Error> {
    serde_json::from_str(raw)
}

fn schema(name: &str) -> Value {
    let generated = include_str!("../src/generated/tool-schemas.ts");
    let prefix = format!("export const {name} = ");
    serde_json::from_str(
        generated
            .split_once(&prefix)
            .expect("schema declaration")
            .1
            .split_once(" as TSchema;")
            .expect("schema terminator")
            .0,
    )
    .expect("schema JSON")
}

#[test]
fn v2_requires_explicit_package_scope_files() {
    let raw = r#"{"schema":"planning.work-map.v2","units":[{"id":"one","kind":"implementation","objective":"x","criteria":["x"],"depends_on":[],"files":["src/a.rs"],"commands":[],"package_proofs":[],"vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom"]}]}"#;
    assert!(v2(raw).is_err(), "missing package scope must not default");
}

#[test]
fn v2_shape_requires_explicit_empty_scope_and_remains_v1_isolated() {
    let raw = r#"{"schema":"planning.work-map.v2","units":[{"id":"one","kind":"implementation","objective":"x","criteria":["x"],"depends_on":[],"files":["src/a.rs"],"package_scope_files":[],"commands":[],"package_proofs":[],"vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom"]}]}"#;
    assert!(v2(raw).is_ok());
    assert!(serde_json::from_str::<WorkMap>(raw).is_err());
    let legacy = r#"{"units":[{"id":"one","kind":"implementation","objective":"x","criteria":["x"],"depends_on":[],"files":["src/a.rs"],"commands":[],"package_checks":[],"links":["atom"]}]}"#;
    assert!(serde_json::from_str::<WorkMap>(legacy).is_ok());
    assert!(v2(legacy).is_err());
}

#[test]
fn generated_schema_requires_scope_without_changing_v1_digests() {
    let v2 = schema("WORK_MAP_V2_CLOSED_TOOL_PARAMETERS");
    let unit = &v2["properties"]["units"]["items"];
    assert!(
        unit["required"]
            .as_array()
            .unwrap()
            .contains(&json!("package_scope_files"))
    );
    assert_eq!(unit["properties"]["package_scope_files"]["type"], "array");
    let generated = include_str!("../src/generated/tool-schemas.ts");
    for (name, digest) in [
        (
            "WORK_MAP_TOOL_SCHEMA_DIGEST",
            "f687b98000113e794d38368ebb55d903214d2cc25b3f4f5d3b0e578c6118e0b7",
        ),
        (
            "WORK_MAP_CLOSED_TOOL_SCHEMA_DIGEST",
            "b6b5f80aedcf8382f840f311bac4fdf1a6db5d83e0cf25eb46840e90043f8493",
        ),
    ] {
        assert!(generated.contains(&format!("export const {name} = \"{digest}\";")));
    }
}

#[test]
fn legacy_and_v2_proof_wires_are_isolated() {
    assert_eq!(
        serde_json::to_string(&PackageCheckKind::CleanExactPackageTip).unwrap(),
        "\"clean-exact-package-tip\""
    );
    assert!(serde_json::from_str::<PackageCheckKind>("\"vendored-bytes-match-origin\"").is_err());
    assert_eq!(
        serde_json::to_string(&PackageProofKindV2::VendoredBytesMatchOrigin).unwrap(),
        "\"vendored-bytes-match-origin\""
    );
}

#[test]
fn v2_serde_accepts_explicit_no_vendor_rows_and_extensionless_leaves() {
    let raw = r#"{"schema":"planning.work-map.v2","units":[{"id":"README","kind":"implementation","objective":"x","criteria":["x"],"depends_on":[],"files":["README"],"package_scope_files":[],"commands":[],"package_proofs":[],"vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom"]}]}"#;
    let parsed = v2(raw).unwrap();
    assert_eq!(parsed.units[0].files[0].0, "README");
    assert!(parsed.units[0].package_scope_files.is_empty());
    assert!(parsed.units[0].vendor_bindings.is_empty());
    assert!(parsed.units[0].provenance_manifest_destination.0.is_none());
}

#[test]
fn v2_serde_rejects_required_unknown_null_and_proof_shape_mutations() {
    let base = r#"{"schema":"planning.work-map.v2","units":[{"id":"one","kind":"implementation","objective":"x","criteria":["x"],"depends_on":[],"files":["a"],"package_scope_files":[],"commands":[],"package_proofs":[],"vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom"]}]}"#;
    for field in [
        "schema",
        "package_scope_files",
        "package_proofs",
        "vendor_bindings",
        "provenance_manifest_destination",
    ] {
        let mut value: Value = serde_json::from_str(base).unwrap();
        if field == "schema" {
            value.as_object_mut().unwrap().remove(field);
        } else {
            value["units"][0].as_object_mut().unwrap().remove(field);
        }
        assert!(
            serde_json::from_value::<WorkMapV2>(value).is_err(),
            "missing {field}"
        );
    }
    let mut unknown: Value = serde_json::from_str(base).unwrap();
    unknown["units"][0]["extra"] = json!(true);
    assert!(serde_json::from_value::<WorkMapV2>(unknown).is_err());
    let mut null: Value = serde_json::from_str(base).unwrap();
    null["units"][0]["package_scope_files"] = Value::Null;
    assert!(serde_json::from_value::<WorkMapV2>(null).is_err());
    let mut kind: Value = serde_json::from_str(base).unwrap();
    kind["units"][0]["package_proofs"] = json!([{"proof_id":"p","kind":"unknown","criterion_ordinals":[1],"expected":"x","vendor_binding_ids":[]}]);
    assert!(serde_json::from_value::<WorkMapV2>(kind).is_err());
}

#[test]
fn v1_work_map_keeps_closed_plan_unit_unknown_behavior_while_v2_isolated() {
    let legacy_some = r#"{"units":[{"id":"one","kind":"implementation","objective":"x","criteria":["x"],"depends_on":[],"files":["a"],"commands":[],"package_checks":[],"links":["atom"],"historical_unknown":true}]}"#;
    let legacy_none = r#"{"units":[{"id":"one","kind":"implementation","objective":"x","criteria":["x"],"depends_on":[],"files":["a"],"commands":[],"package_checks":[],"links":["atom"]}]}"#;
    assert!(
        serde_json::from_str::<WorkMap>(legacy_some).is_err(),
        "V1 historical closed parser behavior"
    );
    assert!(serde_json::from_str::<WorkMap>(legacy_none).is_ok());
    assert!(serde_json::from_str::<WorkMapV2>(legacy_none).is_err());
}

#[test]
fn v2_schema_bounds_and_closed_package_scope_are_generated() {
    let v2 = schema("WORK_MAP_V2_CLOSED_TOOL_PARAMETERS");
    let unit = &v2["properties"]["units"]["items"];
    assert_eq!(v2["additionalProperties"], json!(false));
    assert_eq!(v2["properties"]["units"]["maxItems"], json!(256));
    assert_eq!(
        unit["properties"]["package_scope_files"]["maxItems"],
        json!(256)
    );
    assert_eq!(unit["properties"]["package_proofs"]["maxItems"], json!(256));
    assert_eq!(
        unit["properties"]["vendor_bindings"]["maxItems"],
        json!(128)
    );
    assert_eq!(
        unit["properties"]["provenance_manifest_destination"]["anyOf"][1]["type"],
        json!("null")
    );
}

#[test]
fn v1_v2_schema_digests_and_terminal_profile_tuples_are_exact() {
    const V1_OPEN: &str = "f687b98000113e794d38368ebb55d903214d2cc25b3f4f5d3b0e578c6118e0b7";
    const V1_CLOSED: &str = "b6b5f80aedcf8382f840f311bac4fdf1a6db5d83e0cf25eb46840e90043f8493";
    const V2_OPEN: &str = "07750be5a58112e8b3f956f261d33ef75e3a71b9b13b75be2192cfc43adbbc9a";
    const V2_CLOSED: &str = "3efc6b230002a7216a3e471441a755672f2a750658483e7882b1fa3edb549495";
    let generated = include_str!("../src/generated/tool-schemas.ts");
    for (name, digest) in [
        ("WORK_MAP_TOOL_SCHEMA_DIGEST", V1_OPEN),
        ("WORK_MAP_CLOSED_TOOL_SCHEMA_DIGEST", V1_CLOSED),
        ("WORK_MAP_V2_TOOL_SCHEMA_DIGEST", V2_OPEN),
        ("WORK_MAP_V2_CLOSED_TOOL_SCHEMA_DIGEST", V2_CLOSED),
    ] {
        assert!(
            generated.contains(&format!("export const {name} = \"{digest}\";")),
            "missing {name}"
        );
    }
    let actual = kernel::generated::TERMINAL_PROFILES
        .iter()
        .filter(|(id, ..)| {
            matches!(
                *id,
                "planning.work-map.v1:autopilot_submit_plan_cluster"
                    | "planning.work-map.v1:autopilot_submit_synthesis"
                    | "recovery-work-map.v1"
                    | "planning.work-map.v2:autopilot_submit_plan_cluster"
                    | "planning.work-map.v2:autopilot_submit_synthesis"
                    | "recovery-work-map.v2"
            )
        })
        .copied()
        .collect::<Vec<_>>();
    assert_eq!(
        actual,
        vec![
            (
                "planning.work-map.v1:autopilot_submit_plan_cluster",
                "autopilot_submit_plan_cluster",
                "planning.work-map.v1",
                "planning.work-map.v1",
                V1_OPEN,
            ),
            (
                "planning.work-map.v1:autopilot_submit_synthesis",
                "autopilot_submit_synthesis",
                "planning.work-map.v1",
                "planning.work-map.v1",
                V1_OPEN,
            ),
            (
                "planning.work-map.v2:autopilot_submit_plan_cluster",
                "autopilot_submit_plan_cluster",
                "planning.work-map.v2",
                "planning.work-map.v2",
                V2_OPEN,
            ),
            (
                "planning.work-map.v2:autopilot_submit_synthesis",
                "autopilot_submit_synthesis",
                "planning.work-map.v2",
                "planning.work-map.v2",
                V2_OPEN,
            ),
            (
                "recovery-work-map.v1",
                "autopilot_emit_status",
                "planning.work-map.v1",
                "planning.work-map.v1",
                V1_CLOSED,
            ),
            (
                "recovery-work-map.v2",
                "autopilot_emit_status",
                "planning.work-map.v2",
                "planning.work-map.v2",
                V2_CLOSED,
            ),
        ]
    );
}

#[test]
fn proof_ordinals_and_binding_relations_remain_numeric_not_legacy_checks() {
    let raw = r#"{"schema":"planning.work-map.v2","units":[{"id":"one","kind":"implementation","objective":"x","criteria":["one","two"],"depends_on":[],"files":["a"],"package_scope_files":["a"],"commands":[],"package_proofs":[{"proof_id":"p","kind":"clean-exact-package-tip","criterion_ordinals":[2,1],"expected":"x","vendor_binding_ids":[]}],"vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom"]}]}"#;
    let map = v2(raw).unwrap();
    assert_eq!(
        map.units[0].package_proofs[0].criterion_ordinals,
        vec![2, 1]
    );
    assert!(serde_json::from_str::<WorkMap>(raw).is_err());
}
