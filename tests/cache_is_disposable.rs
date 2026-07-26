use kernel::fold::fold_all;
use kernel::generated::{EventKind, EventRow, Ref};
use kernel::log::{LogEffect, ReplayUse, cache_image, replay};
use proptest::prelude::*;

fn row_strategy() -> impl Strategy<Value = EventRow> {
    (
        0_u64..40,
        0_u64..40,
        0_u64..40,
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
    fn deleting_cache_changes_no_state(events in prop::collection::vec(row_strategy(), 0..80), prefix in 0_usize..81) {
        let row_count = if events.is_empty() { 0 } else { prefix % (events.len() + 1) };
        let prefix_state = fold_all(&events[..row_count]);
        let image = match cache_image(prefix_state) {
            LogEffect::Store(image) => image,
            LogEffect::Append(_) => return Err(TestCaseError::fail("cache did not produce a store effect")),
        };

        let from_empty = replay(&events, None);
        let from_cache = replay(&events, Some(&image));

        prop_assert_eq!(from_cache.used, ReplayUse::Cache);
        prop_assert_eq!(from_empty.state, from_cache.state);
    }
}
