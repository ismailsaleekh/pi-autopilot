use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_ID: AtomicU64 = AtomicU64::new(0);

use drivers::fs::FsStore;
use kernel::{
    failure::{Failure, RecoveryRoute},
    generated::{EventKind, Ref},
    log::{AppendPlan, LogEffect, cache_image, plan_append},
    platform::{CacheRead, Store},
    state::State,
};

fn temp_root(name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "pi-autopilot-{name}-{}-{}",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn driver<T>(result: Result<T, Failure>) -> Result<T, Box<dyn std::error::Error>> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => Err(format!("{error:?}").into()),
    }
}

fn image() -> Result<kernel::log::CacheImage, Box<dyn std::error::Error>> {
    let plan = plan_append(
        &State::EMPTY,
        EventKind("cache".to_owned()),
        vec![Ref("r".to_owned())],
    );
    let row = match plan {
        AppendPlan::Write(LogEffect::Append(row)) => row,
        AppendPlan::Write(LogEffect::Store(_)) | AppendPlan::Refused(_) => {
            return Err("no row".into());
        }
    };
    let state = kernel::fold::fold(State::EMPTY, &row);
    match cache_image(state) {
        LogEffect::Store(image) => Ok(image),
        LogEffect::Append(_) => Err("no cache".into()),
    }
}

#[test]
fn cache_roundtrips_and_absence_is_typed() -> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("cache-roundtrip")?;
    let expected = image()?;
    let mut store = driver(FsStore::open(&root))?;
    driver(Store::write_cache(&mut store, &expected))?;
    let read = driver(Store::read_cache(&store))?;
    assert_eq!(read, CacheRead::Present(expected));
    fs::remove_file(store.cache_path())?;
    assert_eq!(driver(Store::read_cache(&store))?, CacheRead::Absent);
    Ok(())
}

#[test]
fn corrupt_cache_is_reported() -> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("cache-corrupt")?;
    let store = driver(FsStore::open(&root))?;
    fs::write(store.cache_path(), b"not-json")?;
    assert!(matches!(
        Store::read_cache(&store),
        Err(Failure::Recoverable {
            route: RecoveryRoute::Tier1
        })
    ));
    Ok(())
}
