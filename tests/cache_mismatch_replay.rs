use kernel::fold::{fold, fold_all};
use kernel::generated::{Digest, EventKind, EventRow, Ref};
use kernel::log::{AppendPlan, LogEffect, ReplayUse, cache_image, plan_append, replay};
use kernel::state::State;

fn trace() -> Result<Vec<EventRow>, Box<dyn std::error::Error>> {
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
    Ok(rows)
}

fn image_for(
    rows: &[EventRow],
    row_count: usize,
) -> Result<kernel::log::CacheImage, Box<dyn std::error::Error>> {
    match cache_image(fold_all(&rows[..row_count])) {
        LogEffect::Store(image) => Ok(image),
        LogEffect::Append(_) => Err("cache did not produce a store effect".into()),
    }
}

#[test]
fn corrupted_hash_full_replays() -> Result<(), Box<dyn std::error::Error>> {
    let rows = trace()?;
    let full = replay(&rows, None).state;
    let mut image = image_for(&rows, 5)?;
    image.cache.state_hash = Digest("corrupt".to_owned());

    let replayed = replay(&rows, Some(&image));

    assert_eq!(replayed.used, ReplayUse::Full);
    assert_eq!(replayed.state, full);
    Ok(())
}

#[test]
fn corrupted_sequence_full_replays() -> Result<(), Box<dyn std::error::Error>> {
    let rows = trace()?;
    let full = replay(&rows, None).state;
    let mut image = image_for(&rows, 5)?;
    image.cache.sequence += 1;

    let replayed = replay(&rows, Some(&image));

    assert_eq!(replayed.used, ReplayUse::Full);
    assert_eq!(replayed.state, full);
    Ok(())
}

#[test]
fn truncated_log_full_replays() -> Result<(), Box<dyn std::error::Error>> {
    let rows = trace()?;
    let image = image_for(&rows, 5)?;
    let shortened = &rows[..4];
    let full = replay(shortened, None).state;

    let replayed = replay(shortened, Some(&image));

    assert_eq!(replayed.used, ReplayUse::Full);
    assert_eq!(replayed.state, full);
    Ok(())
}
