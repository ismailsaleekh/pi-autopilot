//! Evidence independence/conflict folding lives here, not in `drivers::conflict`.
//!
//! Source merge conflict checks must not be reused as evidence-reviewer/session
//! independence authority. The v1 ingress fold consumes only accepted evidence
//! receipt refs and authoritative evidence events.
