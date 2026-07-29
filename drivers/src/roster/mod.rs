use std::collections::BTreeMap;

use kernel::{
    boundary::Rejection,
    failure::{Failure, HardBoundary},
};
use kernel_macros::acceptance_boundary;

use crate::roles::kdl::{blocks, boundary_runtime, one, values};

pub const ROSTER_KDL: &str = include_str!("../../../data/roster.kdl");
pub const CONCURRENCY_KDL: &str = include_str!("../../../data/concurrency.kdl");
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

/// Maximum concurrent child agents permitted against one upstream capacity
/// pool, keyed by provider+model.
///
/// Capacity belongs to the provider's model pool, not to a roster slot: one
/// model is routinely shared by several slots, so a per-slot limit would split
/// a single quota into independent budgets that can still overrun it together.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelConcurrency {
    pub provider: String,
    pub model: String,
    pub max: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Roster {
    slots: BTreeMap<String, Slot>,
    concurrency: BTreeMap<(String, String), usize>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RosterError {
    Malformed(String),
    Missing(String),
    Duplicate(String),
    MissingConcurrency { provider: String, model: String },
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
                roles: values(&block.fields, "roles"),
            };
            if slots.insert(block.id.clone(), slot).is_some() {
                return Err(RosterError::Duplicate(block.id));
            }
        }
        if slots.is_empty() {
            return Err(RosterError::Missing("slots".to_owned()));
        }

        let mut concurrency = BTreeMap::new();
        for block in blocks(CONCURRENCY_KDL, "pool").map_err(RosterError::Malformed)? {
            let provider = one(&block.fields, "provider").map_err(RosterError::Malformed)?;
            let model = one(&block.fields, "model").map_err(RosterError::Malformed)?;
            let raw = one(&block.fields, "max").map_err(RosterError::Malformed)?;
            let max = raw.parse::<usize>().map_err(|_| {
                RosterError::Malformed(format!("concurrency max not a number: {raw}"))
            })?;
            if max == 0 {
                return Err(RosterError::Malformed(format!(
                    "zero concurrency for {provider}/{model}"
                )));
            }
            if concurrency.insert((provider, model), max).is_some() {
                return Err(RosterError::Duplicate("concurrency".to_owned()));
            }
        }

        // Every rostered model must declare its capacity. Defaulting an unknown
        // model to an arbitrary width is how an unbounded launch wave reaches
        // the provider and is refused with zero tokens billed.
        for slot in slots.values() {
            if !concurrency.contains_key(&(slot.provider.clone(), slot.model.clone())) {
                return Err(RosterError::MissingConcurrency {
                    provider: slot.provider.clone(),
                    model: slot.model.clone(),
                });
            }
        }

        Ok(Self { slots, concurrency })
    }

    /// Concurrency ceiling for one provider+model pool.
    pub fn concurrency_for(&self, provider: &str, model: &str) -> Result<usize, RosterError> {
        self.concurrency
            .get(&(provider.to_owned(), model.to_owned()))
            .copied()
            .ok_or_else(|| RosterError::MissingConcurrency {
                provider: provider.to_owned(),
                model: model.to_owned(),
            })
    }

    /// Concurrency ceiling for the pool that serves `role`.
    pub fn concurrency_for_role(&self, role: &str) -> Result<usize, RosterError> {
        let slot = self
            .slots
            .values()
            .find(|slot| slot.roles.iter().any(|item| item == role))
            .ok_or_else(|| RosterError::Missing(format!("role {role}")))?;
        self.concurrency_for(&slot.provider, &slot.model)
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
        boundary_runtime(BOUNDARY_ID).reject(format!(
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
