use std::fs;

use drivers::transcript::{
    BoundaryModeTable, TranscriptError, TranscriptProvenance, TranscriptRecord, TranscriptStore,
};

#[test]
fn enforce_to_record_regression_fails() {
    let old = parse("boundary \"planning.task-atoms.v1\" mode=\"enforce\"");
    let new = parse("boundary \"planning.task-atoms.v1\" mode=\"record\"");
    assert_eq!(
        old.assert_one_way(&new),
        Err(TranscriptError::Regression(
            "planning.task-atoms.v1".to_owned()
        ))
    );

    let flipped = parse("boundary \"planning.task-atoms.v1\" mode=\"enforce\"");
    assert_eq!(new.assert_one_way(&flipped), Ok(()));
}

#[test]
fn recorded_transcript_replays_deterministically() {
    let root =
        std::env::temp_dir().join(format!("autopilot-transcript-test-{}", std::process::id()));
    let _cleanup = fs::remove_dir_all(&root);
    let store = TranscriptStore::new(&root);
    let record = TranscriptRecord::real(
        "planning.task-atoms.v1",
        "atom A1 from a real subscription run",
        TranscriptProvenance {
            provider: "openai-codex".to_owned(),
            model: "gpt-live".to_owned(),
            thinking: "high".to_owned(),
            session_id: "session-123".to_owned(),
        },
    );
    if let Err(error) = store.record(&record) {
        panic!("record transcript failed: {error:?}");
    }
    let loaded = match store.load_boundary("planning.task-atoms.v1") {
        Ok(value) => value,
        Err(error) => panic!("load transcript failed: {error:?}"),
    };
    assert_eq!(loaded.len(), 1);
    let first = match loaded[0].replay() {
        Ok(value) => value.to_owned(),
        Err(error) => panic!("first replay failed: {error:?}"),
    };
    let second = match loaded[0].replay() {
        Ok(value) => value.to_owned(),
        Err(error) => panic!("second replay failed: {error:?}"),
    };
    assert_eq!(first, "atom A1 from a real subscription run");
    assert_eq!(first, second);
    let _cleanup = fs::remove_dir_all(&root);
}

fn parse(text: &str) -> BoundaryModeTable {
    match BoundaryModeTable::parse(text) {
        Ok(value) => value,
        Err(error) => panic!("mode table parse failed: {error:?}"),
    }
}
