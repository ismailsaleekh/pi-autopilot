use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest as ShaDigest, Sha256};

use crate::generated::{Digest as StateDigest, EventKind, EventRow, Ref};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub sequence: u64,
    pub revision: u64,
    pub rows: u64,
    pub accepted: u64,
    pub rejected: u64,
    pub kinds: BTreeMap<EventKind, u64>,
    pub refs: BTreeMap<Ref, u64>,
    pub issues: Vec<StateIssue>,
}

impl State {
    pub const EMPTY: Self = Self {
        sequence: 0,
        revision: 0,
        rows: 0,
        accepted: 0,
        rejected: 0,
        kinds: BTreeMap::new(),
        refs: BTreeMap::new(),
        issues: Vec::new(),
    };

    pub fn state_hash(&self) -> StateDigest {
        let mut bytes = Vec::new();
        self.encode(&mut bytes);
        let digest = Sha256::digest(&bytes);
        StateDigest(hex(&digest))
    }

    fn encode(&self, out: &mut Vec<u8>) {
        push_u64(out, self.sequence);
        push_u64(out, self.revision);
        push_u64(out, self.rows);
        push_u64(out, self.accepted);
        push_u64(out, self.rejected);
        push_u64(out, self.kinds.len() as u64);
        for (kind, count) in &self.kinds {
            push_str(out, &kind.0);
            push_u64(out, *count);
        }
        push_u64(out, self.refs.len() as u64);
        for (reference, count) in &self.refs {
            push_str(out, &reference.0);
            push_u64(out, *count);
        }
        push_u64(out, self.issues.len() as u64);
        for issue in &self.issues {
            issue.encode(out);
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StateIssue {
    pub at: u64,
    pub kind: StateIssueKind,
    pub expected: u64,
    pub actual: u64,
}

impl StateIssue {
    fn encode(&self, out: &mut Vec<u8>) {
        push_u64(out, self.at);
        out.push(self.kind.code());
        push_u64(out, self.expected);
        push_u64(out, self.actual);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum StateIssueKind {
    SequenceGap,
    SequenceRegression,
    SequenceOverflow,
    RevisionMismatch,
    CounterOverflow,
}

impl StateIssueKind {
    fn code(self) -> u8 {
        match self {
            Self::SequenceGap => 1,
            Self::SequenceRegression => 2,
            Self::SequenceOverflow => 3,
            Self::RevisionMismatch => 4,
            Self::CounterOverflow => 5,
        }
    }
}

pub fn apply(mut state: State, event: &EventRow) -> State {
    note_count(&mut state, Counter::Rows, event.sequence);

    let mut row_ok = true;
    match state.sequence.checked_add(1) {
        Some(expected) if event.sequence == expected => {}
        Some(expected) if event.sequence > expected => {
            state.issues.push(StateIssue {
                at: event.sequence,
                kind: StateIssueKind::SequenceGap,
                expected,
                actual: event.sequence,
            });
            state.sequence = event.sequence;
            row_ok = false;
        }
        Some(expected) => {
            state.issues.push(StateIssue {
                at: event.sequence,
                kind: StateIssueKind::SequenceRegression,
                expected,
                actual: event.sequence,
            });
            row_ok = false;
        }
        None => {
            state.issues.push(StateIssue {
                at: event.sequence,
                kind: StateIssueKind::SequenceOverflow,
                expected: u64::MAX,
                actual: event.sequence,
            });
            row_ok = false;
        }
    }

    if event.previous_revision != state.revision {
        state.issues.push(StateIssue {
            at: event.sequence,
            kind: StateIssueKind::RevisionMismatch,
            expected: state.revision,
            actual: event.previous_revision,
        });
        row_ok = false;
    }

    if row_ok {
        state.sequence = event.sequence;
        state.revision = event.new_revision;
        note_count(&mut state, Counter::Accepted, event.sequence);
        note_key(
            &mut state.kinds,
            event.kind.clone(),
            event.sequence,
            &mut state.issues,
        );
        for reference in &event.artifact_refs {
            note_key(
                &mut state.refs,
                reference.clone(),
                event.sequence,
                &mut state.issues,
            );
        }
    } else {
        note_count(&mut state, Counter::Rejected, event.sequence);
    }

    state
}

pub fn fold_events(events: &[EventRow]) -> State {
    events.iter().fold(State::EMPTY, apply)
}

enum Counter {
    Rows,
    Accepted,
    Rejected,
}

fn note_count(state: &mut State, counter: Counter, at: u64) {
    let slot = match counter {
        Counter::Rows => &mut state.rows,
        Counter::Accepted => &mut state.accepted,
        Counter::Rejected => &mut state.rejected,
    };
    if !bump(slot) {
        state.issues.push(StateIssue {
            at,
            kind: StateIssueKind::CounterOverflow,
            expected: u64::MAX,
            actual: *slot,
        });
    }
}

fn note_key<K: Ord>(map: &mut BTreeMap<K, u64>, key: K, at: u64, issues: &mut Vec<StateIssue>) {
    let overflow = {
        let entry = map.entry(key).or_insert(0);
        !bump(entry)
    };
    if overflow {
        issues.push(StateIssue {
            at,
            kind: StateIssueKind::CounterOverflow,
            expected: u64::MAX,
            actual: u64::MAX,
        });
    }
}

fn bump(value: &mut u64) -> bool {
    match value.checked_add(1) {
        Some(next) => {
            *value = next;
            true
        }
        None => false,
    }
}

fn push_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn push_str(out: &mut Vec<u8>, value: &str) {
    push_u64(out, value.len() as u64);
    out.extend_from_slice(value.as_bytes());
}

fn hex(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(TABLE[(byte >> 4) as usize] as char);
        out.push(TABLE[(byte & 0x0f) as usize] as char);
    }
    out
}
