use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_ID: AtomicU64 = AtomicU64::new(0);

use drivers::fs::FsStore;
use kernel::{
    failure::{Failure, HardBoundary},
    generated::{EventKind, Ref},
    log::{AppendPlan, LogEffect, plan_append},
    platform::Store,
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

fn row() -> Result<kernel::generated::EventRow, Box<dyn std::error::Error>> {
    match plan_append(
        &State::EMPTY,
        EventKind("write".to_owned()),
        vec![Ref("r".to_owned())],
    ) {
        AppendPlan::Write(LogEffect::Append(row)) => Ok(row),
        AppendPlan::Write(LogEffect::Store(_)) | AppendPlan::Refused(_) => Err("no row".into()),
    }
}

fn driver<T>(result: Result<T, Failure>) -> Result<T, Box<dyn std::error::Error>> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => Err(format!("{error:?}").into()),
    }
}

fn assert_unsafe(result: Result<(), Failure>) {
    assert!(matches!(
        result,
        Err(Failure::Unsafe {
            boundary: HardBoundary::OutOfScopeWrite
        })
    ));
}

#[test]
fn atomic_sequence_is_present_in_order() -> Result<(), Box<dyn std::error::Error>> {
    let source =
        fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/fs/cache.rs"))?;
    let temp = source
        .find(".create_new(true)")
        .ok_or("missing temp create")?;
    let write = source
        .find("file.write_all(bytes)")
        .ok_or("missing write")?;
    let fsync = source.find("file.sync_all()").ok_or("missing file fsync")?;
    let rename = source
        .find("fs::rename(&temp, target)")
        .ok_or("missing rename")?;
    let dir = source.find("dir.sync_all()").ok_or("missing dir fsync")?;
    assert!(temp < write && write < fsync && fsync < rename && rename < dir);
    Ok(())
}

#[test]
fn append_is_durable_and_permissions_are_private() -> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("atomic-ok")?;
    let mut store = driver(FsStore::open(&root))?;
    driver(Store::append_event(&mut store, &row()?))?;
    let (events, cache) = driver(store.replay_inputs())?;
    assert_eq!(events.len(), 1);
    assert!(matches!(cache, kernel::platform::CacheRead::Absent));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&root)?.permissions().mode() & 0o777, 0o700);
        assert_eq!(
            fs::metadata(root.join("events.jsonl"))?
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    Ok(())
}

#[test]
fn parent_escape_is_unsafe_and_writes_nothing() -> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("atomic-parent")?;
    let outside = root
        .parent()
        .ok_or("root has no parent")?
        .join("escaped-events.jsonl");
    let event = row()?;
    let result = FsStore::with_paths(&root, "../escaped-events.jsonl", "state.json")
        .and_then(|mut store| Store::append_event(&mut store, &event));
    assert_unsafe(result);
    assert!(!outside.exists());
    Ok(())
}

#[test]
fn absolute_path_is_unsafe_and_writes_nothing() -> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("atomic-absolute")?;
    let outside = root
        .parent()
        .ok_or("root has no parent")?
        .join("absolute-events.jsonl");
    let event = row()?;
    let result = FsStore::with_paths(&root, &outside, "state.json")
        .and_then(|mut store| Store::append_event(&mut store, &event));
    assert_unsafe(result);
    assert!(!outside.exists());
    Ok(())
}

#[test]
fn symlink_escape_is_unsafe_and_writes_nothing() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(unix)]
    {
        let root = temp_root("atomic-symlink")?;
        let outside = root
            .parent()
            .ok_or("root has no parent")?
            .join("symlink-events.jsonl");
        std::os::unix::fs::symlink(&outside, root.join("events.jsonl"))?;
        let mut store = driver(FsStore::open(&root))?;
        assert_unsafe(Store::append_event(&mut store, &row()?));
        assert!(!outside.exists());
    }
    Ok(())
}
