use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use kernel::{generated::{EventRow, Id, Ref}, state::{State, fold_events}};

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
        if input.create_once_refs[..index].iter().any(|seen| seen == artifact) {
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

pub trait ProcessProbe {
    fn is_live(&self, pid: u32) -> bool;
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
}

impl FileAssignmentLock {
    pub fn acquire(
        root: &Path,
        assignment_id: &Id,
        pid: u32,
        probe: &dyn ProcessProbe,
    ) -> LockAcquire {
        let path = root.join(format!("{}.lock", assignment_id.0));
        match create_lock(&path, pid) {
            Ok(()) => LockAcquire::Acquired(Self { path, pid }),
            Err(message) if message == "occupied" => held_lock(path, pid, probe),
            Err(message) => LockAcquire::Degraded { reason: message },
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }
}

impl FileAssignmentLock {
    pub fn release(self) -> Result<(), String> {
        fs::remove_file(&self.path).map_err(|error| format!("lock-release:{error}"))
    }
}

fn held_lock(path: PathBuf, pid: u32, probe: &dyn ProcessProbe) -> LockAcquire {
    match read_pid(&path) {
        Ok(holder) if probe.is_live(holder) => LockAcquire::HeldByLive { pid: holder },
        Ok(_) => match fs::remove_file(&path) {
            Ok(()) => match create_lock(&path, pid) {
                Ok(()) => LockAcquire::Acquired(FileAssignmentLock { path, pid }),
                Err(message) => LockAcquire::Degraded { reason: message },
            },
            Err(error) => LockAcquire::Degraded {
                reason: format!("stale-lock-remove-failed:{error}"),
            },
        },
        Err(error) => LockAcquire::Degraded { reason: error },
    }
}

fn create_lock(path: &Path, pid: u32) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("lock-dir:{error}"))?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.raw_os_error() == Some(17) {
                "occupied".to_owned()
            } else {
                format!("lock-create:{error}")
            }
        })?;
    write!(file, "{pid}").map_err(|error| format!("lock-write:{error}"))
}

fn read_pid(path: &Path) -> Result<u32, String> {
    let mut text = String::new();
    fs::File::open(path)
        .map_err(|error| format!("lock-open:{error}"))?
        .read_to_string(&mut text)
        .map_err(|error| format!("lock-read:{error}"))?;
    text.trim()
        .parse::<u32>()
        .map_err(|error| format!("lock-pid:{error}"))
}
