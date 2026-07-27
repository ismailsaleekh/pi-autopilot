//! Drivers are the IO layer.

// D79 §7 and D77 §3.6 define IO as the drivers layer's purpose.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod allocation;
pub mod bgtasks;
pub mod checkpoint;
pub mod closure;
pub mod clock;
pub mod context;
pub mod control;
pub mod conflict;
pub mod dispatch;
pub mod entropy;
pub mod finalize;
pub mod fs;
pub mod handoff;
pub mod integration;
pub mod lifecycle;
pub mod planning;
pub mod prompt;
pub mod recovery;
pub mod repair;
pub mod roles;
pub mod roster;
pub mod runner;
pub mod seam;
pub mod sim;
pub mod staleness;
pub mod state_root;
pub mod transcript;
pub mod validation;
pub mod vcs;
pub mod watchdog;
