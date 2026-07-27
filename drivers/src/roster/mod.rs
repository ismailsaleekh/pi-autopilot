use std::collections::BTreeMap;

use kernel::{
    boundary::{BoundaryRuntime, Rejection, boundary_by_id},
    failure::{Failure, HardBoundary},
};
use kernel_macros::acceptance_boundary;

use crate::roles::kdl::{blocks, one};

pub const ROSTER_KDL: &str = include_str!("../../../data/roster.kdl");
const BOUNDARY_ID: &str = "route.metered-frontier.v1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Slot {
    pub name: String,
    pub provider: String,
    pub model: String,
    pub thinking: String,
    pub route: String,
    pub roles: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Route {
    pub provider: String,
    pub model: String,
    pub thinking: String,
    pub subscription: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Roster {
    slots: BTreeMap<String, Slot>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RosterError {
    Malformed(String),
    Missing(String),
    Duplicate(String),
}

impl Roster {
    pub fn package() -> Result<Self, RosterError> {
        Self::parse(ROSTER_KDL)
    }

    pub fn parse(text: &str) -> Result<Self, RosterError> {
        let mut slots = BTreeMap::new();
        for block in blocks(text, "slot").map_err(RosterError::Malformed)? {
            let slot = Slot {
                name: block.id.clone(),
                provider: one(&block.fields, "provider").map_err(RosterError::Malformed)?,
                model: one(&block.fields, "model").map_err(RosterError::Malformed)?,
                thinking: one(&block.fields, "thinking").map_err(RosterError::Malformed)?,
                route: one(&block.fields, "route").map_err(RosterError::Malformed)?,
                roles: match block.fields.get("roles") {
                    Some(roles) => roles.clone(),
                    None => Vec::new(),
                },
            };
            if slots.insert(block.id.clone(), slot).is_some() {
                return Err(RosterError::Duplicate(block.id));
            }
        }
        if slots.is_empty() {
            return Err(RosterError::Missing("slots".to_owned()));
        }
        Ok(Self { slots })
    }

    pub fn get(&self, slot: &str) -> Result<&Slot, RosterError> {
        self.slots
            .get(slot)
            .ok_or_else(|| RosterError::Missing(slot.to_owned()))
    }

    pub fn slots(&self) -> impl Iterator<Item = &Slot> {
        self.slots.values()
    }
}

impl Slot {
    pub fn route(&self) -> Route {
        Route {
            provider: self.provider.clone(),
            model: self.model.clone(),
            thinking: self.thinking.clone(),
            subscription: self.route == "subscription",
        }
    }
}

pub fn guard_route(route: &Route) -> Result<Route, Failure> {
    admit_route(route.clone()).map_err(|_rejection| Failure::Unsafe {
        boundary: HardBoundary::MeteredFrontierRoute,
    })
}

#[acceptance_boundary(
    id = "route.metered-frontier.v1",
    producer = Producer::Package,
    visible = true,
    admits = "Only openai-codex subscription/OAuth routes with the exact roster provider, model, and thinking may cross before spend. API-keyed/OpenRouter or other metered frontier routes are Unsafe(MeteredFrontierRoute).",
    mode = BoundaryMode::Enforce
)]
pub fn admit_route(route: Route) -> Result<Route, Rejection> {
    if !route.subscription || route.provider != "openai-codex" || !roster_contains(&route) {
        runtime().reject(format!(
            "unsafe-route:{}/{}:{}",
            route.provider, route.model, route.thinking
        ))?;
    }
    Ok(route)
}

fn roster_contains(route: &Route) -> bool {
    match Roster::package() {
        Ok(roster) => roster.slots().any(|slot| {
            slot.provider == route.provider
                && slot.model == route.model
                && slot.thinking == route.thinking
                && slot.route == "subscription"
        }),
        Err(_) => false,
    }
}

fn runtime() -> BoundaryRuntime {
    match boundary_by_id(BOUNDARY_ID).and_then(|descriptor| BoundaryRuntime::new(descriptor).ok()) {
        Some(value) => value,
        // Invariant: the acceptance_boundary attribute on admit_route registers this id in this module.
        None => unreachable!("route boundary is registered by acceptance_boundary macro"),
    }
}
