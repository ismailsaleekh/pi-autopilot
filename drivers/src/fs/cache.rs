use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use kernel::{
    failure::{Failure, HardBoundary, RecoveryRoute, RetryPolicy},
    generated::{EventRow, StateCache},
    log::{CacheImage, LogEffect},
    platform::{CacheRead, Store},
    state::State,
};
use serde::{Deserialize, Serialize};

static TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub struct FsStore {
    root: PathBuf,
    events: PathBuf,
    cache: PathBuf,
}

#[derive(Deserialize, Serialize)]
struct StoredImage {
    state: State,
    cache: StateCache,
}

impl FsStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, Failure> {
        Self::with_paths(root, "events.jsonl", "state.json")
    }

    pub fn with_paths(
        root: impl AsRef<Path>,
        events: impl AsRef<Path>,
        cache: impl AsRef<Path>,
    ) -> Result<Self, Failure> {
        fs::create_dir_all(root.as_ref()).map_err(map_io)?;
        set_dir_mode(root.as_ref())?;
        Ok(Self {
            root: fs::canonicalize(root.as_ref()).map_err(map_io)?,
            events: checked(events.as_ref())?,
            cache: checked(cache.as_ref())?,
        })
    }

    pub fn apply(&mut self, effect: &LogEffect) -> Result<(), Failure> {
        match effect {
            LogEffect::Append(row) => Store::append_event(self, row),
            LogEffect::Store(image) => Store::write_cache(self, image),
        }
    }

    pub fn replay_inputs(&self) -> Result<(Vec<EventRow>, CacheRead), Failure> {
        Ok((Store::read_events(self)?, Store::read_cache(self)?))
    }

    pub fn cache_path(&self) -> PathBuf {
        self.root.join(&self.cache)
    }

    fn target(&self, leaf: &Path) -> Result<PathBuf, Failure> {
        let path = self.root.join(leaf);
        match fs::read_link(&path) {
            Ok(_) => return Err(unsafe_write()),
            Err(err)
                if err.kind() == io::ErrorKind::InvalidInput
                    || err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(map_io(err)),
        }
        match fs::canonicalize(&path) {
            Ok(real) if under(&real, &self.root) => Ok(path),
            Ok(_) => Err(unsafe_write()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(path),
            Err(err) => Err(map_io(err)),
        }
    }
}

impl Store for FsStore {
    fn append_event(&mut self, row: &EventRow) -> Result<(), Failure> {
        let path = self.target(&self.events)?;
        let mut body = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(err) => return Err(map_io(err)),
        };
        if !body.is_empty() && body.last() != Some(&b'\n') {
            return Err(corrupt());
        }
        serde_json::to_writer(&mut body, row).map_err(map_data)?;
        body.push(b'\n');
        atomic_replace(&self.root, &self.events, &body)
    }

    fn write_cache(&mut self, image: &CacheImage) -> Result<(), Failure> {
        drop(self.target(&self.cache)?);
        let stored = StoredImage {
            state: image.state.clone(),
            cache: image.cache.clone(),
        };
        atomic_replace(
            &self.root,
            &self.cache,
            &serde_json::to_vec(&stored).map_err(map_data)?,
        )
    }

    fn read_events(&self) -> Result<Vec<EventRow>, Failure> {
        let text = match fs::read_to_string(self.target(&self.events)?) {
            Ok(value) => value,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(map_io(err)),
        };
        text.lines()
            .map(|line| serde_json::from_str(line).map_err(map_data))
            .collect()
    }

    fn read_cache(&self) -> Result<CacheRead, Failure> {
        let text = match fs::read_to_string(self.target(&self.cache)?) {
            Ok(value) => value,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(CacheRead::Absent),
            Err(err) => return Err(map_io(err)),
        };
        let stored: StoredImage = serde_json::from_str(&text).map_err(map_data)?;
        Ok(CacheRead::Present(CacheImage {
            state: stored.state,
            cache: stored.cache,
        }))
    }
}

fn checked(path: &Path) -> Result<PathBuf, Failure> {
    if path.is_absolute() {
        return Err(unsafe_write());
    }
    match (path.components().next(), path.components().nth(1)) {
        (Some(Component::Normal(value)), None) => Ok(PathBuf::from(value)),
        _ => Err(unsafe_write()),
    }
}

fn atomic_replace(root: &Path, leaf: &Path, bytes: &[u8]) -> Result<(), Failure> {
    let target = root.join(leaf);
    let temp = root.join(format!(
        ".{}.{}.{}.tmp",
        leaf.display(),
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(map_io)?;
    set_file_mode(&file)?;
    file.write_all(bytes).map_err(map_io)?;
    file.sync_all().map_err(map_io)?;
    drop(file);
    fs::rename(&temp, target).map_err(map_io)?;
    File::open(root)
        .and_then(|dir| dir.sync_all())
        .map_err(map_io)?;
    Ok(())
}

fn under(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root).is_ok()
}

#[cfg(unix)]
fn set_dir_mode(path: &Path) -> Result<(), Failure> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(map_io)
}

#[cfg(unix)]
fn set_file_mode(file: &File) -> Result<(), Failure> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(map_io)
}

#[cfg(not(unix))]
fn set_dir_mode(path: &Path) -> Result<(), Failure> {
    let _path = path;
    Ok(())
}

#[cfg(not(unix))]
fn set_file_mode(file: &File) -> Result<(), Failure> {
    let _file = file;
    Ok(())
}

fn unsafe_write() -> Failure {
    Failure::Unsafe {
        boundary: HardBoundary::OutOfScopeWrite,
    }
}

fn corrupt() -> Failure {
    Failure::Recoverable {
        route: RecoveryRoute::Tier1,
    }
}

fn map_data(error: serde_json::Error) -> Failure {
    drop(error);
    corrupt()
}

fn map_io(error: io::Error) -> Failure {
    drop(error);
    Failure::Transient {
        retry: RetryPolicy::Backoff,
    }
}
