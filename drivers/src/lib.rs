//! Drivers are the IO layer.

// D79 §7 and D77 §3.6 define IO as the drivers layer's purpose.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod clock;
pub mod entropy;
pub mod fs;
pub mod seam;
pub mod sim;
pub mod vcs;
