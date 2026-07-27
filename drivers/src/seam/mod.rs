use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use kernel::boundary::{BoundaryDescriptor, BoundaryRuntime, Rejection, boundary_by_id};
use kernel::generated::{
    CONTRACT_VERSION, CoreToHostDonePayload, CoreToHostGuardDecisionPayload, EventKind, EventRow,
    GuardDecision, HostToCoreAgentResultPayload, HostToCoreCommandPayload,
    HostToCoreGuardQueryPayload, HostToCoreOperatorAnswerPayload, HostToCoreShutdownPayload,
    HostToCoreTaskCompletedPayload, Ref, SeamEnvelope,
};
use kernel::state::{State, apply};
use kernel_macros::acceptance_boundary;
use serde::de::DeserializeOwned;

pub mod sim_host;

const BOUNDARY_ID: &str = "seam.host-frame.v1";
type AnyError = Box<dyn std::error::Error>;

#[derive(Debug)]
pub struct CoreState {
    event_path: Option<PathBuf>,
    state: State,
}

impl CoreState {
    pub fn open(event_path: Option<PathBuf>) -> Result<Self, AnyError> {
        let state = match event_path.as_deref() {
            Some(path) => replay_path(path)?,
            None => State::EMPTY,
        };
        Ok(Self { event_path, state })
    }

    fn append(&mut self, kind: EventKind, artifact_refs: Vec<Ref>) -> Result<(), AnyError> {
        let event = EventRow {
            sequence: self
                .state
                .sequence
                .checked_add(1)
                .ok_or("event sequence overflow")?,
            previous_revision: self.state.revision,
            new_revision: self
                .state
                .revision
                .checked_add(1)
                .ok_or("event revision overflow")?,
            kind,
            artifact_refs,
        };
        if let Some(path) = &self.event_path {
            append_event(path, &event)?;
        }
        self.state = apply(self.state.clone(), &event);
        Ok(())
    }

    fn summary(&self) -> String {
        format!(
            "state:sequence={};revision={};hash={}",
            self.state.sequence,
            self.state.revision,
            self.state.state_hash().0
        )
    }
}

pub fn run<R: BufRead, W: Write>(
    reader: R,
    writer: &mut W,
    state: &mut CoreState,
) -> Result<(), AnyError> {
    for line in reader.lines() {
        write_frame(writer, &handle_line(&line?, state)?)?;
    }
    Ok(())
}

pub fn handle_line(line: &str, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let envelope = match serde_json::from_str::<SeamEnvelope>(line) {
        Ok(frame) => frame,
        Err(error) => return done(0, rejection("malformed-json", &error.to_string())),
    };
    let id = envelope.id;
    match admit_host_frame(envelope) {
        Ok(frame) => dispatch(frame, state),
        Err(error) => done(id, rejection(error.boundary_id(), error.actual())),
    }
}

#[acceptance_boundary(
    id = "seam.host-frame.v1",
    producer = Producer::Host,
    visible = true,
    admits = "Host newline JSON must be contract v=1 with a known host-to-core kind and generated payload shape.",
    mode = BoundaryMode::Enforce
)]
pub fn admit_host_frame(frame: SeamEnvelope) -> Result<SeamEnvelope, Rejection> {
    if frame.v != CONTRACT_VERSION as u32 {
        rt().reject(format!("version-mismatch:{}", frame.v))?;
    }
    match frame.kind.as_str() {
        "agent-result" => payload::<HostToCoreAgentResultPayload>(&frame)?,
        "command" => payload::<HostToCoreCommandPayload>(&frame)?,
        "guard-query" => payload::<HostToCoreGuardQueryPayload>(&frame)?,
        "operator-answer" => payload::<HostToCoreOperatorAnswerPayload>(&frame)?,
        "shutdown" => payload::<HostToCoreShutdownPayload>(&frame)?,
        "task-completed" => payload::<HostToCoreTaskCompletedPayload>(&frame)?,
        other => rt().reject(format!("unknown-kind:{other}"))?,
    }
    Ok(frame)
}

fn dispatch(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    match frame.kind.as_str() {
        "command" => command(frame, state),
        "guard-query" => guard_decision(frame.id, "deny", "core guard policy is not configured"),
        "shutdown" => done(frame.id, "ok:shutdown".to_owned()),
        "task-completed" | "agent-result" | "operator-answer" => {
            done(frame.id, "ok:recorded".to_owned())
        }
        other => done(frame.id, rejection("unknown-kind", other)),
    }
}

fn command(frame: SeamEnvelope, state: &mut CoreState) -> Result<SeamEnvelope, AnyError> {
    let HostToCoreCommandPayload { raw } = serde_json::from_value(frame.payload)?;
    if raw == "state" {
        return done(frame.id, state.summary());
    }
    let (verb, rest) = match raw.split_once(':') {
        Some(parts) => parts,
        None => return done(frame.id, rejection("malformed-command", &raw)),
    };
    let pause = match verb {
        "append" => false,
        "crash-window" => true,
        "state" => return done(frame.id, rejection("malformed-command", verb)),
        other => return done(frame.id, rejection("unknown-command", other)),
    };
    let (kind, reference) = match event_parts(rest) {
        Ok(parts) => parts,
        Err(status) => return done(frame.id, status),
    };
    state.append(kind, vec![reference])?;
    if pause {
        eprintln!("autopilot-core: crash-window-ready {}", state.summary());
        thread::sleep(Duration::from_secs(30));
    }
    done(frame.id, state.summary())
}

fn event_parts(rest: &str) -> Result<(EventKind, Ref), String> {
    let (kind, reference) = match rest.split_once(':') {
        Some(parts) => parts,
        None => return Err(rejection("malformed-command", "missing-event-ref")),
    };
    if kind.is_empty() {
        return Err(rejection("malformed-command", "empty-event-kind"));
    }
    if reference.is_empty() {
        return Err(rejection("malformed-command", "empty-event-ref"));
    }
    Ok((EventKind(kind.to_owned()), Ref(reference.to_owned())))
}

fn payload<T: DeserializeOwned>(frame: &SeamEnvelope) -> Result<(), Rejection> {
    if let Err(error) = serde_json::from_value::<T>(frame.payload.clone()) {
        rt().reject(format!("payload-mismatch:{}:{error}", frame.kind))?;
    }
    Ok(())
}

fn done(id: u64, status: String) -> Result<SeamEnvelope, AnyError> {
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "done".to_owned(),
        payload: serde_json::to_value(CoreToHostDonePayload { status })?,
    })
}

fn guard_decision(id: u64, value: &str, reason: &str) -> Result<SeamEnvelope, AnyError> {
    Ok(SeamEnvelope {
        v: CONTRACT_VERSION as u32,
        id,
        kind: "guard-decision".to_owned(),
        payload: serde_json::to_value(CoreToHostGuardDecisionPayload {
            decision: GuardDecision(value.to_owned()),
            reason: reason.to_owned(),
        })?,
    })
}

fn write_frame<W: Write>(writer: &mut W, frame: &SeamEnvelope) -> Result<(), AnyError> {
    serde_json::to_writer(&mut *writer, frame)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn replay_path(path: &Path) -> Result<State, AnyError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(State::EMPTY),
        Err(error) => return Err(error.into()),
    };
    let mut state = State::EMPTY;
    for line in io::BufReader::new(file).lines() {
        state = apply(state, &serde_json::from_str::<EventRow>(&line?)?);
    }
    Ok(state)
}

fn append_event(path: &Path, event: &EventRow) -> Result<(), AnyError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, event)?;
    file.write_all(b"\n")?;
    file.sync_data()?;
    Ok(())
}

fn rejection(code: &str, detail: &str) -> String {
    format!("rejection:{code}:{detail}")
}

fn rt() -> BoundaryRuntime {
    let descriptor: &'static BoundaryDescriptor = match boundary_by_id(BOUNDARY_ID) {
        Some(descriptor) => descriptor,
        None => panic!("missing boundary {BOUNDARY_ID}"),
    };
    match BoundaryRuntime::new(descriptor) {
        Ok(runtime) => runtime,
        Err(error) => panic!("runtime missing for {BOUNDARY_ID}: {error}"),
    }
}
