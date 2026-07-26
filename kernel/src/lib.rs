#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

//! Pure kernel crate with no domain vocabulary.

pub mod boundary;
pub mod generated;

pub mod effect;
pub mod platform;
