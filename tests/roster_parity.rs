use drivers::roster::Roster;

#[test]
fn roster_matches_d76_section_3_exactly() {
    let roster = Roster::package().expect("roster loads");
    let actual: Vec<(String, String, String)> = roster
        .slots()
        .map(|slot| {
            (
                slot.name.clone(),
                format!("{}/{}", slot.provider, slot.model),
                slot.thinking.clone(),
            )
        })
        .collect();
    assert_eq!(
        actual,
        vec![
            row("coding", "openai-codex/gpt-5.5", "high"),
            row("control", "openai-codex/gpt-5.6-terra", "high"),
            row("extraction", "openai-codex/gpt-5.5", "high"),
            row("reasoning", "openai-codex/gpt-5.6-sol", "xhigh"),
            row("review", "openai-codex/gpt-5.5", "xhigh"),
        ]
    );
}

fn row(slot: &str, model: &str, thinking: &str) -> (String, String, String) {
    (slot.to_owned(), model.to_owned(), thinking.to_owned())
}
