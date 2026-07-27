use std::sync::atomic::{AtomicUsize, Ordering};

use drivers::roster::{Route, guard_route};
use kernel::failure::{Failure, HardBoundary};

static SPEND: AtomicUsize = AtomicUsize::new(0);

#[test]
fn subscription_route_is_accepted() {
    let route = Route {
        provider: "openai-codex".to_owned(),
        model: "gpt-5.5".to_owned(),
        thinking: "high".to_owned(),
        subscription: true,
    };
    let admitted = guard_route(&route).expect("subscription route admitted");
    assert_eq!(admitted, route);
}

#[test]
fn metered_route_is_unsafe_and_no_spend_occurs() {
    let route = Route {
        provider: "openrouter".to_owned(),
        model: "gpt-5.6-terra".to_owned(),
        thinking: "high".to_owned(),
        subscription: false,
    };
    let result = guarded_spend(&route);
    assert_eq!(
        result,
        Err(Failure::Unsafe {
            boundary: HardBoundary::MeteredFrontierRoute
        })
    );
    assert_eq!(SPEND.load(Ordering::SeqCst), 0);
}

fn guarded_spend(route: &Route) -> Result<(), Failure> {
    let _admitted = guard_route(route)?;
    SPEND.fetch_add(1, Ordering::SeqCst);
    Ok(())
}
