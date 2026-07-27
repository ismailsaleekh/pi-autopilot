use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
};

use kernel::platform::Entropy;

#[derive(Debug)]
pub struct SystemEntropy {
    seed: RandomState,
    count: u64,
}

impl SystemEntropy {
    pub fn new() -> Self {
        Self {
            seed: RandomState::new(),
            count: 0,
        }
    }
}

impl Default for SystemEntropy {
    fn default() -> Self {
        Self::new()
    }
}

impl Entropy for SystemEntropy {
    fn next(&mut self) -> u64 {
        self.count = self.count.wrapping_add(1);
        let mut hasher = self.seed.build_hasher();
        hasher.write_u64(self.count);
        hasher.finish()
    }
}
