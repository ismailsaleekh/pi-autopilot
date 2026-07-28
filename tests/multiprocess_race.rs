use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::Duration,
};

use drivers::{
    fs::FsStore,
    state_root::{StateRoot, StateRootError},
};
use kernel::{
    generated::{Base32, EventKind, EventRow, Id, Ref, RunIdentity, Uuidv7},
    platform::{CacheRead, Store},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn reserve_race_has_one_winner_one_active_run_and_one_marker()
-> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("reserve")?;
    let barrier = root.join("start");
    let result_a = root.join("a.result");
    let result_b = root.join("b.result");
    let a = spawn_child(
        "reserve",
        root.clone(),
        "run-a".to_owned(),
        barrier.clone(),
        result_a.clone(),
    )?;
    let b = spawn_child(
        "reserve",
        root.clone(),
        "run-b".to_owned(),
        barrier.clone(),
        result_b.clone(),
    )?;
    fs::write(&barrier, b"go")?;
    assert_child_success(a)?;
    assert_child_success(b)?;

    let results = [
        fs::read_to_string(&result_a)?,
        fs::read_to_string(&result_b)?,
    ];
    let acquired: Vec<&str> = results
        .iter()
        .filter_map(|value| value.strip_prefix("acquired:"))
        .collect();
    let active = results
        .iter()
        .filter(|value| value.as_str() == "active-run")
        .count();
    assert_eq!(acquired.len(), 1, "reserve results were {results:?}");
    assert_eq!(
        active, 1,
        "reserve loser must get typed ActiveRun: {results:?}"
    );

    let marker = root
        .join("active")
        .join("repo-race")
        .join("main")
        .join("nonterminal.lock");
    assert_eq!(fs::read_to_string(&marker)?, acquired[0]);
    assert_eq!(count_files(marker.parent().ok_or("marker parent")?)?, 1);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn append_race_rejects_or_preserves_both_rows_without_corruption()
-> Result<(), Box<dyn std::error::Error>> {
    let root = temp_root("append")?;
    let barrier = root.join("start");
    let result_a = root.join("a.result");
    let result_b = root.join("b.result");
    let a = spawn_child(
        "append",
        root.clone(),
        "a".to_owned(),
        barrier.clone(),
        result_a.clone(),
    )?;
    let b = spawn_child(
        "append",
        root.clone(),
        "b".to_owned(),
        barrier.clone(),
        result_b.clone(),
    )?;
    fs::write(&barrier, b"go")?;
    assert_child_success(a)?;
    assert_child_success(b)?;

    let results = [
        fs::read_to_string(&result_a)?,
        fs::read_to_string(&result_b)?,
    ];
    let errors: Vec<&String> = results
        .iter()
        .filter(|value| value.starts_with("error:"))
        .collect();
    let store = FsStore::open(&root).map_err(|error| format!("{error:?}"))?;
    let (events, cache) = store
        .replay_inputs()
        .map_err(|error| format!("{error:?}"))?;
    assert!(
        matches!(cache, CacheRead::Absent | CacheRead::Present(_)),
        "cache must parse or be absent"
    );
    let raw = fs::read(root.join("events.jsonl"))?;
    assert_eq!(raw.last(), Some(&b'\n'), "events.jsonl has corrupt tail");

    if errors.is_empty() {
        assert_eq!(
            events.len(),
            2,
            "lost update: results={results:?} events={}",
            event_summary(&events)
        );
        assert!(
            contains_ref(&events, "event/a"),
            "row a was lost: {}",
            event_summary(&events)
        );
        assert!(
            contains_ref(&events, "event/b"),
            "row b was lost: {}",
            event_summary(&events)
        );
        assert!(
            events
                .windows(2)
                .all(|pair| pair[0].sequence <= pair[1].sequence),
            "event sequence moved backwards: {}",
            event_summary(&events)
        );
    } else {
        assert_eq!(
            errors.len(),
            1,
            "only one writer may be rejected: {results:?}"
        );
        assert!(
            errors[0].contains("single-writer") || errors[0].contains("ActiveRun"),
            "append rejection must identify a single-writer authority: {results:?}"
        );
        assert_eq!(
            events.len(),
            1,
            "accepted writer's row must remain: {}",
            event_summary(&events)
        );
    }

    fs::remove_dir_all(root)?;
    Ok(())
}

fn spawn_child(
    mode: &'static str,
    root: PathBuf,
    role: String,
    barrier: PathBuf,
    result: PathBuf,
) -> Result<i32, Box<dyn std::error::Error>> {
    fork_process(move || {
        wait_for_barrier(&barrier).map_err(|error| error.to_string())?;
        let line = match mode {
            "reserve" => reserve_child(&root, &role),
            "append" => append_child(&root, &role),
            other => format!("error:unknown-mode:{other}"),
        };
        fs::write(result, line).map_err(|error| error.to_string())
    })
}

fn reserve_child(root: &Path, role: &str) -> String {
    let state = StateRoot::from_v2_root(root);
    match state.reserve(&identity(role)) {
        Ok(_lease) => format!("acquired:{role}"),
        Err(StateRootError::ActiveRun) => "active-run".to_owned(),
        Err(error) => format!("error:{error}"),
    }
}

fn append_child(root: &Path, role: &str) -> String {
    match FsStore::open(root).and_then(|mut store| Store::append_event(&mut store, &row(role))) {
        Ok(()) => "ok".to_owned(),
        Err(error) => format!("error:{error:?}"),
    }
}

fn row(role: &str) -> EventRow {
    let mut artifact_refs = Vec::with_capacity(50_001);
    artifact_refs.push(Ref(format!("event/{role}")));
    for index in 0..50_000 {
        artifact_refs.push(Ref(format!("pad/{role}/{index}")));
    }
    EventRow {
        sequence: 1,
        previous_revision: 0,
        new_revision: 1,
        kind: EventKind(format!("append-{role}")),
        artifact_refs,
    }
}

fn identity(run: &str) -> RunIdentity {
    RunIdentity {
        repo_key: Base32("repo-race".to_owned()),
        run_id: Uuidv7(run.to_owned()),
        workstream: Id("main".to_owned()),
    }
}

fn wait_for_barrier(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    for _ in 0..500 {
        if path.exists() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(10));
    }
    Err("barrier timeout".into())
}

fn contains_ref(events: &[EventRow], value: &str) -> bool {
    events.iter().any(|event| {
        event
            .artifact_refs
            .iter()
            .any(|artifact| artifact.0 == value)
    })
}

fn event_summary(events: &[EventRow]) -> String {
    events
        .iter()
        .map(|event| {
            let first_ref = event
                .artifact_refs
                .first()
                .map(|artifact| artifact.0.as_str())
                .unwrap_or("<none>");
            format!(
                "kind={} first_ref={} refs={}",
                event.kind.0,
                first_ref,
                event.artifact_refs.len()
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn count_files(path: &Path) -> Result<usize, Box<dyn std::error::Error>> {
    let mut count = 0;
    for entry in fs::read_dir(path)? {
        if entry?.file_type()?.is_file() {
            count += 1;
        }
    }
    Ok(count)
}

fn temp_root(label: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!(
        "pi-autopilot-multiprocess-{label}-{}-{n}",
        std::process::id()
    ));
    fs::create_dir_all(&root)?;
    Ok(root)
}

fn fork_process<F>(job: F) -> Result<i32, Box<dyn std::error::Error>>
where
    F: FnOnce() -> Result<(), String>,
{
    let pid = unsafe { fork() };
    if pid < 0 {
        return Err(io::Error::last_os_error().into());
    }
    if pid == 0 {
        let code = if job().is_ok() { 0 } else { 1 };
        unsafe { _exit(code) };
    }
    Ok(pid)
}

fn assert_child_success(pid: i32) -> Result<(), Box<dyn std::error::Error>> {
    let mut status = 0;
    let waited = unsafe { waitpid(pid, &mut status, 0) };
    if waited != pid {
        return Err(io::Error::last_os_error().into());
    }
    assert_eq!(
        exit_code(status),
        Some(0),
        "child {pid} failed with status {status}"
    );
    Ok(())
}

fn exit_code(status: i32) -> Option<i32> {
    if status & 0x7f == 0 {
        Some((status >> 8) & 0xff)
    } else {
        None
    }
}

unsafe extern "C" {
    fn fork() -> i32;
    fn _exit(status: i32) -> !;
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
}
