pub trait Platform {
    fn clock(&self) -> &dyn Clock;
    fn entropy(&mut self) -> &mut dyn Entropy;
    fn store(&mut self) -> &mut dyn Store;
    fn vcs(&mut self) -> &mut dyn Vcs;
    fn process(&mut self) -> &mut dyn Process;
}

pub trait Clock {
    fn read(&self) -> Timestamp;
}

pub trait Entropy {
    fn next(&mut self) -> u64;
}

pub trait Store {}

pub trait Vcs {}

pub trait Process {}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Timestamp(pub u64);
