use kernel::effect::Effect;
use kernel::failure::{Failure, OperatorDecision};
use kernel::generated::{EventRow, Id};
use kernel::log::CacheImage;
use kernel::platform::{CacheRead, Clock, Entropy, Platform, Store, Timestamp};

const STEP: u64 = 0x9e37_79b9_7f4a_7c15;

#[derive(Debug)]
pub struct SimPlatform {
    clock: SimClock,
    entropy: SimEntropy,
    store: SimStore,
    vcs: SimVcs,
    process: SimProcess,
    effects: Vec<Effect>,
}

impl SimPlatform {
    pub fn new(seed: u64) -> Self {
        Self {
            clock: SimClock::new(),
            entropy: SimEntropy::new(seed),
            store: SimStore::new(),
            vcs: SimVcs::new(),
            process: SimProcess::new(),
            effects: Vec::new(),
        }
    }

    pub fn advance(&mut self, ticks: u64) {
        self.clock.advance(ticks);
    }

    pub fn apply(&mut self, effect: Effect) {
        match &effect {
            Effect::LaunchBackground(_) => self.process.record(effect.clone()),
            Effect::ReconcileBackground(_) => self.process.record(effect.clone()),
            Effect::ReadFailureLog(_) => self.store.record(effect.clone()),
            Effect::StopBackground(_) => self.process.record(effect.clone()),
            Effect::RequestOperator(_) => self.process.record(effect.clone()),
            Effect::ReturnIdle => self.process.record(effect.clone()),
        }
        self.effects.push(effect);
    }

    pub fn effects(&self) -> &[Effect] {
        &self.effects
    }

    pub fn store_requests(&self) -> &[Effect] {
        self.store.requests()
    }

    pub fn vcs_requests(&self) -> &[Effect] {
        self.vcs.requests()
    }

    pub fn process_requests(&self) -> &[Effect] {
        self.process.requests()
    }
}

impl Platform for SimPlatform {
    fn clock(&self) -> &dyn Clock {
        &self.clock
    }

    fn entropy(&mut self) -> &mut dyn Entropy {
        &mut self.entropy
    }

    fn store(&mut self) -> &mut dyn Store {
        &mut self.store
    }
}

#[derive(Debug)]
pub struct SimClock {
    value: Timestamp,
}

impl SimClock {
    fn new() -> Self {
        Self {
            value: Timestamp(0),
        }
    }

    fn advance(&mut self, ticks: u64) {
        self.value = Timestamp(self.value.0.wrapping_add(ticks));
    }
}

impl Clock for SimClock {
    fn read(&self) -> Timestamp {
        self.value
    }
}

#[derive(Debug)]
pub struct SimEntropy {
    value: u64,
}

impl SimEntropy {
    fn new(seed: u64) -> Self {
        Self { value: seed }
    }
}

impl Entropy for SimEntropy {
    fn next(&mut self) -> u64 {
        self.value = self.value.wrapping_add(STEP);
        let mut mixed = self.value;
        mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        mixed ^ (mixed >> 31)
    }
}

#[derive(Debug)]
pub struct SimStore {
    requests: Vec<Effect>,
}

impl SimStore {
    fn new() -> Self {
        Self {
            requests: Vec::new(),
        }
    }

    fn record(&mut self, effect: Effect) {
        self.requests.push(effect);
    }

    fn requests(&self) -> &[Effect] {
        &self.requests
    }
}

impl Store for SimStore {
    fn append_event(&mut self, row: &EventRow) -> Result<(), Failure> {
        self.record(Effect::ReadFailureLog(Id(row.sequence.to_string())));
        Ok(())
    }

    fn write_cache(&mut self, image: &CacheImage) -> Result<(), Failure> {
        self.record(Effect::ReadFailureLog(Id(image.cache.sequence.to_string())));
        Ok(())
    }

    fn read_events(&self) -> Result<Vec<EventRow>, Failure> {
        Err(Failure::Paused {
            needs: OperatorDecision::SupplyCapability,
        })
    }

    fn read_cache(&self) -> Result<CacheRead, Failure> {
        Err(Failure::Paused {
            needs: OperatorDecision::SupplyCapability,
        })
    }
}

#[derive(Debug)]
pub struct SimVcs {
    requests: Vec<Effect>,
}

impl SimVcs {
    fn new() -> Self {
        Self {
            requests: Vec::new(),
        }
    }

    fn requests(&self) -> &[Effect] {
        &self.requests
    }
}

#[derive(Debug)]
pub struct SimProcess {
    requests: Vec<Effect>,
}

impl SimProcess {
    fn new() -> Self {
        Self {
            requests: Vec::new(),
        }
    }

    fn record(&mut self, effect: Effect) {
        self.requests.push(effect);
    }

    fn requests(&self) -> &[Effect] {
        &self.requests
    }
}
