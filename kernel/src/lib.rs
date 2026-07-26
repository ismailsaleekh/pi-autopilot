#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

//! Pure kernel crate with no domain vocabulary.

pub mod boundary;
pub mod generated;

pub mod effect;
pub mod failure;
pub mod fold;
pub mod log;
pub mod platform;
pub mod schedule;
pub mod state;
