use std::{
    fs,
    path::{Path, PathBuf},
};

use drivers::planning::{
    MODEL_BOUNDARIES, accept_plan_review, accept_questions, accept_scout_dossier,
    accept_task_atoms, accept_work_map, boundary_runtime,
};
use drivers::transcript::{
    BoundaryModeTable, TranscriptProvenance, TranscriptRecord, TranscriptStore,
};
use kernel::boundary::{
    BOUNDARIES, BoundaryDescriptor, BoundaryMode, BoundaryRuntime, Producer, Rejection,
};
use sha2::{Digest as ShaDigest, Sha256};

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
            "witness_ids":["witness-1"]
        }],
        "evidence":[{
            "evidence_ref":"evidence:command-1",
            "digest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "kind":"command-output",
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
            "evidence_refs":["evidence:command-1"],
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
