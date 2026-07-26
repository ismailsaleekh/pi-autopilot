use kernel::fold::{fold, fold_all};
use kernel::generated::{EventKind, EventRow, Ref};
use kernel::log::{AppendPlan, LogEffect, plan_append, replay};
use kernel::state::State;
use proptest::prelude::*;

fn row_strategy() -> impl Strategy<Value = EventRow> {
    (
        0_u64..25,
        0_u64..25,
        0_u64..25,
        "[a-z]{1,6}",
        prop::collection::vec("[a-z]{1,6}", 0..4),
    )
        .prop_map(
            |(sequence, previous_revision, new_revision, kind, refs)| EventRow {
                sequence,
                previous_revision,
                new_revision,
                kind: EventKind(kind),
                artifact_refs: refs.into_iter().map(Ref).collect(),
            },
        )
}

proptest! {
    #[test]
    fn prefix_fold_matches_incremental_state(events in prop::collection::vec(row_strategy(), 0..80)) {
        let mut state = State::EMPTY;
        let mut seen = Vec::new();
        for event in events {
            state = fold(state, &event);
            seen.push(event);
            prop_assert_eq!(state.clone(), fold_all(&seen));
        }
    }
}

#[test]
fn ten_event_trace_replays_identically() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::EMPTY;
    let mut rows = Vec::new();
    for index in 0..10 {
        let plan = plan_append(
            &state,
            EventKind(format!("kind-{index}")),
            vec![Ref(format!("ref-{index}"))],
        );
        let row = match plan {
            AppendPlan::Write(LogEffect::Append(row)) => row,
            AppendPlan::Write(LogEffect::Store(_)) | AppendPlan::Refused(_) => {
                return Err("append did not produce an event row".into());
            }
        };
        state = fold(state, &row);
        rows.push(row);
    }

    let mut encoded = String::new();
    for row in &rows {
        encoded.push_str(&serde_json::to_string(row)?);
        encoded.push('\n');
    }
    let mut decoded = Vec::new();
    for line in encoded.lines() {
        decoded.push(serde_json::from_str::<EventRow>(line)?);
    }

    assert_eq!(decoded, rows);
    assert_eq!(replay(&decoded, None).state, state);
    Ok(())
}
