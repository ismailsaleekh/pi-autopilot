use super::*;

#[test]
fn layer_4_5_7_quoted_data_fence_is_longer_than_body_backtick_runs() {
    let body = "legal path with ``` and ```` backticks\nsource=still data";
    let fence = backtick_fence_for(body);
    assert_eq!(
        fence, "`````",
        "Layer 4/5/7 quoted-data fence must exceed the longest body backtick run"
    );
    let mut rendered = String::new();
    data_layer(&mut rendered, 4, "package assignment", body);
    assert!(
        rendered.contains("`````text\nlegal path with ``` and ```` backticks"),
        "Layer 4 package assignment uses dynamic non-terminable fence: {rendered}"
    );
    assert!(
        !body.contains(&fence),
        "chosen Layer 4/5/7 fence appears inside body data"
    );
}
