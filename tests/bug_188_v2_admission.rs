//! Regression coverage for the clean WorkMap V2 admission wire.
//!
//! Repository snapshot authority used to live in this target. The remaining
//! cases retain its non-repository contract coverage: exact vendor rows, path
//! safety, ownership, package-proof closure, and closed wire behavior.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use drivers::allocation::{
    ApprovedPackageProofV2, ApprovedUnit, ApprovedUnitPackageAuthorityV2, ApprovedUnitVendoringV2,
    ApprovedVendorBindingV2, validate_approved_v2_authority,
};
use drivers::planning::{self, WorkMapV2AdmissionContext};
use drivers::runner;
use drivers::seam;
use kernel::generated::{
    AgentRunSpec, ContractId, Digest as ContractDigest, Id, ModeId, PackageProofKindV2,
    Path as ContractPath, PlanUnitCommand, PlanUnitKind, PlanningAtomKind,
    PlanningAtomRegistryAtom, Ref, SchemaId, SessionContinuity, TerminalRoute, ThinkingLevel,
    ToolName, ValidationAssignmentKind,
};
use sha2::{Digest, Sha256};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn command() -> PlanUnitCommand {
    serde_json::from_value(serde_json::json!({
        "command":"true", "expected":"passes", "effect":"no-effect",
        "generated_paths":[], "handling":"none", "scope_preservation":"none"
    }))
    .unwrap()
}

fn unit(files: &[&str]) -> ApprovedUnit {
    ApprovedUnit {
        id: Id("U1".into()),
        kind: PlanUnitKind::Implementation,
        objective: "exact leaves".into(),
        operator_order: 1,
        decisions: vec![Id("atom-1".into())],
        criteria: vec![Id("AC-U1-1".into())],
        criterion_text: vec![drivers::allocation::ApprovedCriterion {
            id: Id("AC-U1-1".into()),
            text: "exact closure".into(),
        }],
        dependencies: vec![],
        predecessor_forward_criteria: vec![],
        downstream_release_edges: vec![Id("unit:U1".into())],
        files: files
            .iter()
            .map(|path| ContractPath((*path).into()))
            .collect(),
        commands: vec![command()],
        package_checks: vec![],
    }
}

fn rows() -> (
    Vec<ApprovedUnitVendoringV2>,
    Vec<ApprovedUnitPackageAuthorityV2>,
) {
    (
        vec![ApprovedUnitVendoringV2 {
            unit_id: Id("U1".into()),
            provenance_manifest_destination: Some(ContractPath("vendor/provenance.tsv".into())),
            vendor_bindings: vec![ApprovedVendorBindingV2 {
                binding_id: Id("binding-1".into()),
                origin_path: ContractPath("upstream/source.bin".into()),
                destination: ContractPath("vendor/source.bin".into()),
            }],
        }],
        vec![ApprovedUnitPackageAuthorityV2 {
            unit_id: Id("U1".into()),
            package_scope_files: vec![
                ContractPath("src/authored.rs".into()),
                ContractPath("vendor/provenance.tsv".into()),
                ContractPath("vendor/source.bin".into()),
            ],
            package_proofs: vec![
                ApprovedPackageProofV2 {
                    proof_id: Id("clean".into()),
                    kind: PackageProofKindV2::CleanExactPackageTip,
                    criterion_ordinals: vec![1],
                    expected: "clean package".into(),
                    vendor_binding_ids: vec![],
                },
                ApprovedPackageProofV2 {
                    proof_id: Id("vendor".into()),
                    kind: PackageProofKindV2::VendoredBytesMatchOrigin,
                    criterion_ordinals: vec![1],
                    expected: "baseline bytes".into(),
                    vendor_binding_ids: vec![Id("binding-1".into())],
                },
            ],
        }],
    )
}

#[test]
fn vendor_binding_wire_has_exactly_id_origin_and_destination() {
    let raw = r#"{"binding_id":"binding-1","origin_path":"upstream/source.bin","destination":"vendor/source.bin"}"#;
    let binding: ApprovedVendorBindingV2 = serde_json::from_str(raw).unwrap();
    assert_eq!(binding.binding_id.0, "binding-1");
    let mut value: serde_json::Value = serde_json::from_str(raw).unwrap();
    value["legacy_field"] = serde_json::json!("removed");
    assert!(serde_json::from_value::<ApprovedVendorBindingV2>(value).is_err());
}

#[test]
fn clean_v2_authority_preserves_exact_paths_ownership_and_proof_closure() {
    let unit = unit(&[
        "src/authored.rs",
        "vendor/provenance.tsv",
        "vendor/source.bin",
    ]);
    let (vendoring, package) = rows();
    validate_approved_v2_authority(&[unit.clone()], &vendoring, &package).unwrap();

    let mut colliding = unit.clone();
    colliding.files.push(ContractPath("vendor".into()));
    assert!(validate_approved_v2_authority(&[colliding], &vendoring, &package).is_err());

    let mut unsafe_origin = vendoring.clone();
    unsafe_origin[0].vendor_bindings[0].origin_path = ContractPath("../outside".into());
    assert!(validate_approved_v2_authority(&[unit.clone()], &unsafe_origin, &package).is_err());

    let mut incomplete = package.clone();
    incomplete[0].package_proofs[1].vendor_binding_ids.clear();
    assert!(validate_approved_v2_authority(&[unit], &vendoring, &incomplete).is_err());
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn fixture_root() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/bug188-v2-admission-audit")
        .join(format!(
            "fixture-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    fs::create_dir_all(&root).expect("fixture root");
    fs::canonicalize(root).expect("canonical fixture root")
}

fn atoms(root: &Path) -> (PathBuf, String) {
    let bytes = planning::atom_registry_bytes(
        "audit",
        "audit-authority",
        vec![Id("producer".to_owned())],
        vec![
            PlanningAtomRegistryAtom {
                id: Id("atom-1".to_owned()),
                producer_assignment_id: Id("producer".to_owned()),
                kind: PlanningAtomKind::Work,
                text: "first exact task atom".to_owned(),
                sources: vec![Ref("task:one".to_owned())],
            },
            PlanningAtomRegistryAtom {
                id: Id("atom-2".to_owned()),
                producer_assignment_id: Id("producer".to_owned()),
                kind: PlanningAtomKind::Work,
                text: "second exact task atom".to_owned(),
                sources: vec![Ref("task:two".to_owned())],
            },
        ],
    )
    .expect("atom registry bytes");
    let path = root.join(".pi/autopilot/audit/planning/atoms.json");
    fs::create_dir_all(path.parent().expect("atom parent")).expect("atom parent");
    fs::write(&path, &bytes).expect("atom registry");
    (path, sha(&bytes))
}

fn actual_carrier(root: &Path, label: &str, raw_output: &str) -> PathBuf {
    let (atom_path, atom_digest) = atoms(root);
    let assignment_id = Id(format!("audit-{label}"));
    let paths = runner::planning_paths(root, "audit", &assignment_id);
    for path in [&paths.carrier_path, &paths.spec_path, &paths.prompt_path] {
        fs::create_dir_all(path.parent().expect("carrier parent")).expect("carrier parent");
    }
    fs::write(&paths.prompt_path, "strict V2 audit fixture\n").expect("prompt");
    let route = TerminalRoute {
        version: "v2".to_owned(),
        profile_id: "planning.work-map.v2:autopilot_submit_synthesis".to_owned(),
        tool_name: ToolName("autopilot_submit_synthesis".to_owned()),
        boundary_id: ContractId("planning.work-map.v2".to_owned()),
        result_contract: ContractId("planning.work-map.v2".to_owned()),
        schema_digest: ContractDigest(
            "4f341cc4aade90ac13c4584898f29b42d054d4ea4b5c126117841550e680ae75".to_owned(),
        ),
    };
    let spec = AgentRunSpec {
        schema: SchemaId("autopilot.agent_run_spec.v4".to_owned()),
        assignment_kind: ValidationAssignmentKind::PlanningReview,
        action_id: Id(format!("action-{}", assignment_id.0)),
        assignment_id: assignment_id.clone(),
        run_id: Id("audit-run".to_owned()),
        run_revision: 1,
        workstream: Id("audit".to_owned()),
        role_id: Id("plan-synthesizer".to_owned()),
        mode: ModeId("initial-plan".to_owned()),
        provider: "fixture".to_owned(),
        model: "fixture".to_owned(),
        thinking: ThinkingLevel("low".to_owned()),
        route: "fixture".to_owned(),
        cwd: ContractPath(root.display().to_string()),
        allowed_tools: vec![route.tool_name.clone()],
        spec_path: ContractPath(paths.spec_path.display().to_string()),
        prompt_path: ContractPath(paths.prompt_path.display().to_string()),
        prompt_digest: ContractDigest("a".repeat(64)),
        boundary_id: ContractId("planning.work-map.v2".to_owned()),
        boundary_digest: ContractDigest("b".repeat(64)),
        result_contract: ContractId("planning.work-map.v2".to_owned()),
        result_contract_digest: ContractDigest("c".repeat(64)),
        carrier_path: ContractPath(paths.carrier_path.display().to_string()),
        session_id: Id("audit-session".to_owned()),
        session_dir: ContractPath(
            root.join(".pi/autopilot/audit/sessions")
                .display()
                .to_string(),
        ),
        session_continuity: SessionContinuity::Fresh,
        settings_digest: ContractDigest("d".repeat(64)),
        context_digest: ContractDigest("e".repeat(64)),
        skills_digest: ContractDigest("f".repeat(64)),
        subscription_digest: ContractDigest("0".repeat(64)),
        lane_id: None,
        attempt: None,
        base_commit: None,
        worktree: None,
        required_focused_evidence: None,
        authority_set_id: None,
        authority_documents: None,
        context_document: None,
        context_documents: None,
        assignment_path: None,
        assignment_digest: None,
        context_manifest_path: None,
        context_manifest_digest: None,
        runtime_extension_path: Some(ContractPath(
            root.join(".pi/autopilot/audit/addon.ts")
                .display()
                .to_string(),
        )),
        runtime_extension_digest: Some(ContractDigest(
            kernel::generated::CHILD_ADDON_DIGEST.to_owned(),
        )),
        terminal_profile_id: Some(route.profile_id.clone()),
        terminal_route: Some(route.clone()),
        unavailable_tools: None,
        producer_assignment_ids: None,
        validation_id: None,
        validation_attempt: None,
        semantic_round: None,
        model_submission_path: None,
        atom_id_prefix: None,
        atom_registry_path: Some(ContractPath(atom_path.display().to_string())),
        atom_registry_digest: Some(ContractDigest(atom_digest.clone())),
        planning_inputs_path: None,
        planning_inputs_digest: None,
    };
    let spec_bytes = serde_json::to_vec(&spec).expect("spec bytes");
    fs::write(&paths.spec_path, &spec_bytes).expect("spec");
    let carrier = serde_json::json!({
        "schema":"autopilot.planning_carrier.v2",
        "action_id":spec.action_id.0,"assignment_id":assignment_id.0,"run_revision":1,
        "workstream":"audit","role_id":"plan-synthesizer","mode":"initial-plan",
        "boundary_id":"planning.work-map.v2","result_contract":"planning.work-map.v2",
        "prompt_path":paths.prompt_path,"prompt_digest":"a".repeat(64),
        "boundary_digest":"b".repeat(64),"result_contract_digest":"c".repeat(64),
        "settings_digest":"d".repeat(64),"context_digest":"e".repeat(64),
        "skills_digest":"f".repeat(64),"subscription_digest":"0".repeat(64),
        "runtime_extension_digest":kernel::generated::CHILD_ADDON_DIGEST,
        "spec_digest":sha(&spec_bytes),"spec_path":paths.spec_path,"carrier_path":paths.carrier_path,
        "carrier_channel":"tool","tool_name":route.tool_name.0,"tool_schema_digest":route.schema_digest.0,
        "carrier_binding":runner::child::carrier_binding(&spec),"pi_version":"pi test-only 0.84.1",
        "terminal_route":route,"atom_registry_path":atom_path,"atom_registry_digest":atom_digest,
        "raw_output":raw_output,
    });
    fs::write(
        &paths.carrier_path,
        serde_json::to_vec(&carrier).expect("carrier bytes"),
    )
    .expect("carrier");
    paths.carrier_path
}

fn admit_actual(
    root: &Path,
    label: &str,
    raw: &str,
    subject: Option<&planning::ApprovedWorkMapV2>,
) -> Result<planning::ApprovedWorkMapV2, String> {
    let carrier = actual_carrier(root, label, raw);
    let (atom_path, atom_digest) = atoms(root);
    planning::work_map_v2::admit_work_map_v2_actual_carrier_for_test_only(
        &carrier,
        WorkMapV2AdmissionContext {
            atom_registry_path: &atom_path,
            atom_registry_digest: &atom_digest,
            recovery_subject: subject,
        },
    )
}

fn v2_command() -> serde_json::Value {
    serde_json::json!({
        "command":"true","expected":"passes","effect":"no-effect",
        "generated_paths":[],"handling":"none","scope_preservation":"final scope is exact"
    })
}

fn simple_work_map() -> serde_json::Value {
    serde_json::json!({"schema":"planning.work-map.v2","units":[{
        "id":"unit-a","kind":"implementation","objective":"author one exact leaf",
        "criteria":["leaf is correct"],"depends_on":[],"files":["src/a.rs"],
        "package_scope_files":[],"commands":[v2_command()],"package_proofs":[],
        "vendor_bindings":[],"provenance_manifest_destination":null,"links":["atom-1"]
    }]})
}

fn vendor_work_map() -> serde_json::Value {
    serde_json::json!({"schema":"planning.work-map.v2","units":[{
        "id":"unit-a","kind":"implementation","objective":"materialize an exact source",
        "criteria":["bytes and package proof are exact"],"depends_on":[],
        "files":["manifests/provenance.tsv","src/a.rs","vendor/a.bin"],
        "package_scope_files":["manifests/provenance.tsv","src/a.rs","vendor/a.bin"],
        "commands":[v2_command()],
        "package_proofs":[
          {"proof_id":"clean","kind":"clean-exact-package-tip","criterion_ordinals":[1],"expected":"clean","vendor_binding_ids":[]},
          {"proof_id":"vendor","kind":"vendored-bytes-match-origin","criterion_ordinals":[1],"expected":"bytes","vendor_binding_ids":["binding-a"]}
        ],
        "vendor_bindings":[{"binding_id":"binding-a","origin_path":"upstream/a.bin","destination":"vendor/a.bin"}],
        "provenance_manifest_destination":"manifests/provenance.tsv","links":["atom-1"]
    }]})
}

#[test]
fn v2_admission_keeps_exact_path_binding_and_closure_rejections() {
    let root = fixture_root();
    let valid = vendor_work_map();
    assert!(admit_actual(&root, "valid", &valid.to_string(), None).is_ok());

    for (label, mutate) in [
        (
            "glob",
            Box::new(|value: &mut serde_json::Value| {
                value["units"][0]["files"]
                    .as_array_mut()
                    .expect("files")
                    .push(serde_json::json!("vendor/**"));
            }) as Box<dyn Fn(&mut serde_json::Value)>,
        ),
        (
            "directory",
            Box::new(|value: &mut serde_json::Value| {
                value["units"][0]["files"]
                    .as_array_mut()
                    .expect("files")
                    .push(serde_json::json!("vendor/"));
            }),
        ),
        (
            "ancestor",
            Box::new(|value: &mut serde_json::Value| {
                value["units"][0]["files"]
                    .as_array_mut()
                    .expect("files")
                    .push(serde_json::json!("vendor"));
            }),
        ),
        (
            "source-destination-collision",
            Box::new(|value: &mut serde_json::Value| {
                value["units"][0]["vendor_bindings"][0]["destination"] =
                    serde_json::json!("upstream/a.bin");
                value["units"][0]["files"] =
                    serde_json::json!(["manifests/provenance.tsv", "src/a.rs", "upstream/a.bin"]);
                value["units"][0]["package_scope_files"] = value["units"][0]["files"].clone();
            }),
        ),
        (
            "duplicate-binding-id",
            Box::new(|value: &mut serde_json::Value| {
                let duplicate = value["units"][0]["vendor_bindings"][0].clone();
                value["units"][0]["vendor_bindings"]
                    .as_array_mut()
                    .expect("bindings")
                    .push(duplicate);
            }),
        ),
        (
            "incomplete-closure",
            Box::new(|value: &mut serde_json::Value| {
                value["units"][0]["package_scope_files"] = serde_json::json!(["src/a.rs"])
            }),
        ),
    ] {
        let mut candidate = valid.clone();
        mutate(&mut candidate);
        assert!(
            admit_actual(
                &root,
                &format!("reject-{label}"),
                &candidate.to_string(),
                None
            )
            .is_err(),
            "{label} must not widen V2 authority"
        );
    }
}

#[test]
fn v2_recovery_freezes_every_nonobjective_authority_field() {
    let root = fixture_root();
    let original_raw = simple_work_map();
    let original = admit_actual(&root, "recovery-original", &original_raw.to_string(), None)
        .expect("ordinary subject");
    let mut repaired = original_raw.clone();
    repaired["units"][0]["objective"] = serde_json::json!("correct only the objective");
    repaired["recovery"] = serde_json::json!({
        "disposition":"repaired","diagnosis_refs":["review:1"],"root_cause":"objective",
        "affected_unit_ids":["unit-a"],"actions":["correct objective"],
        "preserved_authority":["all non-objective fields"],"repair_evidence_refs":["evidence:1"]
    });
    assert!(
        admit_actual(
            &root,
            "recovery-good",
            &repaired.to_string(),
            Some(&original)
        )
        .is_ok()
    );

    for (label, mutate) in [
        (
            "criteria",
            Box::new(|value: &mut serde_json::Value| {
                value["units"][0]["criteria"] = serde_json::json!(["changed"])
            }) as Box<dyn Fn(&mut serde_json::Value)>,
        ),
        (
            "links",
            Box::new(|value: &mut serde_json::Value| {
                value["units"][0]["links"] = serde_json::json!(["atom-2"])
            }),
        ),
        (
            "files",
            Box::new(|value: &mut serde_json::Value| {
                value["units"][0]["files"] = serde_json::json!(["src/changed.rs"])
            }),
        ),
        (
            "commands",
            Box::new(|value: &mut serde_json::Value| {
                value["units"][0]["commands"][0]["expected"] = serde_json::json!("changed")
            }),
        ),
    ] {
        let mut candidate = repaired.clone();
        mutate(&mut candidate);
        let error = admit_actual(
            &root,
            &format!("recovery-{label}"),
            &candidate.to_string(),
            Some(&original),
        )
        .expect_err("nonobjective recovery mutation");
        assert!(
            error.contains("recovery changed non-objective"),
            "{label}: {error}"
        );
    }

    let mut blocked = repaired;
    blocked["recovery"]["disposition"] = serde_json::json!("unsafe-blocked");
    let error = admit_actual(
        &root,
        "recovery-blocked",
        &blocked.to_string(),
        Some(&original),
    )
    .expect_err("blocked recovery cannot change objective");
    assert!(error.contains("disposition does not match"), "{error}");
}

#[test]
fn v2_approved_binding_is_create_once_and_semantic_replay_kills_tampering() {
    let root = fixture_root();
    let raw = simple_work_map().to_string();
    let admitted = admit_actual(&root, "promotion", &raw, None).expect("strict admission");
    let image = root.join(".pi/autopilot/audit/approved-plan.v2.json");
    let binding = root.join(".pi/autopilot/audit/approved-plan.v2-binding.json");
    let promotion =
        seam::write_approved_plan_v2_for_test_only("audit", &image, &binding, &admitted)
            .expect("first promotion");
    assert!(seam::read_approved_plan_v2(&binding, &promotion.binding_sha256).is_ok());
    assert!(
        seam::write_approved_plan_v2_for_test_only("audit", &image, &binding, &admitted).is_ok(),
        "identical create-once replay is idempotent"
    );

    let other = admit_actual(
        &root,
        "promotion-other",
        &simple_work_map()
            .to_string()
            .replace("author one exact leaf", "other exact objective"),
        None,
    )
    .expect("other strict admission");
    assert!(
        seam::write_approved_plan_v2_for_test_only("audit", &image, &binding, &other).is_err(),
        "different image cannot replace an approved create-once root"
    );

    let mut image_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&image).expect("image bytes")).expect("image JSON");
    image_value["units"][0]["objective"] = serde_json::json!("semantic replacement");
    let image_bytes = drivers::evidence::canonical_json(&image_value).expect("canonical image");
    fs::write(&image, &image_bytes).expect("tampered image");
    let mut binding_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding).expect("binding bytes")).expect("binding JSON");
    binding_value["approved_plan_sha256"] = serde_json::json!(sha(&image_bytes));
    let binding_bytes =
        drivers::evidence::canonical_json(&binding_value).expect("canonical binding");
    fs::write(&binding, &binding_bytes).expect("rebound binding");
    let error = seam::read_approved_plan_v2(&binding, &sha(&binding_bytes))
        .expect_err("fresh outer digests cannot bless semantic image tampering");
    assert!(
        error.contains("does not exactly equal strict source admission"),
        "{error}"
    );
}

#[cfg(unix)]
#[test]
fn v2_authority_readers_refuse_hostile_final_symlinks() {
    use std::os::unix::fs::symlink;

    let root = fixture_root();
    let target = root.join("target.json");
    let payload = serde_json::json!({
        "schema":"autopilot.work_map_v2_source_carrier.v1",
        "boundary":"planning.work-map.v2",
        "result_contract":"planning.work-map.v2",
        "raw_work_map_payload":simple_work_map().to_string(),
    });
    fs::write(
        &target,
        serde_json::to_vec(&payload).expect("source carrier bytes"),
    )
    .expect("source carrier target");
    let alias = root.join("source-link.json");
    symlink(&target, &alias).expect("source carrier symlink");
    assert!(
        planning::read_work_map_v2_source_carrier(&alias).is_err(),
        "V2 source readers must refuse a final symlink before parsing payload bytes"
    );
}
