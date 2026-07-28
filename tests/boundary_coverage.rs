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
