//! Drivers are the IO layer.

// D79 §7 and D77 §3.6 define IO as the drivers layer's purpose.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod bgtasks;
pub mod clock;
pub mod context;
pub mod entropy;
pub mod fs;
pub mod planning;
pub mod prompt;
pub mod roles;
pub mod roster;
pub mod seam;
pub mod sim;
pub mod state_root;
pub mod transcript;
pub mod vcs;
