use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use kernel::{
    generated::{EventRow, Id, Ref},
    state::{State, fold_events},
};

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ResultArtifact {
    pub result_ref: Ref,
    pub event_ref: Ref,
    pub commit_ref: Ref,
    pub evidence_refs: Vec<Ref>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum LockState {
    Free,
    HeldByLive { pid: u32 },
    HeldByDead { pid: u32 },
    Degraded { reason: String },
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RestartInput {
    pub assignment_id: Id,
    pub event_refs: Vec<Ref>,
    pub git_refs: Vec<Ref>,
    pub create_once_refs: Vec<Ref>,
    pub checkpoint_refs: Vec<Ref>,
    pub result: Option<ResultArtifact>,
    pub lock: LockState,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum RestartDecision {
    ResumeWithNewBgRun { assignment_id: Id },
    VisibleWait { assignment_id: Id, holder_pid: u32 },
    Degraded { assignment_id: Id, reason: String },
    AcceptResult { result_ref: Ref },
    RejectResult { assignment_id: Id, reason: String },
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum IntegrationCrashDecision {
    CasNeeded,
    AlreadyAccepted,
    Conflict,
}

pub fn reconcile_restart(input: &RestartInput) -> RestartDecision {
    if let Err(reason) = validate_refs(input) {
        return RestartDecision::RejectResult {
            assignment_id: input.assignment_id.clone(),
            reason,
        };
    }
    if let Some(result) = &input.result {
        return RestartDecision::AcceptResult {
            result_ref: result.result_ref.clone(),
        };
    }
    match &input.lock {
        LockState::Free | LockState::HeldByDead { .. } => RestartDecision::ResumeWithNewBgRun {
            assignment_id: input.assignment_id.clone(),
        },
        LockState::HeldByLive { pid } => RestartDecision::VisibleWait {
            assignment_id: input.assignment_id.clone(),
            holder_pid: *pid,
        },
        LockState::Degraded { reason } => RestartDecision::Degraded {
            assignment_id: input.assignment_id.clone(),
            reason: reason.clone(),
        },
    }
}

pub fn replay_after_crash(events: &[EventRow]) -> State {
    fold_events(events)
}

pub fn reconcile_integration_crash(
    old_tip: &str,
    expected_new_tip: &str,
    current_tip: &str,
) -> IntegrationCrashDecision {
    if current_tip == expected_new_tip {
        IntegrationCrashDecision::AlreadyAccepted
    } else if current_tip == old_tip {
        IntegrationCrashDecision::CasNeeded
    } else {
        IntegrationCrashDecision::Conflict
    }
}

fn validate_refs(input: &RestartInput) -> Result<(), String> {
    for (index, artifact) in input.create_once_refs.iter().enumerate() {
        if input.create_once_refs[..index]
            .iter()
            .any(|seen| seen == artifact)
        {
            return Err(format!("duplicate-create-once:{}", artifact.0));
        }
        if !contains_ref(&input.event_refs, artifact) {
            return Err(format!("create-once-without-event:{}", artifact.0));
        }
    }
    for checkpoint in &input.checkpoint_refs {
        if !contains_ref(&input.event_refs, checkpoint) {
            return Err(format!("checkpoint-without-event:{}", checkpoint.0));
        }
    }
    if let Some(result) = &input.result {
        if result.evidence_refs.is_empty() {
            return Err(format!("result-without-evidence:{}", result.result_ref.0));
        }
        if !contains_ref(&input.event_refs, &result.event_ref) {
            return Err(format!("result-without-event:{}", result.result_ref.0));
        }
        if !contains_ref(&input.git_refs, &result.commit_ref) {
            return Err(format!("result-without-git:{}", result.result_ref.0));
        }
    }
    Ok(())
}

fn contains_ref(values: &[Ref], needle: &Ref) -> bool {
    values.iter().any(|value| value == needle)
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProcessBirthIdentity(pub String);

pub trait ProcessProbe {
    fn is_live(&self, pid: u32) -> bool;
    fn birth_identity(&self, pid: u32) -> Result<Option<ProcessBirthIdentity>, String> {
        if self.is_live(pid) {
            Ok(Some(ProcessBirthIdentity(format!("live-pid:{pid}"))))
        } else {
            Ok(None)
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum LockAcquire {
    Acquired(FileAssignmentLock),
    HeldByLive { pid: u32 },
    Degraded { reason: String },
}

#[derive(Debug, Eq, PartialEq)]
pub struct FileAssignmentLock {
    path: PathBuf,
    pid: u32,
    birth_identity: ProcessBirthIdentity,
}

#[derive(Debug, Eq, PartialEq)]
struct StoredLock {
    pid: u32,
    birth_identity: Option<ProcessBirthIdentity>,
    bytes: Vec<u8>,
}

impl FileAssignmentLock {
    pub fn acquire(
        root: &Path,
        assignment_id: &Id,
        pid: u32,
        probe: &dyn ProcessProbe,
    ) -> LockAcquire {
        let path = root.join(format!("{}.lock", assignment_id.0));
        match create_lock(&path, pid, probe) {
            Ok(birth_identity) => LockAcquire::Acquired(Self {
                path,
                pid,
                birth_identity,
            }),
            Err(message) if message == "occupied" => held_lock(path, pid, probe),
            Err(message) => LockAcquire::Degraded { reason: message },
        }
    }
    pub fn pid(&self) -> u32 {
        self.pid
    }
    pub fn birth_identity(&self) -> &ProcessBirthIdentity {
        &self.birth_identity
    }
    pub fn release(self) -> Result<(), String> {
        fs::remove_file(&self.path).map_err(|error| format!("lock-release:{error}"))
    }
}

fn held_lock(path: PathBuf, pid: u32, probe: &dyn ProcessProbe) -> LockAcquire {
    let lock = match read_lock(&path) {
        Ok(lock) => lock,
        Err(error) => return LockAcquire::Degraded { reason: error },
    };
    match live_holder_matches(&lock, probe) {
        Ok(true) => LockAcquire::HeldByLive { pid: lock.pid },
        Ok(false) => match current_birth_identity(pid, probe) {
            Ok(birth_identity) => reclaim_stale_lock(path, pid, birth_identity, lock.bytes),
            Err(reason) => LockAcquire::Degraded { reason },
        },
        Err(reason) => LockAcquire::Degraded { reason },
    }
}

fn live_holder_matches(lock: &StoredLock, probe: &dyn ProcessProbe) -> Result<bool, String> {
    if !probe.is_live(lock.pid) {
        return Ok(false);
    }
    let Some(recorded) = &lock.birth_identity else {
        return Err(format!("lock-missing-birth-identity:{}", lock.pid));
    };
    match probe.birth_identity(lock.pid)? {
        Some(current) => Ok(&current == recorded),
        None => Err(format!("lock-holder-identity-unavailable:{}", lock.pid)),
    }
}

fn reclaim_stale_lock(
    path: PathBuf,
    pid: u32,
    birth_identity: ProcessBirthIdentity,
    stale_bytes: Vec<u8>,
) -> LockAcquire {
    if let Err(reason) = preserve_stale_lock(&path, &stale_bytes) {
        return LockAcquire::Degraded { reason };
    }
    if let Err(error) = fs::remove_file(&path) {
        return LockAcquire::Degraded {
            reason: format!("stale-lock-remove-failed:{error}"),
        };
    }
    match create_lock_with_identity(&path, pid, birth_identity) {
        Ok(birth_identity) => LockAcquire::Acquired(FileAssignmentLock {
            path,
            pid,
            birth_identity,
        }),
        Err(message) => LockAcquire::Degraded { reason: message },
    }
}

fn current_birth_identity(
    pid: u32,
    probe: &dyn ProcessProbe,
) -> Result<ProcessBirthIdentity, String> {
    let Some(identity) = probe.birth_identity(pid)? else {
        return Err(format!("lock-owner-identity-unavailable:{pid}"));
    };
    if identity.0.is_empty() || identity.0.contains('\n') || identity.0.contains('\r') {
        return Err(format!("lock-owner-identity-invalid:{pid}"));
    }
    Ok(identity)
}

fn create_lock(
    path: &Path,
    pid: u32,
    probe: &dyn ProcessProbe,
) -> Result<ProcessBirthIdentity, String> {
    let mut file = open_new_lock(path)?;
    let birth_identity = match current_birth_identity(pid, probe) {
        Ok(identity) => identity,
        Err(reason) => {
            drop(file);
            if let Err(error) = fs::remove_file(path) {
                return Err(format!("lock-owner-identity-cleanup:{reason}:{error}"));
            }
            return Err(reason);
        }
    };
    write_lock(&mut file, pid, &birth_identity)?;
    Ok(birth_identity)
}

fn create_lock_with_identity(
    path: &Path,
    pid: u32,
    birth_identity: ProcessBirthIdentity,
) -> Result<ProcessBirthIdentity, String> {
    let mut file = open_new_lock(path)?;
    write_lock(&mut file, pid, &birth_identity)?;
    Ok(birth_identity)
}

fn open_new_lock(path: &Path) -> Result<fs::File, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("lock-dir:{error}"))?;
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "occupied".to_owned()
            } else {
                format!("lock-create:{error}")
            }
        })
}

fn write_lock(
    file: &mut fs::File,
    pid: u32,
    birth_identity: &ProcessBirthIdentity,
) -> Result<(), String> {
    write!(file, "pid={pid}\nbirth={}\n", birth_identity.0)
        .map_err(|error| format!("lock-write:{error}"))
}

fn read_lock(path: &Path) -> Result<StoredLock, String> {
    let bytes = fs::read(path).map_err(|error| format!("lock-open:{error}"))?;
    let text = std::str::from_utf8(&bytes).map_err(|error| format!("lock-utf8:{error}"))?;
    if let Ok(pid) = text.trim().parse::<u32>() {
        return Ok(StoredLock {
            pid,
            birth_identity: None,
            bytes,
        });
    }
    let mut pid = None;
    let mut birth_identity = None;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("pid=") {
            pid = Some(
                value
                    .parse::<u32>()
                    .map_err(|error| format!("lock-pid:{error}"))?,
            );
        } else if let Some(value) = line.strip_prefix("birth=") {
            if value.is_empty() {
                return Err("lock-birth-empty".to_owned());
            }
            birth_identity = Some(ProcessBirthIdentity(value.to_owned()));
        } else if !line.is_empty() {
            return Err(format!("lock-field:{line}"));
        }
    }
    Ok(StoredLock {
        pid: pid.ok_or_else(|| "lock-pid-missing".to_owned())?,
        birth_identity,
        bytes,
    })
}

fn preserve_stale_lock(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let evidence = path
        .parent()
        .ok_or_else(|| "stale-lock-evidence-parent".to_owned())?
        .join("stale-lock-evidence");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&evidence)
        .map_err(|error| format!("stale-lock-evidence-create:{error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("stale-lock-evidence-write:{error}"))
}
