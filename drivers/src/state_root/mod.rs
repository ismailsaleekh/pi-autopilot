use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use kernel::generated::{Base32, Id, RunIdentity, Uuidv7};
use sha2::{Digest as _, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

const REPO_SALT: &[u8] = b"autopilot-repo-v1\0";

#[derive(Debug, Eq, PartialEq)]
pub enum StateRootError {
    ActiveRun,
    Io,
    NonUtf8Path,
}

impl fmt::Display for StateRootError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ActiveRun => formatter.write_str("active run already reserved"),
            Self::Io => formatter.write_str("state root io error"),
            Self::NonUtf8Path => formatter.write_str("state root path is not utf8"),
        }
    }
}

impl std::error::Error for StateRootError {}

#[derive(Debug, Clone)]
pub struct StateRoot {
    root: PathBuf,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RunPaths {
    pub run_dir: PathBuf,
    pub worktree_dir: PathBuf,
}

#[derive(Debug)]
pub struct RunLease {
    marker: PathBuf,
}

impl StateRoot {
    pub fn from_home(home: impl AsRef<Path>) -> Self {
        Self {
            root: home
                .as_ref()
                .join(".pi")
                .join("agent")
                .join("autopilot")
                .join("v2"),
        }
    }

    pub fn from_v2_root(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
        }
    }

    pub fn reserve(&self, identity: &RunIdentity) -> Result<RunLease, StateRootError> {
        let dir = self
            .root
            .join("active")
            .join(&identity.repo_key.0)
            .join(&identity.workstream.0);
        private_dir(&dir)?;
        let marker = dir.join("nonterminal.lock");
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
        {
            Ok(mut file) => {
                private_handle(&file)?;
                file.write_all(identity.run_id.0.as_bytes())
                    .map_err(map_io)?;
                file.sync_all().map_err(map_io)?;
                Ok(RunLease { marker })
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(StateRootError::ActiveRun)
            }
            Err(error) => Err(map_io(error)),
        }
    }

    pub fn materialize(&self, identity: &RunIdentity) -> Result<RunPaths, StateRootError> {
        let run_dir = self
            .root
            .join("runs")
            .join(&identity.repo_key.0)
            .join(&identity.run_id.0);
        let worktree_dir = self
            .root
            .join("worktrees")
            .join(&identity.repo_key.0)
            .join(&identity.run_id.0);
        private_dir(&run_dir)?;
        private_dir(&worktree_dir)?;
        Ok(RunPaths {
            run_dir,
            worktree_dir,
        })
    }

    pub fn write_private(
        &self,
        relative: impl AsRef<Path>,
        bytes: &[u8],
    ) -> Result<PathBuf, StateRootError> {
        let path = self.root.join(relative.as_ref());
        let parent = path.parent().ok_or(StateRootError::Io)?;
        private_dir(parent)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .map_err(map_io)?;
        private_handle(&file)?;
        file.write_all(bytes).map_err(map_io)?;
        file.sync_all().map_err(map_io)?;
        Ok(path)
    }
}

impl RunLease {
    pub fn close(self) -> Result<(), StateRootError> {
        fs::remove_file(self.marker).map_err(map_io)
    }
}

pub fn identity_for(
    common_dir: impl AsRef<Path>,
    workstream: impl Into<String>,
) -> Result<RunIdentity, StateRootError> {
    Ok(RunIdentity {
        repo_key: repo_key(common_dir)?,
        run_id: new_run_id()?,
        workstream: Id(workstream.into()),
    })
}

pub fn repo_key(common_dir: impl AsRef<Path>) -> Result<Base32, StateRootError> {
    let real = fs::canonicalize(common_dir).map_err(map_io)?;
    #[cfg(unix)]
    let key = repo_key_from_canonical_bytes(real.as_os_str().as_bytes());
    #[cfg(not(unix))]
    let key =
        repo_key_from_canonical_bytes(real.to_str().ok_or(StateRootError::NonUtf8Path)?.as_bytes());
    Ok(key)
}

pub fn repo_key_from_canonical_bytes(realpath_bytes: &[u8]) -> Base32 {
    let mut bytes = Vec::with_capacity(REPO_SALT.len() + realpath_bytes.len());
    bytes.extend_from_slice(REPO_SALT);
    bytes.extend_from_slice(realpath_bytes);
    Base32(base32_lower(&Sha256::digest(&bytes)))
}

pub fn run_id_from_parts(millis: u64, random: [u8; 10]) -> Uuidv7 {
    let time = millis.to_be_bytes();
    let mut b = [0_u8; 16];
    b[0..6].copy_from_slice(&time[2..8]);
    b[6] = 0x70 | (random[0] & 0x0f);
    b[7] = random[1];
    b[8] = 0x80 | (random[2] & 0x3f);
    b[9..16].copy_from_slice(&random[3..10]);
    Uuidv7(hex_uuid(b))
}

fn new_run_id() -> Result<Uuidv7, StateRootError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StateRootError::Io)?
        .as_millis();
    let millis = u64::try_from(millis).map_err(|_| StateRootError::Io)?;
    let mut random = [0_u8; 10];
    File::open("/dev/urandom")
        .map_err(map_io)?
        .read_exact(&mut random)
        .map_err(map_io)?;
    Ok(run_id_from_parts(millis, random))
}

fn hex_uuid(bytes: [u8; 16]) -> String {
    let mut out = String::with_capacity(36);
    for (i, byte) in bytes.iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push(hex(byte >> 4));
        out.push(hex(byte & 15));
    }
    out
}

fn hex(nibble: u8) -> char {
    char::from(if nibble < 10 {
        b'0' + nibble
    } else {
        b'a' + (nibble - 10)
    })
}

fn private_dir(path: &Path) -> Result<(), StateRootError> {
    fs::create_dir_all(path).map_err(map_io)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(map_io)?;
    Ok(())
}

fn private_handle(file: &File) -> Result<(), StateRootError> {
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(map_io)?;
    Ok(())
}

fn map_io(_error: io::Error) -> StateRootError {
    StateRootError::Io
}

fn base32_lower(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::with_capacity((bytes.len() * 8).div_ceil(5));
    let mut buffer = 0_u16;
    let mut bits = 0_u8;
    for byte in bytes {
        buffer = (buffer << 8) | u16::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = usize::from((buffer >> bits) & 31);
            out.push(char::from(ALPHABET[index]));
        }
    }
    if bits > 0 {
        let index = usize::from((buffer << (5 - bits)) & 31);
        out.push(char::from(ALPHABET[index]));
    }
    out
}
