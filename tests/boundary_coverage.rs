use std::path::Path;

use drivers::planning::MODEL_BOUNDARIES;
use drivers::transcript::{
    BoundaryModeTable, TranscriptProvenance, TranscriptRecord, TranscriptStore,
};
use kernel::boundary::{BoundaryDescriptor, BoundaryMode, Producer, BOUNDARIES};

#[test]
fn model_boundaries_are_enforced_or_loudly_reported_in_record_phase() {
    let table = mode_table();
    let store = TranscriptStore::new(Path::new("tests/transcripts"));
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
                Ok(records) if !records.is_empty() => {}
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
        assert_eq!(phase.as_deref().and_then(|value| value.to_str()), Some("record"));
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

fn mode_table() -> BoundaryModeTable {
    match BoundaryModeTable::parse(include_str!("../data/boundary-modes.kdl")) {
        Ok(value) => value,
        Err(error) => panic!("boundary mode parse failed: {error:?}"),
    }
}

fn model_boundaries() -> Vec<&'static BoundaryDescriptor> {
    BOUNDARIES
        .iter()
        .filter(|descriptor| descriptor.producer() == Producer::Model)
        .collect()
}
