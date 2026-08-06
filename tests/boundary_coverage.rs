use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use drivers::planning::{
    ATOM_REGISTRY_MAX_BYTES, MODEL_BOUNDARIES, accept_plan_review, accept_questions,
    accept_scout_dossier, accept_task_atoms, accept_work_map, accept_work_map_for_atoms,
    boundary_runtime,
};
use drivers::transcript::{
    BoundaryModeTable, TranscriptProvenance, TranscriptRecord, TranscriptStore,
};
use kernel::{
    boundary::{
        BOUNDARIES, BoundaryDescriptor, BoundaryMode, BoundaryRuntime, Producer, Rejection,
    },
    generated::Id,
};
use sha2::{Digest as ShaDigest, Sha256};

static BOUNDARY_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn model_boundaries_are_enforced_or_loudly_reported_in_record_phase() {
    let table = mode_table();
    let root = transcript_root();
    if let Err(error) = validate_transcript_root(&root) {
        panic!("{error}");
    }
    let store = TranscriptStore::new(&root);
    let mut record_mode = Vec::new();
    let mut missing = Vec::new();
    let model_boundaries = model_boundaries();

    for expected in MODEL_BOUNDARIES {
        if !model_boundaries
            .iter()
            .any(|descriptor| descriptor.id() == expected)
        {
            panic!("planning model boundary {expected} is not registered");
        }
    }

    for descriptor in model_boundaries {
        match table.mode(descriptor.id()) {
            Ok(BoundaryMode::Record) => record_mode.push(descriptor.id()),
            Ok(BoundaryMode::Enforce) => match store.load_boundary(descriptor.id()) {
                Ok(records) if !records.is_empty() => replay_records(descriptor.id(), &records),
                Ok(_) => missing.push(descriptor.id()),
                Err(error) => panic!("bad transcript for {}: {error:?}", descriptor.id()),
            },
            Err(error) => panic!(
                "boundary mode table failed for {}: {error:?}",
                descriptor.id()
            ),
        }
    }

    if !missing.is_empty() {
        panic!(
            "enforced Model boundaries missing real transcripts: {}",
            missing.join(", ")
        );
    }
    if !record_mode.is_empty() {
        eprintln!(
            "RECORD MODE Model boundaries needing live transcripts: {}",
            record_mode.join(", ")
        );
        let phase = std::env::var_os("AUTOPILOT_TRANSCRIPT_PHASE");
        assert_eq!(
            phase.as_deref().and_then(|value| value.to_str()),
            Some("record")
        );
    }
}

#[test]
fn boundary_coverage() {
    model_boundaries_are_enforced_or_loudly_reported_in_record_phase();
}

#[test]
fn provenance_less_fixture_is_rejected() {
    let fixture = TranscriptRecord {
        schema: "autopilot.transcript.v1".to_owned(),
        boundary_id: "planning.task-atoms.v1".to_owned(),
        raw_output: "hand authored atom".to_owned(),
        provenance: None,
    };
    assert!(fixture.validate_real().is_err());

    let blank_session = TranscriptRecord::real(
        "planning.task-atoms.v1",
        "hand authored atom",
        TranscriptProvenance {
            provider: "openai-codex".to_owned(),
            model: "gpt-live".to_owned(),
            thinking: "high".to_owned(),
            session_id: " ".to_owned(),
        },
    );
    assert!(blank_session.validate_real().is_err());
}

#[test]
fn missing_transcript_root_is_reported_as_root_failure() {
    let missing_root = transcript_root().join("__missing_transcript_root_for_negative_check__");
    let error = match validate_transcript_root(&missing_root) {
        Ok(()) => panic!("{} unexpectedly exists", missing_root.display()),
        Err(error) => error,
    };
    assert_eq!(
        error,
        format!("transcript root missing: {}", missing_root.display())
    );
}

fn mode_table() -> BoundaryModeTable {
    match BoundaryModeTable::parse(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../data/boundary-modes.kdl"
    ))) {
        Ok(value) => value,
        Err(error) => panic!("boundary mode parse failed: {error:?}"),
    }
}

fn transcript_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/transcripts")
}

#[test]
fn plan_review_approval_requires_the_complete_exact_all_pass_set() {
    let mut runtime = boundary_runtime("planning.plan-review.v1");
    runtime.flip_to_enforce();
    let one_pass = serde_json::json!({"verdicts":[{"criterion_id":"review.mandatory-input-accounting","verdict":"pass"}]}).to_string();
    assert!(
        accept_plan_review(&one_pass, &runtime).is_err(),
        "incomplete review must be repaired at the child boundary before parent adjudication"
    );
    assert!(drivers::seam::review_approves_execution(&one_pass).is_err());
    let duplicate = serde_json::json!({"verdicts": [
        {"criterion_id":"review.mandatory-input-accounting","verdict":"pass"},
        {"criterion_id":"review.mandatory-input-accounting","verdict":"pass"},
        {"criterion_id":"review.authority-fidelity","verdict":"pass"},
        {"criterion_id":"review.completeness-and-traceability","verdict":"pass"},
        {"criterion_id":"review.internal-consistency-and-scheduling","verdict":"pass"},
        {"criterion_id":"review.context-sufficiency","verdict":"pass"},
        {"criterion_id":"review.verification-strength","verdict":"pass"},
        {"criterion_id":"review.forward-validation","verdict":"pass"}
    ]})
    .to_string();
    assert!(drivers::seam::review_approves_execution(&duplicate).is_err());
    let all_pass = serde_json::json!({"verdicts": drivers::seam::REQUIRED_PLAN_REVIEW_CRITERIA.iter().map(|criterion| serde_json::json!({"criterion_id": criterion, "verdict": "pass"})).collect::<Vec<_>>()}).to_string();
    accept_plan_review(&all_pass, &runtime).expect("complete review shape accepted");
    drivers::seam::review_approves_execution(&all_pass).expect("complete all-pass review approves");
    let blocked = serde_json::json!({"verdicts": drivers::seam::REQUIRED_PLAN_REVIEW_CRITERIA.iter().map(|criterion| serde_json::json!({"criterion_id": criterion, "verdict": if *criterion == "review.context-sufficiency" { "blocked" } else { "pass" }})).collect::<Vec<_>>()}).to_string();
    accept_plan_review(&blocked, &runtime)
        .expect("complete blocked review shape must reach parent adjudication");
    assert!(drivers::seam::review_approves_execution(&blocked).is_err());
}

#[test]
fn required_plan_review_criteria_are_exposed_exactly_once_in_contract_text() {
    let admits = kernel::generated::PLAN_REVIEW_ADMITS;
    for criterion in drivers::seam::REQUIRED_PLAN_REVIEW_CRITERIA {
        assert!(
            admits.contains(criterion),
            "missing {criterion} from admits: {admits}"
        );
        assert_eq!(
            admits.matches(criterion).count(),
            1,
            "duplicate {criterion} in admits: {admits}"
        );
    }
    assert_eq!(
        admits.matches("review.").count(),
        drivers::seam::REQUIRED_PLAN_REVIEW_CRITERIA.len()
    );
}

#[test]
fn replay_gate_rejects_malformed_work_map() {
    let raw =
        "### unit\n- **id:** U1\n- **objective:** Do it.\n- **acceptance criteria:**\n  - tested\n";
    let mut runtime = boundary_runtime("planning.work-map.v1");
    runtime.flip_to_enforce();
    let rejection = match accept_work_map(raw, &runtime) {
        Ok(value) => panic!("untraceable work map admitted: {value}"),
        Err(value) => value,
    };
    assert_eq!(rejection.boundary_id(), "planning.work-map.v1");
}

#[test]
fn work_map_boundary_rejects_non_delivery_kinds_and_empty_scope_or_commands() {
    let mut runtime = boundary_runtime("planning.work-map.v1");
    runtime.flip_to_enforce();
    for (label, raw) in [
        (
            "context gate kind",
            serde_json::json!({"units":[{"id":"U1","kind":"context-gate","objective":"ctx","criteria":["c"],"depends_on":[],"files":["src/lib.rs"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"links":["W1"]}]}).to_string(),
        ),
        (
            "verification kind",
            serde_json::json!({"units":[{"id":"U1","kind":"verification","objective":"verify","criteria":["c"],"depends_on":[],"files":["src/lib.rs"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"links":["W1"]}]}).to_string(),
        ),
        (
            "missing files",
            serde_json::json!({"units":[{"id":"U1","kind":"implementation","objective":"impl","criteria":["c"],"depends_on":[],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"links":["W1"]}]}).to_string(),
        ),
        (
            "absolute file",
            serde_json::json!({"units":[{"id":"U1","kind":"implementation","objective":"impl","criteria":["c"],"depends_on":[],"files":["/tmp/escape"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"links":["W1"]}]}).to_string(),
        ),
        (
            "parent file",
            serde_json::json!({"units":[{"id":"U1","kind":"implementation","objective":"impl","criteria":["c"],"depends_on":[],"files":["../escape"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"links":["W1"]}]}).to_string(),
        ),
        (
            "duplicate files",
            serde_json::json!({"units":[{"id":"U1","kind":"implementation","objective":"impl","criteria":["c"],"depends_on":[],"files":["src/lib.rs","src/lib.rs"],"commands":[{"command":"cargo test -q","expected":"pass","effect":"no-effect","generated_paths":[],"handling":"none","scope_preservation":"Final Git-visible state remains limited to the approved unit files."}],"links":["W1"]}]}).to_string(),
        ),
        (
            "empty commands",
            serde_json::json!({"units":[{"id":"U1","kind":"implementation","objective":"impl","criteria":["c"],"depends_on":[],"files":["src/lib.rs"],"commands":[],"links":["W1"]}]}).to_string(),
        ),
    ] {
        assert!(
            accept_work_map(&raw, &runtime).is_err(),
            "{label} work-map mutation was admitted"
        );
    }
}

#[test]
fn work_map_atom_registry_links_admit_only_exact_ids_without_expansion() {
    let runtime = boundary_runtime("planning.work-map.v1");
    let atom_ids = ["TE01-001", "TE01-002", "TE01-003"]
        .into_iter()
        .map(|id| Id(id.to_owned()))
        .collect::<BTreeSet<_>>();
    let valid = serde_json::json!({"units":[{"id":"U1","kind":"implementation","objective":"impl","criteria":["c"],"depends_on":[],"files":["src/lib.rs"],"commands":[command_authority("no-effect", vec![], "none", "No final Git-visible state remains outside approved files.")],"package_checks":[],"links":["TE01-001","TE01-003"]}]}).to_string();
    accept_work_map_for_atoms(&valid, &runtime, &atom_ids, "registry-digest")
        .expect("exact atom ids are admitted");

    for (label, links) in [
        ("unknown", vec!["TE01-999"]),
        ("prefixed", vec!["atoms:TE01-001"]),
        ("ranged", vec!["TE01-001..TE01-003"]),
        ("comma-group", vec!["TE01-001,TE01-002"]),
        ("source-style", vec!["task://task/TASK-A.md#whole-file"]),
        ("scout-ref", vec!["scout:repository-scout-01"]),
        ("context-ref", vec!["context:repo-facts"]),
        ("artifact-ref", vec!["artifact://work-map"]),
        ("empty-artifact", vec![""]),
    ] {
        let raw = serde_json::json!({"units":[{"id":"U1","kind":"implementation","objective":"impl","criteria":["c"],"depends_on":[],"files":["src/lib.rs"],"commands":[command_authority("no-effect", vec![], "none", "No final Git-visible state remains outside approved files.")],"package_checks":[],"links":links}]}).to_string();
        assert!(
            accept_work_map_for_atoms(&raw, &runtime, &atom_ids, "registry-digest").is_err(),
            "{label} pseudo-link was rewritten or admitted"
        );
    }
}

#[test]
fn atom_link_manifest_registry_authority_fails_closed_on_bad_bindings() {
    let root = boundary_temp_dir("atom-link-manifest");
    fs::create_dir_all(&root).expect("temp root");
    let valid_path = root.join("registry.json");
    let valid_bytes = atom_registry_bytes(&["TE01-002", "TE01-001"]);
    let valid_digest = sha256_hex(&valid_bytes);
    fs::write(&valid_path, &valid_bytes).expect("valid registry");
    let manifest = drivers::planning::atom_link_manifest_for_registry(&valid_path, &valid_digest)
        .expect("valid manifest renders");
    assert!(manifest.contains("allowed_ids_sorted: [TE01-001, TE01-002]"));

    let missing = root.join("missing.json");
    assert!(
        drivers::planning::atom_link_manifest_for_registry(&missing, &valid_digest).is_err(),
        "missing registry rendered"
    );
    assert!(
        drivers::planning::atom_link_manifest_for_registry(&valid_path, &"0".repeat(64)).is_err(),
        "digest drift rendered"
    );

    let malformed_path = root.join("malformed.json");
    let malformed = b"{not-json";
    let malformed_digest = sha256_hex(malformed);
    fs::write(&malformed_path, malformed).expect("malformed registry");
    assert!(
        drivers::planning::atom_link_manifest_for_registry(&malformed_path, &malformed_digest)
            .is_err(),
        "malformed registry rendered"
    );

    let duplicate_path = root.join("duplicate.json");
    let duplicate = atom_registry_bytes(&["TE01-001", "TE01-001"]);
    let duplicate_digest = sha256_hex(&duplicate);
    fs::write(&duplicate_path, duplicate).expect("duplicate registry");
    assert!(
        drivers::planning::atom_link_manifest_for_registry(&duplicate_path, &duplicate_digest)
            .is_err(),
        "duplicate registry rendered"
    );

    let over_budget_path = root.join("over-budget.json");
    let over_budget = vec![b'x'; ATOM_REGISTRY_MAX_BYTES + 1];
    let over_budget_digest = sha256_hex(&over_budget);
    fs::write(&over_budget_path, over_budget).expect("over-budget registry");
    assert!(
        drivers::planning::atom_link_manifest_for_registry(&over_budget_path, &over_budget_digest)
            .is_err(),
        "over-budget registry rendered"
    );

    #[cfg(unix)]
    {
        let symlink_path = root.join("registry-link.json");
        std::os::unix::fs::symlink(&valid_path, &symlink_path).expect("registry symlink");
        assert!(
            drivers::planning::atom_link_manifest_for_registry(&symlink_path, &valid_digest)
                .is_err(),
            "symlink registry rendered"
        );
    }
}

#[test]
fn work_map_command_effect_authority_accepts_valid_combinations() {
    let mut runtime = boundary_runtime("planning.work-map.v1");
    runtime.flip_to_enforce();
    for command in [
        command_authority(
            "no-effect",
            vec![],
            "none",
            "No final Git-visible state remains outside approved files.",
        ),
        command_authority(
            "declared-predictable",
            vec!["generated/cache.state"],
            "run-isolated",
            "Generated state is isolated before the final scope gate.",
        ),
        command_authority(
            "declared-predictable",
            vec!["generated/cache.state"],
            "exact-cleanup-before-scope-gate",
            "Generated state is exactly removed before the final scope gate even after failure.",
        ),
        command_authority(
            "declared-predictable",
            vec!["generated/cache.state"],
            "block-if-created",
            "Generated state blocks completion if it exists at the final scope gate.",
        ),
        command_authority(
            "unknown-generated",
            vec![],
            "run-isolated",
            "Unknown generated state is isolated from the final repository scope.",
        ),
    ] {
        let raw = work_map_with_command(command).to_string();
        accept_work_map(&raw, &runtime).expect("valid command-effect authority accepted");
    }
}

#[test]
fn work_map_command_effect_authority_rejects_cross_field_and_path_defects() {
    let mut runtime = boundary_runtime("planning.work-map.v1");
    runtime.flip_to_enforce();
    for (label, command) in [
        (
            "none plus paths",
            command_authority(
                "no-effect",
                vec!["generated/cache.state"],
                "none",
                "scope kept",
            ),
        ),
        (
            "declared empty paths",
            command_authority("declared-predictable", vec![], "run-isolated", "scope kept"),
        ),
        (
            "declared none handling",
            command_authority(
                "declared-predictable",
                vec!["generated/cache.state"],
                "none",
                "scope kept",
            ),
        ),
        (
            "unknown non-isolation",
            command_authority(
                "unknown-generated",
                vec![],
                "block-if-created",
                "scope kept",
            ),
        ),
        (
            "unsafe parent path",
            command_authority(
                "declared-predictable",
                vec!["generated/../cache.state"],
                "run-isolated",
                "scope kept",
            ),
        ),
        (
            "unsafe dot path",
            command_authority(
                "declared-predictable",
                vec!["generated/./cache.state"],
                "run-isolated",
                "scope kept",
            ),
        ),
        (
            "unsafe backslash path",
            command_authority(
                "declared-predictable",
                vec!["generated\\cache.state"],
                "run-isolated",
                "scope kept",
            ),
        ),
        (
            "duplicate paths",
            command_authority(
                "declared-predictable",
                vec!["generated/cache.state", "generated/cache.state"],
                "run-isolated",
                "scope kept",
            ),
        ),
        (
            "blank scope check",
            command_authority("no-effect", vec![], "none", " "),
        ),
    ] {
        let raw = work_map_with_command(command).to_string();
        assert!(
            accept_work_map(&raw, &runtime).is_err(),
            "{label} command-effect authority was admitted"
        );
    }
}

#[test]
fn work_map_package_checks_are_closed_explicit_and_fail_closed_without_defaults() {
    let mut runtime = boundary_runtime("planning.work-map.v1");
    runtime.flip_to_enforce();
    let command = command_authority(
        "no-effect",
        vec![],
        "none",
        "No final Git-visible state remains outside approved files.",
    );
    let valid = serde_json::json!({"units":[{
        "id":"U1","kind":"implementation","objective":"impl","criteria":["clean committed tip"],
        "depends_on":[],"files":["src/lib.rs"],"commands":[command.clone()],
        "package_checks":[{"check_id":"PKG-U1-TIP","kind":"clean-exact-package-tip","criterion_ordinals":[1],"expected":"Core proves the exact clean package tip."}],
        "links":["W1"]
    }]}).to_string();
    accept_work_map(&valid, &runtime).expect("closed package check accepted");

    let closure_check = serde_json::json!({
        "check_id":"PKG-U2-TIP","kind":"clean-exact-package-tip",
        "criterion_ordinals":[1],"expected":"Core proves the exact clean package tip."
    });
    let mut incomplete_closure = serde_json::json!({"units":[
        {"id":"U1","kind":"implementation","objective":"foundation","criteria":["foundation passes"],
         "depends_on":[],"files":["src/lib.rs"],"commands":[command.clone()],"package_checks":[],"links":["W1"]},
        {"id":"U2","kind":"implementation","objective":"close package","criteria":["clean committed tip"],
         "depends_on":["U1"],"files":["tests/final.rs"],"commands":[command.clone()],
         "package_checks":[closure_check],"links":["W2"]}
    ]});
    assert!(
        accept_work_map(&incomplete_closure.to_string(), &runtime).is_err(),
        "package-check closure unit omitted predecessor file authority"
    );
    incomplete_closure["units"][1]["files"] = serde_json::json!(["src/lib.rs", "tests/final.rs"]);
    accept_work_map(&incomplete_closure.to_string(), &runtime)
        .expect("closure unit with complete plan file authority accepted");

    for (label, package_checks) in [
        (
            "duplicate ids",
            serde_json::json!([
                {"check_id":"PKG-U1-TIP","kind":"clean-exact-package-tip","criterion_ordinals":[1],"expected":"one"},
                {"check_id":"PKG-U1-TIP","kind":"clean-exact-package-tip","criterion_ordinals":[1],"expected":"two"}
            ]),
        ),
        (
            "blank expectation",
            serde_json::json!([{"check_id":"PKG-U1-TIP","kind":"clean-exact-package-tip","criterion_ordinals":[1],"expected":" "}]),
        ),
        (
            "empty criterion ordinals",
            serde_json::json!([{"check_id":"PKG-U1-TIP","kind":"clean-exact-package-tip","criterion_ordinals":[],"expected":"bad"}]),
        ),
        (
            "duplicate criterion ordinals",
            serde_json::json!([{"check_id":"PKG-U1-TIP","kind":"clean-exact-package-tip","criterion_ordinals":[1,1],"expected":"bad"}]),
        ),
        (
            "zero criterion ordinal",
            serde_json::json!([{"check_id":"PKG-U1-TIP","kind":"clean-exact-package-tip","criterion_ordinals":[0],"expected":"bad"}]),
        ),
        (
            "out-of-range criterion ordinal",
            serde_json::json!([{"check_id":"PKG-U1-TIP","kind":"clean-exact-package-tip","criterion_ordinals":[2],"expected":"bad"}]),
        ),
        (
            "unknown kind",
            serde_json::json!([{"check_id":"PKG-U1-TIP","kind":"model-shell","criterion_ordinals":[1],"expected":"bad"}]),
        ),
    ] {
        let raw = serde_json::json!({"units":[{
            "id":"U1","kind":"implementation","objective":"impl","criteria":["clean committed tip"],
            "depends_on":[],"files":["src/lib.rs"],"commands":[command.clone()],
            "package_checks":package_checks,"links":["W1"]
        }]})
        .to_string();
        assert!(
            accept_work_map(&raw, &runtime).is_err(),
            "{label} was admitted"
        );
    }

    let missing = serde_json::json!({"units":[{
        "id":"U1","kind":"implementation","objective":"impl","criteria":["criterion"],
        "depends_on":[],"files":["src/lib.rs"],"commands":[command],"links":["W1"]
    }]})
    .to_string();
    assert!(
        accept_work_map(&missing, &runtime).is_err(),
        "legacy omission was defaulted"
    );
}

#[test]
fn work_map_command_only_payloads_fail_loudly_without_backfill() {
    let mut runtime = boundary_runtime("planning.work-map.v1");
    runtime.flip_to_enforce();
    let raw = serde_json::json!({"units":[{
        "id":"U1",
        "kind":"implementation",
        "objective":"implement assigned unit",
        "criteria":["criterion is met"],
        "depends_on":[],
        "files":["src/unit.txt"],
        "commands":[{"command":"verify assigned unit","expected":"pass"}],
        "links":["W1"]
    }]})
    .to_string();
    assert!(
        accept_work_map(&raw, &runtime).is_err(),
        "old command-only work-map payload must not be defaulted or backfilled"
    );
}

#[test]
fn historical_pre_command_effect_transcript_is_preserved_byte_exact() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/historical-transcript-fixtures/planning.work-map.v1/transcripts.pre-command-effect-authority.json");
    let bytes = fs::read(path).expect("historical transcript fixture");
    let actual = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(
        actual,
        "1ee4b2c2354d03b1beeb6912c54a73df027580e1cd449949f2682b798510996e"
    );
}

#[test]
fn validation_context_effect_revalidation_is_wired_before_prompt_and_submission() {
    let source = include_str!("../drivers/src/runner/child.rs");
    let spec_start = source
        .find("fn validate_validation_spec_identity")
        .expect("validation spec identity function");
    let spec_end = source[spec_start..]
        .find("fn validate_planning_documents")
        .map(|offset| spec_start + offset)
        .expect("validation spec identity function end");
    assert!(
        source[spec_start..spec_end]
            .contains("validate_validation_context_command_authority(&context)"),
        "validation context effects must be re-admitted before the child prompt"
    );
    let submission_start = source
        .find("fn validate_validation_submission_against")
        .expect("validation submission authority function");
    let submission_end = source[submission_start..]
        .find("fn package_tool_result")
        .map(|offset| submission_start + offset)
        .expect("validation submission authority function end");
    assert!(
        source[submission_start..submission_end]
            .contains("validate_validation_context_command_authority(context)"),
        "validation context effects must be re-admitted at child and parent submission authority"
    );
}

#[test]
fn malformed_validation_context_command_authority_is_rejected_at_submission_admission() {
    for (label, command) in [
        (
            "blank command",
            validation_context_command_authority(
                " ",
                "pass",
                "no-effect",
                vec![],
                "none",
                "scope kept",
            ),
        ),
        (
            "blank expected",
            validation_context_command_authority(
                "verify assigned unit",
                " ",
                "no-effect",
                vec![],
                "none",
                "scope kept",
            ),
        ),
        (
            "blank scope",
            validation_context_command_authority(
                "verify assigned unit",
                "pass",
                "no-effect",
                vec![],
                "none",
                " ",
            ),
        ),
        (
            "declared empty paths",
            validation_context_command_authority(
                "verify assigned unit",
                "pass",
                "declared-predictable",
                vec![],
                "run-isolated",
                "scope kept",
            ),
        ),
        (
            "unknown non-isolation",
            validation_context_command_authority(
                "verify assigned unit",
                "pass",
                "unknown-generated",
                vec![],
                "block-if-created",
                "scope kept",
            ),
        ),
        (
            "unsafe path",
            validation_context_command_authority(
                "verify assigned unit",
                "pass",
                "declared-predictable",
                vec!["generated/../cache.state"],
                "run-isolated",
                "scope kept",
            ),
        ),
        (
            "duplicate path",
            validation_context_command_authority(
                "verify assigned unit",
                "pass",
                "declared-predictable",
                vec!["generated/cache.state", "generated/cache.state"],
                "run-isolated",
                "scope kept",
            ),
        ),
    ] {
        let (assignment, context, submission) = validation_authority_bundle(command);
        assert!(
            drivers::runner::child::admit_validation_submission_with_authority(
                &submission,
                &assignment,
                &context
            )
            .is_err(),
            "{label} validation context command authority was admitted"
        );
    }
}

#[test]
fn validation_approved_command_receipts_are_exact_and_criterion_bound() {
    let command = validation_context_command_authority(
        "verify assigned unit",
        "pass",
        "no-effect",
        vec![],
        "none",
        "scope kept",
    );
    let (assignment, context, submission) = validation_authority_bundle(command);
    drivers::runner::child::admit_validation_submission_with_authority(
        &submission,
        &assignment,
        &context,
    )
    .expect("exact approved-command receipt is admitted");

    let mut omitted = submission.clone();
    omitted.criterion_results[0].evidence_refs.clear();
    assert!(
        drivers::runner::child::admit_validation_submission_with_authority(
            &omitted,
            &assignment,
            &context,
        )
        .is_err(),
        "criterion omitted its required approved-command receipt"
    );

    let mut kind_drift = context.clone();
    kind_drift.evidence[0].kind = "delivery-focused".to_owned();
    assert!(
        drivers::runner::child::admit_validation_submission_with_authority(
            &submission,
            &assignment,
            &kind_drift,
        )
        .is_err(),
        "command receipt kind drift was admitted"
    );

    let mut unrelated_context = context.clone();
    let mut unrelated_criterion = unrelated_context.criteria[0].clone();
    unrelated_criterion.criterion_id = Id("criterion-without-command".to_owned());
    unrelated_criterion.commands.clear();
    unrelated_context.criteria.push(unrelated_criterion);
    let mut unrelated_submission = submission.clone();
    let mut unrelated_result = unrelated_submission.criterion_results[0].clone();
    unrelated_result.criterion_id = Id("criterion-without-command".to_owned());
    unrelated_submission
        .criterion_results
        .push(unrelated_result);
    assert!(
        drivers::runner::child::admit_validation_submission_with_authority(
            &unrelated_submission,
            &assignment,
            &unrelated_context,
        )
        .is_err(),
        "unrelated criterion substituted an approved-command receipt"
    );
}

#[test]
fn validation_package_check_receipts_are_exactly_bound_and_cannot_duplicate() {
    let command = validation_context_command_authority(
        "verify assigned unit",
        "pass",
        "no-effect",
        vec![],
        "none",
        "scope kept",
    );
    let (assignment, mut context, mut submission) = validation_authority_bundle(command);
    let check_id = Id("PKG-U1-TIP".to_owned());
    let evidence_ref = kernel::generated::Ref(
        "package-check-receipt:PKG-U1-TIP:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_owned(),
    );
    context.criteria[0]
        .package_checks
        .push(kernel::generated::ValidationContextPackageCheck {
            check_id: check_id.clone(),
            kind: kernel::generated::PackageCheckKind::CleanExactPackageTip,
            expected: "Core proves the clean exact package tip.".to_owned(),
            evidence_ref: evidence_ref.clone(),
        });
    context
        .evidence
        .push(kernel::generated::ValidationContextEvidence {
            evidence_ref: evidence_ref.clone(),
            digest: kernel::generated::Digest("a".repeat(64)),
            kind: "delivery-package-check".to_owned(),
            exact_commit: context.exact_commit.clone(),
            exact_tree: context.exact_tree.clone(),
            command_id: None,
            package_check_id: Some(check_id),
        });
    assert!(
        drivers::runner::child::admit_validation_submission_with_authority(
            &submission,
            &assignment,
            &context,
        )
        .is_err(),
        "criterion omitted its required Core-owned package-check receipt"
    );
    let command_evidence_ref = context.criteria[0].commands[0].evidence_ref.clone();
    submission.criterion_results[0].evidence_refs = vec![command_evidence_ref, evidence_ref];
    drivers::runner::child::admit_validation_submission_with_authority(
        &submission,
        &assignment,
        &context,
    )
    .expect("package check receipt is admitted");

    let mut unrelated_context = context.clone();
    let mut unrelated_criterion = unrelated_context.criteria[0].clone();
    unrelated_criterion.criterion_id = Id("criterion-without-package-check".to_owned());
    unrelated_criterion.package_checks.clear();
    unrelated_context.criteria.push(unrelated_criterion);
    let mut unrelated_submission = submission.clone();
    let mut unrelated_result = unrelated_submission.criterion_results[0].clone();
    unrelated_result.criterion_id = Id("criterion-without-package-check".to_owned());
    unrelated_submission
        .criterion_results
        .push(unrelated_result);
    assert!(
        drivers::runner::child::admit_validation_submission_with_authority(
            &unrelated_submission,
            &assignment,
            &unrelated_context,
        )
        .is_err(),
        "unrelated criterion substituted a package-check receipt"
    );

    let mut drifted = context.clone();
    drifted
        .evidence
        .last_mut()
        .expect("package evidence")
        .exact_tree = kernel::generated::GitOid("f".repeat(40));
    assert!(
        drivers::runner::child::admit_validation_submission_with_authority(
            &submission,
            &assignment,
            &drifted,
        )
        .is_err(),
        "tree-drifted package receipt was admitted"
    );
    let mut digest_drifted = context.clone();
    digest_drifted
        .evidence
        .last_mut()
        .expect("package evidence")
        .digest = kernel::generated::Digest("b".repeat(64));
    assert!(
        drivers::runner::child::admit_validation_submission_with_authority(
            &submission,
            &assignment,
            &digest_drifted,
        )
        .is_err(),
        "digest-drifted package receipt was admitted"
    );
    let mut duplicated = context.clone();
    duplicated.evidence.push(
        duplicated
            .evidence
            .last()
            .expect("package evidence")
            .clone(),
    );
    assert!(
        drivers::runner::child::admit_validation_submission_with_authority(
            &submission,
            &assignment,
            &duplicated,
        )
        .is_err(),
        "duplicate package receipt was admitted"
    );
}

fn validation_context_command_authority(
    command: &str,
    expected: &str,
    effect: &str,
    generated_paths: Vec<&str>,
    handling: &str,
    scope_preservation: &str,
) -> serde_json::Value {
    serde_json::json!({
        "command_id":"CMD1",
        "command":command,
        "expected":expected,
        "effect":effect,
        "generated_paths":generated_paths,
        "handling":handling,
        "scope_preservation":scope_preservation,
        "evidence_ref":"approved-command-receipt:CMD1:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    })
}

fn validation_authority_bundle(
    command: serde_json::Value,
) -> (
    kernel::generated::ValidationAssignmentV2,
    kernel::generated::ValidationContextV2,
    kernel::generated::ValidationSubmissionV2,
) {
    let exact_commit = "1111111111111111111111111111111111111111";
    let exact_tree = "2222222222222222222222222222222222222222";
    let assignment = serde_json::json!({
        "schema":"autopilot.validation_assignment.v2",
        "validation_id":"VAL1",
        "validation_key":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "workstream":"main",
        "run_revision":1,
        "role_id":"validator",
        "mode":"validation",
        "assignment_id":"A1",
        "action_id":"ACT1",
        "validation_attempt":1,
        "semantic_round":1,
        "scope":"forward",
        "subject_kind":"lane-delivery",
        "producer_assignment_ids":["producer-1"],
        "producer_result_refs":["result:producer-1"],
        "lane_id":"L1",
        "candidate_id":"C1",
        "exact_commit":exact_commit,
        "exact_tree":exact_tree,
        "candidate_root":".",
        "forward_round":1,
        "criteria_manifest_ref":"criteria:1",
        "criteria_manifest_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "evidence_manifest_ref":"evidence:1",
        "evidence_manifest_digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "diff_ref":"diff:1",
        "diff_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "prior_finding_refs":[],
        "allowed_read_roots":["."],
        "allowed_command_ids":["CMD1"],
        "max_transport_attempts":1
    });
    let context = serde_json::json!({
        "schema":"autopilot.validation_context.v2",
        "context_id":"CTX1",
        "revision":1,
        "validation_id":"VAL1",
        "assignment_id":"A1",
        "exact_commit":exact_commit,
        "exact_tree":exact_tree,
        "candidate":{
            "source_root":".",
            "diff_ref":"diff:1",
            "diff_digest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "actual_changed_paths":["src/unit.txt"],
            "execution_audit_ref":"audit:1"
        },
        "criteria":[{
            "criterion_id":"CR1",
            "requirement_text":"criterion is met",
            "mandatory":true,
            "covered_paths":["src/unit.txt"],
            "semantic_surface_ids":["surface-1"],
            "forward_edge_ids":["edge-1"],
            "commands":[command],
            "package_checks":[],
            "witness_ids":["witness-1"]
        }],
        "evidence":[{
            "evidence_ref":"approved-command-receipt:CMD1:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "kind":"delivery-approved-command",
            "exact_commit":exact_commit,
            "exact_tree":exact_tree,
            "command_id":"CMD1"
        }],
        "prior_findings":[],
        "applicable_decision_refs":[],
        "applicable_constraint_refs":[],
        "included_context_classes":["diff"],
        "forbidden_context_classes":["producer-reasoning"],
        "allowed_read_roots":["."],
        "excluded_refs":[]
    });
    let submission = serde_json::json!({
        "schema":"autopilot.validation_submission.v2",
        "validation_id":"VAL1",
        "assignment_id":"A1",
        "scope":"forward",
        "exact_commit":exact_commit,
        "exact_tree":exact_tree,
        "outcome":"FORWARD_READY",
        "criterion_results":[{
            "criterion_id":"CR1",
            "verdict":"PASS",
            "evidence_refs":["approved-command-receipt:CMD1:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
            "finding_ids":[],
            "covered_paths":["src/unit.txt"],
            "semantic_surface_ids":["surface-1"],
            "forward_edge_ids":["edge-1"]
        }],
        "findings":[]
    });
    (
        serde_json::from_value(assignment).expect("typed assignment"),
        serde_json::from_value(context).expect("typed context"),
        serde_json::from_value(submission).expect("typed submission"),
    )
}

#[test]
fn prompt_guidance_names_command_effect_authority() {
    let admits = kernel::generated::WORK_MAP_ADMITS;
    assert!(
        admits.contains("closed Git-visible effect authority"),
        "{admits}"
    );
    assert!(admits.contains("declared-predictable"), "{admits}");
    assert!(admits.contains("run-isolated"), "{admits}");
    assert!(admits.contains("final-scope preservation"), "{admits}");
    assert!(
        admits.contains("strictly pre-package child evidence"),
        "{admits}"
    );
    assert!(admits.contains("clean-exact-package-tip"), "{admits}");
    assert!(
        admits.contains("must never be represented as a child command"),
        "{admits}"
    );
}

fn command_authority(
    effect: &str,
    generated_paths: Vec<&str>,
    handling: &str,
    scope_preservation: &str,
) -> serde_json::Value {
    serde_json::json!({
        "command":"verify assigned unit",
        "expected":"verification completes with declared final scope",
        "effect":effect,
        "generated_paths":generated_paths,
        "handling":handling,
        "scope_preservation":scope_preservation,
    })
}

fn work_map_with_command(command: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"units":[{
        "id":"U1",
        "kind":"implementation",
        "objective":"implement assigned unit",
        "criteria":["criterion is met"],
        "depends_on":[],
        "files":["src/unit.txt"],
        "commands":[command],
        "package_checks":[],
        "links":["W1"]
    }]})
}

#[test]
fn replay_gate_rejects_malformed_plan_review() {
    let raw = "verdict PASS — overall ok\n\n- missing verification command must be added before release\n";
    let mut runtime = boundary_runtime("planning.plan-review.v1");
    runtime.flip_to_enforce();
    let rejection = match accept_plan_review(raw, &runtime) {
        Ok(value) => panic!("unclassified substantive review admitted: {value}"),
        Err(value) => value,
    };
    assert_eq!(rejection.boundary_id(), "planning.plan-review.v1");
}

fn atom_registry_bytes(ids: &[&str]) -> Vec<u8> {
    let atoms = ids
        .iter()
        .map(|id| {
            serde_json::json!({
                "id": id,
                "producer_assignment_id": "planning-main-task-extractor-01",
                "kind": "work",
                "text": format!("task atom {id}"),
                "sources": ["task://task/TASK-A.md#whole-file"]
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_vec_pretty(&serde_json::json!({
        "schema":"autopilot.planning_atom_registry.v1",
        "workstream":"main",
        "authority_set_id":"set-a",
        "producer_assignment_ids":["planning-main-task-extractor-01"],
        "atoms":atoms
    }))
    .expect("registry json")
}

fn boundary_temp_dir(label: &str) -> PathBuf {
    let unique = BOUNDARY_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "pi-autopilot-boundary-{label}-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("temp root");
    fs::canonicalize(root).expect("canonical temp root")
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_transcript_root(root: &Path) -> Result<(), String> {
    let metadata = fs::metadata(root).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("transcript root missing: {}", root.display())
        } else {
            format!("transcript root unreadable: {}: {error}", root.display())
        }
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "transcript root is not a directory: {}",
            root.display()
        ));
    }

    let entries = fs::read_dir(root)
        .map_err(|error| format!("transcript root unreadable: {}: {error}", root.display()))?;
    let mut boundary_directory_count = 0usize;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("transcript root unreadable: {}: {error}", root.display()))?;
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "transcript root entry unreadable: {}: {error}",
                entry.path().display()
            )
        })?;
        if file_type.is_dir() {
            boundary_directory_count += 1;
        }
    }
    if boundary_directory_count == 0 {
        return Err(format!(
            "transcript root contains no boundary directories: {}",
            root.display()
        ));
    }
    Ok(())
}

fn replay_records(boundary_id: &'static str, records: &[TranscriptRecord]) {
    let Some(plan) = replay_plan(boundary_id) else {
        panic!(
            "enforced Model boundary {boundary_id} has transcripts but no replay acceptor or declared typed-only report"
        );
    };
    for (index, record) in records.iter().enumerate() {
        let raw = match record.replay() {
            Ok(value) => value,
            Err(error) => panic!("bad replay transcript for {boundary_id}: {error:?}"),
        };
        if let ReplayPlan::Raw(acceptor) = plan
            && let Err(rejection) = acceptor(raw)
        {
            panic!("boundary {boundary_id} rejected transcript #{index}: {rejection:?}");
        }
    }
}

#[derive(Clone, Copy)]
enum ReplayPlan {
    Raw(fn(&str) -> Result<(), Rejection>),
    TypedOnly,
}

fn replay_plan(boundary_id: &str) -> Option<ReplayPlan> {
    match boundary_id {
        "planning.task-atoms.v1" => Some(ReplayPlan::Raw(replay_task_atoms)),
        "planning.scout-dossier.v1" => Some(ReplayPlan::Raw(replay_scout_dossier)),
        "planning.questions.v1" => Some(ReplayPlan::Raw(replay_questions)),
        "planning.work-map.v1" => Some(ReplayPlan::Raw(replay_work_map)),
        "planning.plan-review.v1" => Some(ReplayPlan::Raw(replay_plan_review)),
        "allocation.lane-proposal.v1" | "validation.verdict.v1" => Some(ReplayPlan::TypedOnly),
        _ => None,
    }
}

fn replay_with(
    raw: &str,
    id: &'static str,
    acceptor: fn(&str, &BoundaryRuntime) -> Result<String, Rejection>,
) -> Result<(), Rejection> {
    let mut runtime = boundary_runtime(id);
    runtime.flip_to_enforce();
    acceptor(raw, &runtime).map(|_| ())
}
fn replay_task_atoms(raw: &str) -> Result<(), Rejection> {
    replay_with(raw, "planning.task-atoms.v1", accept_task_atoms)
}
fn replay_scout_dossier(raw: &str) -> Result<(), Rejection> {
    replay_with(raw, "planning.scout-dossier.v1", accept_scout_dossier)
}
fn replay_questions(raw: &str) -> Result<(), Rejection> {
    replay_with(raw, "planning.questions.v1", accept_questions)
}
fn replay_work_map(raw: &str) -> Result<(), Rejection> {
    replay_with(raw, "planning.work-map.v1", accept_work_map)
}
fn replay_plan_review(raw: &str) -> Result<(), Rejection> {
    replay_with(raw, "planning.plan-review.v1", accept_plan_review)
}

fn model_boundaries() -> Vec<&'static BoundaryDescriptor> {
    BOUNDARIES
        .iter()
        .filter(|descriptor| descriptor.producer() == Producer::Model)
        .collect()
}
